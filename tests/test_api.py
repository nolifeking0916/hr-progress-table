#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端 API 契约测试（Python 标准库 unittest，零第三方依赖）。

跑法：

    cd /Users/leto/Documents/hr-progress-table
    HPS_SHEET_ADAPTER=mock python3 -m unittest discover -s tests -v
    # 或
    python3 tests/test_api.py

**铁律**：测试只用 mock / file 适配器，**永远不碰真实企微源表**。
测试进程会起一个自己的服务实例（独立端口 + 独立 SQLite 库），
结束后关掉；mock 表在测试前后会被备份还原。

覆盖（对齐 docs/API契约.md）：
  * 静态页 + 404 JSON
  * 未登录只读 / /api/session
  * 登录 + cookie + 角色 + 可写事项数
  * 权限判定（editor 不拥有 → 403；拥有 → 200；admin 任意 → 200）
  * 数据范围过滤（all / modules / self）**服务端**生效
  * 写进展：校验、幂等、冲突、append 到 mock 表、/api/data 回读
  * 建任务：重名 409 / coord 422 / 合法 200 + N 行
  * 作废：作者 24h 内可作废 → 软删 + 【作废】标记行
  * 面板四个区块 + KPI 口径
  * 队列（admin）+ 重放
  * file 适配器写操作 501
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server.py")
MOCK_SHEET = os.path.join(ROOT, "data", "mock_sheet.json")

ROW_KEYS = [
    "事项序号",
    "一级维度（六大模块）",
    "二级维度（人/流程/成本）",
    "具体事项",
    "分项",
    "分项内容简介",
    "进展日期",
    "进展内容",
    "开始时间",
    "完成时间",
    "当日计划（周计划）",
    "责任人",
    "负责人",
    "负责人类型",
    "协调事项",
]


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class ServerProcess(object):
    """起一个 server.py 子进程，等它就绪。"""

    def __init__(self, adapter="mock", extra_env=None, db_path=None):
        self.adapter = adapter
        self.extra_env = extra_env or {}
        self.db_path = db_path
        self.port = free_port()
        self.proc = None

    def start(self):
        env = dict(os.environ)
        env["HPS_SHEET_ADAPTER"] = self.adapter
        env["PORT"] = str(self.port)
        env["HPS_HOST"] = "127.0.0.1"
        env["HPS_SECRET"] = "test-secret-do-not-use-in-prod"
        env["HPS_CACHE_TTL"] = "1"
        if self.db_path:
            env["HPS_DB_PATH"] = self.db_path
        env.update(self.extra_env)
        self.proc = subprocess.Popen(
            [sys.executable, SERVER],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = self.proc.stdout.read().decode("utf-8", "replace")
                raise RuntimeError("服务启动失败：\n%s" % out)
            try:
                self.request("GET", "/api/session")
                return self
            except Exception:
                time.sleep(0.15)
        raise RuntimeError("服务 30 秒内没就绪")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.proc and self.proc.stdout:
            try:
                self.proc.stdout.close()
            except OSError:
                pass

    # -- HTTP -------------------------------------------------------------
    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def request(self, method, path, body=None, cookie=None):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        req = urllib.request.Request(self.url(path), data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, _maybe_json(raw), resp.headers
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            return exc.code, _maybe_json(raw), exc.headers

    def get(self, path, cookie=None):
        return self.request("GET", path, None, cookie)

    def post(self, path, body, cookie=None):
        return self.request("POST", path, body, cookie)

    def login(self, name):
        status, payload, headers = self.post("/api/login", {"name": name})
        assert status == 200, (status, payload)
        raw = headers.get("Set-Cookie", "")
        return raw.split(";")[0], payload["me"]


def _maybe_json(raw):
    try:
        return json.loads(raw)
    except ValueError:
        return raw


class MockSheetTestCase(unittest.TestCase):
    """所有测试共用的基类：起 mock 服务、备份 mock 表。"""

    adapter = "mock"

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="hps-test-")
        cls.db_path = os.path.join(cls.tmpdir, "app.db")
        cls.server = ServerProcess(
            adapter=cls.adapter, db_path=cls.db_path
        ).start()
        cls._mock_backup = None
        if os.path.exists(MOCK_SHEET):
            with open(MOCK_SHEET, "rb") as fh:
                cls._mock_backup = fh.read()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)
        if cls._mock_backup is not None:
            with open(MOCK_SHEET, "wb") as fh:
                fh.write(cls._mock_backup)
        elif os.path.exists(MOCK_SHEET):
            os.remove(MOCK_SHEET)

    def setUp(self):
        # 每个用例从干净状态开始：mock 表清空 + 审计/作废/队列清空
        if os.path.exists(MOCK_SHEET):
            os.remove(MOCK_SHEET)
        self.server.stop()
        self.server.start()
        import sqlite3

        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM voided")
        conn.execute("DELETE FROM audit")
        conn.execute("DELETE FROM queue")
        conn.commit()
        conn.close()

    def tearDown(self):
        self.server.stop()


# ---------------------------------------------------------------------------
# 1. 静态页 + 基础
# ---------------------------------------------------------------------------


class TestStaticAndSession(MockSheetTestCase):
    def test_static_files_served(self):
        for path in ("/", "/index.html", "/styles.css", "/app.js", "/data/rows.js"):
            status, _, _ = self.server.get(path)
            self.assertEqual(status, 200, path)

    def test_unknown_path_returns_json_404(self):
        status, payload, _ = self.server.get("/definitely-not-here")
        self.assertEqual(status, 404)
        self.assertEqual(payload.get("error"), "not_found")

    def test_wecom_oauth_is_not_faked(self):
        """契约 §2：企微 OAuth 是预留位，未实现就 501，不能伪造成功。"""
        for path in ("/api/login/wecom", "/api/oauth/wecom"):
            status, payload, _ = self.server.post(path, {"code": "xxx"})
            self.assertEqual(status, 501, path)
            self.assertEqual(payload.get("error"), "wecom_oauth_not_enabled")

    def test_session_unauthenticated_is_readonly(self):
        status, payload, _ = self.server.get("/api/session")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["me"])
        self.assertEqual(payload["capabilities"], {"write": False, "createTask": False, "admin": False})
        self.assertEqual(payload["adapter"], "mock")
        self.assertEqual(len(payload["members"]), 12)

    def test_unauthenticated_write_is_401(self):
        status, payload, _ = self.server.post(
            "/api/progress",
            {"item": "销售提点", "sub": "茅森提点", "date": "2026-10-23", "progress": "x"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(payload.get("error"), "unauthenticated")


# ---------------------------------------------------------------------------
# 2. 数据
# ---------------------------------------------------------------------------


class TestData(MockSheetTestCase):
    def test_data_shape(self):
        status, payload, _ = self.server.get("/api/data")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["rows"]), 167)
        self.assertEqual(len(payload["items"]), 43)
        self.assertEqual(payload["visibleCount"], 43)
        self.assertEqual(payload["pending"], {"待核": 5, "待补": 1})
        self.assertEqual(payload["dataStamp"], "2026-10-24")
        for row in payload["rows"]:
            for key in ROW_KEYS:
                self.assertIn(key, row)

    def test_data_stamp_is_not_max_progress_date(self):
        """数据截至 = 有进展的行里的最大日期；max(进展日期) 是 2026-11-04 的未来计划。"""
        _, payload, _ = self.server.get("/api/data")
        max_date = max(r["进展日期"] for r in payload["rows"] if r["进展日期"])
        self.assertEqual(max_date, "2026-11-04")
        self.assertEqual(payload["dataStamp"], "2026-10-24")

    def test_items_indexed_by_name_not_seq(self):
        """事项序号撞号（13 / 20 各两次）→ 必须按事项名索引，43 个事项都在。"""
        _, payload, _ = self.server.get("/api/data")
        names = [i["item"] for i in payload["items"]]
        self.assertEqual(len(names), 43)
        self.assertEqual(len(set(names)), 43)

    def test_scope_self_filters_server_side(self):
        """scope=self 的用户拿不到别人的行（服务端过滤，不是前端隐藏）。"""
        import sqlite3

        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE members SET scope='self' WHERE name='汪洋'")
        conn.commit()
        conn.close()
        cookie, _ = self.server.login("汪洋")
        _, payload, _ = self.server.get("/api/data", cookie)
        self.assertEqual(payload["visibleCount"], 17)
        owners = set()
        for item in payload["items"]:
            owners.update(item["ownerNames"])
            if item["lead"]:
                owners.add(item["lead"])
        self.assertIn("汪洋", owners)
        for item in payload["items"]:
            self.assertTrue(
                "汪洋" in item["ownerNames"] or item["lead"] == "汪洋",
                item["item"],
            )

    def test_scope_modules_filters_server_side(self):
        import sqlite3

        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE members SET scope='modules', modules='薪酬福利' WHERE name='汪洋'")
        conn.commit()
        conn.close()
        cookie, _ = self.server.login("汪洋")
        _, payload, _ = self.server.get("/api/data", cookie)
        self.assertEqual(payload["visibleCount"], 7)
        for item in payload["items"]:
            self.assertEqual(item["module"], "薪酬福利")


# ---------------------------------------------------------------------------
# 3. 登录与权限
# ---------------------------------------------------------------------------


class TestLoginAndPermissions(MockSheetTestCase):
    def test_login_unknown_member(self):
        status, payload, _ = self.server.post("/api/login", {"name": "查无此人"})
        self.assertEqual(status, 404)
        self.assertEqual(payload.get("error"), "unknown_member")

    def test_login_sets_httponly_cookie(self):
        status, payload, headers = self.server.post("/api/login", {"name": "汪洋"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        cookie_header = headers.get("Set-Cookie", "")
        self.assertIn("hpsid=", cookie_header)
        self.assertIn("HttpOnly", cookie_header)
        self.assertIn("SameSite=Lax", cookie_header)

    def test_session_after_login(self):
        cookie, me = self.server.login("汪洋")
        self.assertEqual(me["role"], "editor")
        self.assertGreater(me["canWriteCount"], 0)
        status, payload, _ = self.server.get("/api/session", cookie)
        self.assertEqual(status, 200)
        self.assertEqual(payload["me"]["name"], "汪洋")
        self.assertEqual(payload["me"]["role"], "editor")
        self.assertEqual(payload["me"]["canWriteCount"], 17)

    def test_admin_can_write_everything(self):
        cookie, me = self.server.login("陈信克")
        self.assertEqual(me["role"], "admin")
        self.assertEqual(me["canWriteCount"], 43)

    def test_editor_cannot_write_other_peoples_item(self):
        """汪洋不是「销售提点」的责任人（黄法）也不是负责人（陈信克）→ 403。"""
        cookie, _ = self.server.login("汪洋")
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "销售提点",
                "sub": "茅森提点",
                "date": "2026-10-23",
                "progress": "越权写入测试",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("error"), "no_write_permission")

    def test_editor_can_write_own_item(self):
        """汪洋负责「候选人分析前置」→ 200，且真的 append 进 mock 表。"""
        cookie, _ = self.server.login("汪洋")
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "权限自测写入",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["appended"])

    def test_admin_can_write_any_item(self):
        cookie, _ = self.server.login("陈信克")
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "销售提点",
                "sub": "茅森提点",
                "date": "2026-10-23",
                "progress": "admin 代填",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 200, payload)

    def test_non_person_owner_only_lead_or_admin_can_write(self):
        """「各机构人力负责人」匹配不到自然人 → 该事项只有负责人/管理员能写。"""
        _, payload, _ = self.server.get("/api/data")
        item = next(i for i in payload["items"] if i["owner"] == "各机构人力负责人\n汪洋")
        self.assertIn("各机构人力负责人", item["ownerNames"])
        # 汪洋是该事项的**共同责任人**（owner 里显式带了他的名字），所以他能写
        cookie, _ = self.server.login("汪洋")
        status, _, _ = self.server.post(
            "/api/progress",
            {
                "item": item["item"],
                "sub": item["subs"][0],
                "date": "2026-10-23",
                "progress": "共同责任人写入",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 200)


# ---------------------------------------------------------------------------
# 4. 写进展
# ---------------------------------------------------------------------------


class TestProgressWrite(MockSheetTestCase):
    def login_wang(self):
        return self.server.login("汪洋")[0]

    def test_append_lands_in_mock_sheet_with_15_columns(self):
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "写进 mock 表的一行",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 200, payload)
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(list(row.keys()), ROW_KEYS)
        self.assertEqual(row["具体事项"], "候选人分析前置")
        self.assertEqual(row["进展内容"], "写进 mock 表的一行")
        self.assertEqual(row["进展日期"], "2026-10-23")
        self.assertEqual(row["责任人"], "汪洋")
        self.assertEqual(row["负责人"], "陈信克")

    def test_data_reflects_appended_row(self):
        cookie = self.login_wang()
        self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "回读可见",
                "plan": "",
            },
            cookie,
        )
        _, payload, _ = self.server.get("/api/data")
        self.assertEqual(len(payload["rows"]), 168)
        self.assertTrue(
            any(r["进展内容"] == "回读可见" for r in payload["rows"]),
            "追加的行应该在 /api/data 里能读到",
        )

    def test_idempotent_duplicate(self):
        cookie = self.login_wang()
        body = {
            "item": "候选人分析前置",
            "sub": "候选人分析前置",
            "date": "2026-10-23",
            "progress": "同一条写两次",
            "plan": "",
        }
        status, payload, _ = self.server.post("/api/progress", body, cookie)
        self.assertEqual(status, 200)
        self.assertTrue(payload["appended"])
        status, payload, _ = self.server.post("/api/progress", body, cookie)
        self.assertEqual(status, 200)
        self.assertFalse(payload["appended"])
        self.assertTrue(payload["duplicate"])
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            self.assertEqual(len(json.load(fh)), 1)

    def test_conflict_when_slot_taken_by_someone_else(self):
        """同一 (事项, 分项, 日期) 已有别人的进展行 → 409 conflict + existing。"""
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "销售提点",
                "sub": "茅森提点",
                "date": "2026-10-10",     # 源表里这一天已经有一行别人的进展
                "progress": "撞车了",
                "plan": "",
            },
            cookie,
        )
        # 汪洋对销售提点没有写权限 → 先撞权限（403），不是 409
        self.assertEqual(status, 403)
        # 换成有权限的人（黄法）就撞冲突
        cookie = self.server.login("黄法")[0]
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "销售提点",
                "sub": "茅森提点",
                "date": "2026-10-10",
                "progress": "撞车了",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 409, payload)
        self.assertEqual(payload.get("error"), "conflict")
        self.assertIn("existing", payload)

    def test_same_author_can_append_again_to_own_slot(self):
        """自己写过的 (事项, 分项, 日期) 不算冲突——源表只能 append，允许再记一条。"""
        cookie = self.login_wang()
        body = {
            "item": "候选人分析前置",
            "sub": "候选人分析前置",
            "date": "2026-10-23",
            "progress": "同一天再记一条",
            "plan": "",
        }
        status, payload, _ = self.server.post("/api/progress", body, cookie)
        self.assertEqual(status, 200, payload)
        body["progress"] = "同一天的补充说明"
        status, payload, _ = self.server.post("/api/progress", body, cookie)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["appended"])
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            self.assertEqual(len(json.load(fh)), 2)

    def test_date_out_of_window(self):
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2020-01-01",
                "progress": "太早了",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "date_out_of_window")

    def test_future_date_rejected(self):
        cookie = self.login_wang()
        tomorrow = time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400))
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": tomorrow,
                "progress": "未来日期",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "date_out_of_window")

    def test_progress_and_plan_cannot_both_be_empty(self):
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "empty_progress")

    def test_sub_must_belong_to_item(self):
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "不存在的分项",
                "date": "2026-10-23",
                "progress": "x",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "unknown_sub")

    def test_unknown_item(self):
        cookie = self.login_wang()
        status, payload, _ = self.server.post(
            "/api/progress",
            {"item": "不存在的事项", "date": "2026-10-23", "progress": "x"},
            cookie,
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload.get("error"), "unknown_item")


# ---------------------------------------------------------------------------
# 5. 建任务
# ---------------------------------------------------------------------------


class TestCreateTask(MockSheetTestCase):
    def valid_payload(self, **over):
        payload = {
            "module": "招聘与配置",
            "nature": "人",
            "item": "自测新事项",
            "subs": [{"name": "分项一", "intro": "一句话说明"}],
            "start": "2026-10-24",
            "end": "2026-11-05",
            "owner": ["汪洋"],
            "lead": "陈信克",
            "leadType": "B",
            "coord": "",
            "note": "仅 admin 可见的备注",
        }
        payload.update(over)
        return payload

    def test_duplicate_item_name_409(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(item="销售提点"), cookie
        )
        self.assertEqual(status, 409, payload)
        self.assertEqual(payload.get("error"), "duplicate_item")

    def test_coord_not_open_422(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(coord="随便写点什么"), cookie
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "coord_not_open")

    def test_valid_task_appends_one_row_per_sub(self):
        cookie = self.server.login("汪洋")[0]
        payload = self.valid_payload(
            subs=[{"name": "分项一", "intro": "甲"}, {"name": "分项二", "intro": "乙"}]
        )
        status, resp, _ = self.server.post("/api/tasks", payload, cookie)
        self.assertEqual(status, 200, resp)
        self.assertEqual(resp["appendedRows"], 2)
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(list(row.keys()), ROW_KEYS)
            self.assertEqual(row["事项序号"], "")        # 新任务不给号
            self.assertEqual(row["进展内容"], "（待补）")
            self.assertEqual(row["进展日期"], "2026-10-24")
            self.assertEqual(row["具体事项"], "自测新事项")
            self.assertEqual(row["负责人类型"], "B")
            self.assertEqual(row["协调事项"], "")
        self.assertEqual(sorted(r["分项"] for r in rows), ["分项一", "分项二"])

    def test_note_only_goes_to_audit_not_sheet(self):
        cookie = self.server.login("汪洋")[0]
        self.server.post("/api/tasks", self.valid_payload(note="备注不进源表"), cookie)
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        self.assertNotIn("备注不进源表", json.dumps(rows, ensure_ascii=False))

    def test_editor_module_restriction(self):
        """汪洋的责任人模块 = 人力资源规划/培训与开发/待定位/招聘与配置；薪酬福利 → 403。"""
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks",
            self.valid_payload(module="薪酬福利", nature="成本", item="越权模块的新事项"),
            cookie,
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("error"), "module_not_allowed")

    def test_invalid_lead_type(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(leadType="X"), cookie
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "invalid_lead_type")

    def test_invalid_module_and_nature(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(module="不存在模块"), cookie
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "invalid_module")
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(nature="别的性质"), cookie
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "invalid_nature")

    def test_end_before_start(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks", self.valid_payload(start="2026-11-05", end="2026-10-24"), cookie
        )
        self.assertEqual(status, 422)
        self.assertEqual(payload.get("error"), "invalid_date_range")

    def test_viewer_cannot_create_task(self):
        import sqlite3

        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE members SET role='viewer' WHERE name='李雪'")
        conn.commit()
        conn.close()
        cookie = self.server.login("李雪")[0]
        status, payload, _ = self.server.post("/api/tasks", self.valid_payload(), cookie)
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("error"), "no_write_permission")


# ---------------------------------------------------------------------------
# 6. 作废
# ---------------------------------------------------------------------------


class TestVoid(MockSheetTestCase):
    def test_author_can_void_own_progress_within_24h(self):
        cookie = self.server.login("汪洋")[0]
        self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "写错了，要作废",
                "plan": "",
            },
            cookie,
        )
        status, payload, _ = self.server.post(
            "/api/void",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "reason": "填错了",
            },
            cookie,
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[1]["进展内容"].startswith("【作废】"))

    def test_voided_row_is_marked_and_excluded_from_panel(self):
        """软删：被作废的行在 /api/data 里带 __voided，并且不再计入面板口径。"""
        cookie = self.server.login("汪洋")[0]
        self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "先写一条",
                "plan": "",
            },
            cookie,
        )
        _, panel_before, _ = self.server.get("/api/panel")
        self.assertEqual(panel_before["kpi"]["weekActivity"]["n"], 21)

        self.server.post(
            "/api/void",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "reason": "作废测试",
            },
            cookie,
        )
        _, data, _ = self.server.get("/api/data")
        voided_rows = [r for r in data["rows"] if r.get("__voided")]
        self.assertEqual(len(voided_rows), 1)
        self.assertEqual(voided_rows[0]["进展内容"], "先写一条")
        _, panel_after, _ = self.server.get("/api/panel")
        self.assertEqual(panel_after["kpi"]["weekActivity"]["n"], 20)

    def test_other_user_cannot_void(self):
        cookie = self.server.login("汪洋")[0]
        self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "汪洋写的",
                "plan": "",
            },
            cookie,
        )
        other = self.server.login("陈信克")[0]
        # admin 能作废；换成另一个 editor 就不能
        cookie2 = self.server.login("汤素琴")[0]
        status, payload, _ = self.server.post(
            "/api/void",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "reason": "不是你写的",
            },
            cookie2,
        )
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("error"), "no_void_permission")

    def test_admin_can_void_any(self):
        admin = self.server.login("陈信克")[0]
        status, payload, _ = self.server.post(
            "/api/void",
            {
                "item": "销售提点",
                "sub": "茅森提点",
                "date": "2026-10-10",
                "reason": "admin 作废",
            },
            admin,
        )
        self.assertEqual(status, 200, payload)


# ---------------------------------------------------------------------------
# 7. 面板
# ---------------------------------------------------------------------------


class TestPanel(MockSheetTestCase):
    def test_panel_blocks_and_kpi(self):
        status, payload, _ = self.server.get("/api/panel")
        self.assertEqual(status, 200)
        for key in ("scope", "kpi", "byModule", "byOwner", "overdue", "weekActivity"):
            self.assertIn(key, payload)
        kpi = payload["kpi"]
        self.assertEqual(kpi["overdue"]["n"], 7)
        self.assertEqual(kpi["overdue"]["worstDays"], 9)
        # 分母是已到期项（15），不是 43
        self.assertEqual(kpi["dueDone"]["due"], 15)
        self.assertEqual(kpi["dueDone"]["done"], 8)
        self.assertEqual(kpi["weekActivity"]["n"], 20)
        self.assertEqual(kpi["weekActivity"]["items"], 15)
        # 7 天无进展：末次非空进展距今 ≥ 7 天（含从未有进展的）
        self.assertEqual(kpi["stale"]["neverUpdated"], 1)
        self.assertEqual(kpi["stale"]["worstDays"], 16)
        self.assertEqual(kpi["stale"]["n"], 12)

    def test_panel_totals_consistent(self):
        _, payload, _ = self.server.get("/api/panel")
        total = sum(m["count"] for m in payload["byModule"])
        self.assertEqual(total, 43)
        done = sum(m["done"] for m in payload["byModule"])
        doing = sum(m["doing"] for m in payload["byModule"])
        overdue = sum(m["overdue"] for m in payload["byModule"])
        self.assertEqual(done, 8)
        self.assertEqual(doing, 28)
        self.assertEqual(overdue, 7)
        self.assertEqual(done + doing + overdue, 43)
        week = sum(m["week"] for m in payload["byModule"])
        self.assertEqual(week, 20)
        owner_total = sum(o["count"] for o in payload["byOwner"])
        # 责任人表按**姓名**计数：多人责任人的事项在每个名字下各算一次
        #（「各机构人力负责人\n汪洋」这一条同时算进汪洋和「各机构人力负责人」），
        # 所以合计是 44 而不是 43 —— 与交互方案 §5.4 的表一致。
        self.assertEqual(owner_total, 44)
        self.assertEqual(len(payload["overdue"]), 7)

    def test_panel_respects_scope(self):
        import sqlite3

        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE members SET scope='self' WHERE name='汪洋'")
        conn.commit()
        conn.close()
        cookie = self.server.login("汪洋")[0]
        _, payload, _ = self.server.get("/api/panel", cookie)
        self.assertEqual(payload["scope"]["count"], 17)
        self.assertEqual(sum(m["count"] for m in payload["byModule"]), 17)

    def test_overdue_entries_shape(self):
        _, payload, _ = self.server.get("/api/panel")
        first = payload["overdue"][0]
        for key in ("item", "owner", "overdueDays", "lastProgress", "canWrite"):
            self.assertIn(key, first)
        self.assertEqual(payload["overdue"][0]["item"], "部门合并落实")
        self.assertEqual(payload["overdue"][0]["overdueDays"], 9)


# ---------------------------------------------------------------------------
# 8. 队列
# ---------------------------------------------------------------------------


class TestQueue(MockSheetTestCase):
    def test_non_admin_cannot_see_queue(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.get("/api/queue", cookie)
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("error"), "admin_only")

    def test_admin_sees_queue(self):
        cookie = self.server.login("陈信克")[0]
        status, payload, _ = self.server.get("/api/queue", cookie)
        self.assertEqual(status, 200)
        self.assertIsInstance(payload, list)

    def test_replay_reports_result(self):
        cookie = self.server.login("陈信克")[0]
        status, payload, _ = self.server.post("/api/queue/replay", {}, cookie)
        self.assertEqual(status, 200)
        self.assertIn("replayed", payload)
        self.assertIn("failed", payload)

    def test_write_failure_queues_and_returns_202(self):
        """写源表失败 → 202 + 进队列（不丢数据），恢复后 admin 重放。"""
        # 把 mock 表路径占成一个目录 → 写必然失败
        if os.path.exists(MOCK_SHEET):
            os.remove(MOCK_SHEET)
        os.makedirs(MOCK_SHEET)
        try:
            cookie = self.server.login("汪洋")[0]
            status, payload, _ = self.server.post(
                "/api/progress",
                {
                    "item": "候选人分析前置",
                    "sub": "候选人分析前置",
                    "date": "2026-10-23",
                    "progress": "写不进去也要留住",
                    "plan": "",
                },
                cookie,
            )
            self.assertEqual(status, 202, payload)
            self.assertFalse(payload["ok"])
            self.assertTrue(payload["queued"])
            self.assertIn("queueId", payload)

            admin = self.server.login("陈信克")[0]
            status, queue, _ = self.server.get("/api/queue", admin)
            self.assertEqual(status, 200)
            self.assertEqual(len(queue), 1)
            self.assertEqual(queue[0]["status"], "pending")
            self.assertEqual(queue[0]["action"], "progress.append")
            self.assertEqual(queue[0]["payload"]["progress"], "写不进去也要留住")
        finally:
            os.rmdir(MOCK_SHEET)

    def test_replay_writes_queued_entry_after_recovery(self):
        """队列里的条目在写通道恢复后能被重放回源表。"""
        if os.path.exists(MOCK_SHEET):
            os.remove(MOCK_SHEET)
        os.makedirs(MOCK_SHEET)
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "排队的一条",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 202, payload)
        os.rmdir(MOCK_SHEET)

        admin = self.server.login("陈信克")[0]
        status, payload, _ = self.server.post("/api/queue/replay", {}, admin)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["replayed"], 1)
        self.assertEqual(payload["failed"], 0)
        with open(MOCK_SHEET, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["进展内容"], "排队的一条")


# ---------------------------------------------------------------------------
# 9. file 适配器（只读）
# ---------------------------------------------------------------------------


class TestFileAdapter(unittest.TestCase):
    """file 适配器：只读，任何写操作 501。**不会碰真表。**"""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="hps-file-")
        cls.server = ServerProcess(
            adapter="file", db_path=os.path.join(cls.tmpdir, "app.db")
        ).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def test_data_available(self):
        status, payload, _ = self.server.get("/api/data")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["rows"]), 167)
        self.assertEqual(payload["pending"], {"待核": 5, "待补": 1})
        self.assertEqual(payload["dataStamp"], "2026-10-24")

    def test_write_returns_501(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/progress",
            {
                "item": "候选人分析前置",
                "sub": "候选人分析前置",
                "date": "2026-10-23",
                "progress": "file 适配器不该写成功",
                "plan": "",
            },
            cookie,
        )
        self.assertEqual(status, 501, payload)
        self.assertEqual(payload.get("error"), "write_not_supported")

    def test_create_task_returns_501(self):
        cookie = self.server.login("汪洋")[0]
        status, payload, _ = self.server.post(
            "/api/tasks",
            {
                "module": "招聘与配置",
                "nature": "人",
                "item": "file 适配器的新任务",
                "subs": [{"name": "分项一", "intro": ""}],
                "start": "2026-10-24",
                "end": "2026-11-05",
                "owner": ["汪洋"],
                "lead": "陈信克",
                "leadType": "B",
                "coord": "",
            },
            cookie,
        )
        self.assertEqual(status, 501, payload)
        self.assertEqual(payload.get("error"), "write_not_supported")


if __name__ == "__main__":
    unittest.main(verbosity=2)
