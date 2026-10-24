#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""集团人力重点工作进度表 · 后端服务（多用户 / 写进度 / 建任务 / 进度面板）

单进程同时伺服 **静态页面** 与 **JSON API**，一个端口：

    python3 server.py                      # http://127.0.0.1:8787
    PORT=9000 python3 server.py
    HPS_SHEET_ADAPTER=file python3 server.py

零第三方依赖，只用 Python 标准库（http.server / sqlite3 / json / hmac / subprocess …）。

设计铁律（对齐 docs/API契约.md）：

* **源表是业务数据的唯一真相源**——企业微信在线表格《集团人力近期重点工作进度表》
  的子表「重点工作进度 v2」。本服务的 SQLite 只存身份 / 映射 / 审计 / 队列，
  **不存业务数据**；任何一次读都回源表，任何一次写都 append 回源表。
* **只 append，不改已有行**（源表是多人共编，改行会覆盖别人的手改）。
* 三个适配器（同一接口 SheetAdapter）：
    - ``cli``  默认：用本机 wecom-cli 读写真表（**读可以，写只在生产用**）
    - ``file`` 只读本地 data/rows_v2.json，写接口一律 501 write_not_supported
    - ``mock`` 读 data/rows_v2.json，追加写本地 data/mock_sheet.json（测试用）
* 写路径永远不碰真表：测试只用 mock 适配器。

作者：后端 agent · 2026-10-24
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# 0. 配置（契约 §0.1）
# ---------------------------------------------------------------------------

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
# HPS_DB_PATH 只给测试用（跑一个隔离的库），生产就是 data/app.db
DB_PATH = os.environ.get("HPS_DB_PATH") or os.path.join(DATA_DIR, "app.db")
ROWS_V2 = os.path.join(DATA_DIR, "rows_v2.json")
TASKS_ONLINE = os.path.join(DATA_DIR, "tasks_online.json")
MOCK_SHEET = os.path.join(DATA_DIR, "mock_sheet.json")

DEFAULT_SECRET = "dev-secret-change-me"
SECRET = os.environ.get("HPS_SECRET", DEFAULT_SECRET)
HOST = os.environ.get("HPS_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
ADAPTER_NAME = (os.environ.get("HPS_SHEET_ADAPTER", "cli") or "cli").strip().lower()
DOCID = os.environ.get("HPS_WECOM_DOCID", "e3_ARsADAagAHQCNea2Y2u1wSA00hrX0")
SHEET_TITLE = os.environ.get("HPS_WECOM_SHEET_TITLE", "重点工作进度 v2")
RAW_SHEET_TITLE = os.environ.get("HPS_WECOM_RAW_SHEET_TITLE", "工作表1")
BACKUP_WINDOW_DAYS = int(os.environ.get("HPS_BACKUP_WINDOW_DAYS", "90"))
SESSION_TTL = int(os.environ.get("HPS_SESSION_TTL", str(12 * 3600)))
CACHE_TTL = float(os.environ.get("HPS_CACHE_TTL", "60"))
CLI_TIMEOUT = int(os.environ.get("HPS_CLI_TIMEOUT", "120"))

COOKIE_NAME = "hpsid"

# ---------------------------------------------------------------------------
# 1. 常量
# ---------------------------------------------------------------------------

# 源表 15 列，顺序不可改（契约 §4）
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
DATE_COLUMNS = ("进展日期", "开始时间", "完成时间")
MODULE_KEY = "一级维度（六大模块）"
NATURE_KEY = "二级维度（人/流程/成本）"
ITEM_KEY = "具体事项"
SUB_KEY = "分项"
INTRO_KEY = "分项内容简介"
PROGRESS_KEY = "进展内容"
PLAN_KEY = "当日计划（周计划）"
DATE_KEY = "进展日期"
START_KEY = "开始时间"
END_KEY = "完成时间"
OWNER_KEY = "责任人"
LEAD_KEY = "负责人"
LEAD_TYPE_KEY = "负责人类型"
COORD_KEY = "协调事项"
SEQ_KEY = "事项序号"

MODULES = ["人力资源规划", "招聘与配置", "培训与开发", "绩效管理", "薪酬福利", "员工关系", "待定位"]
NATURES = ["人", "流程", "成本", "其他"]

NON_PERSON = "各机构人力负责人"          # 非自然人责任人
VOID_PREFIX = "【作废】"                  # 作废标记前缀
TASK_FILLER = "（待补）"                  # 新建任务首行的进展内容
PENDING_CHECK = "待核"
PENDING_FILL = "待补"

# 种子成员（契约 §1）。userid 留空——企微 OAuth 是预留位（契约 §2），
# 权限判定走姓名精确匹配，不依赖 userid。
SEED_MEMBERS = [
    ("陈信克", "admin", "负责人，38 个事项"),
    ("刘玉文", "admin", "负责人，5 个事项"),
    ("汪洋", "editor", "责任人 17 项"),
    ("盛琳莺", "editor", "责任人 16 项"),
    ("倪国楷", "editor", "责任人 3 项"),
    ("黄法", "editor", "责任人 1 项"),
    ("蒋成", "editor", "责任人 1 项"),
    ("李雪", "editor", "责任人 1 项"),
    ("汤素琴", "editor", "责任人 1 项"),
    ("蔡宇翔", "editor", "责任人 1 项"),
    ("朱彦隽", "editor", "责任人 1 项"),
    (NON_PERSON, "editor", "非自然人：匹配不到任何自然人，只能由负责人/admin 代写"),
]

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/app-multi.js": ("app-multi.js", "application/javascript; charset=utf-8"),
    "/data/rows.js": ("data/rows.js", "application/javascript; charset=utf-8"),
}

# ---------------------------------------------------------------------------
# 2. 小工具
# ---------------------------------------------------------------------------


def log(msg):
    sys.stderr.write("[%s] %s\n" % (datetime.datetime.now().strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def today_date():
    return datetime.date.today()


_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")


def parse_date(value):
    """把源表里各种日期表示解析成 date；解析不了返回 None。"""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if isinstance(value, (int, float)):
        try:
            return datetime.datetime.fromtimestamp(float(value)).date()
        except (OverflowError, OSError, ValueError):
            return None
    s = str(value).strip()
    if not s:
        return None
    m = _DATE_RE.match(s)
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"(\d{1,2})\s*[月/-]\s*(\d{1,2})", s)
    if m:
        try:
            return datetime.date(datetime.date.today().year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


def fmt_date(d):
    return d.isoformat() if isinstance(d, datetime.date) else ""


def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def split_names(text):
    """契约 §2.1：责任人字段可能一行多人（换行 / 顿号 / 逗号 / 分号 / 斜杠分隔）。"""
    if not text:
        return []
    return [x.strip() for x in re.split(r"[\n\r、，,;；/]+", str(text)) if x.strip()]


def is_void_text(text):
    return str(text or "").strip().startswith(VOID_PREFIX)


def is_real_progress(text):
    """真实进展 = 非空、不是【作废】标记、不是新建任务的「（待补）」占位。"""
    content = str(text or "").strip()
    if not content:
        return False
    if is_void_text(content):
        return False
    if content == TASK_FILLER:
        return False
    return True


# ---------------------------------------------------------------------------
# 3. 数据库（契约 §1）—— 只存身份 / 映射 / 审计 / 队列
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  userid TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  scope TEXT NOT NULL DEFAULT 'all',
  modules TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS name_map (
  name TEXT PRIMARY KEY,
  member_id INTEGER,
  confidence TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT, actor_userid TEXT,
  action TEXT,
  target TEXT,
  payload TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS voided (
  id INTEGER PRIMARY KEY,
  sheet_key TEXT NOT NULL,
  voided_by TEXT, voided_at TEXT, reason TEXT
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  ts TEXT, actor TEXT, action TEXT, payload TEXT,
  status TEXT,
  last_error TEXT
);
"""


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = db()
    try:
        conn.executescript(SCHEMA)
        now = now_iso()
        for name, role, note in SEED_MEMBERS:
            conn.execute(
                "INSERT OR IGNORE INTO members (name,userid,role,scope,modules,active,created_at)"
                " VALUES (?,?,?,'all',NULL,1,?)",
                (name, "", role, now),
            )
        # name_map 用成员表初始化。各机构人力负责人 是非自然人 → confidence=nonPerson。
        for row in conn.execute("SELECT id,name FROM members").fetchall():
            if row["name"] == NON_PERSON:
                conf, note = "nonPerson", "非自然人：匹配不到任何自然人，只能由负责人/admin 代写"
            else:
                conf, note = "exact", "成员表初始化"
            conn.execute(
                "INSERT OR IGNORE INTO name_map (name,member_id,confidence,note) VALUES (?,?,?,?)",
                (row["name"], row["id"], conf, note),
            )
        conn.commit()
    finally:
        conn.close()


def audit(actor, actor_userid, action, target, payload, result):
    try:
        conn = db()
        try:
            conn.execute(
                "INSERT INTO audit (ts,actor,actor_userid,action,target,payload,result)"
                " VALUES (?,?,?,?,?,?,?)",
                (
                    now_iso(),
                    actor,
                    actor_userid or "",
                    action,
                    target,
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                    result,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:                      # 审计写失败不能拖垮主流程
        log("!! audit 写入失败: %s" % exc)


def member_rows():
    conn = db()
    try:
        return conn.execute(
            "SELECT id,name,userid,role,scope,modules,active FROM members ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


def find_member(name):
    if not name:
        return None
    conn = db()
    try:
        return conn.execute(
            "SELECT id,name,userid,role,scope,modules,active FROM members WHERE name=? AND active=1",
            (name,),
        ).fetchone()
    finally:
        conn.close()


def voided_keys():
    conn = db()
    try:
        return set(r["sheet_key"] for r in conn.execute("SELECT sheet_key FROM voided").fetchall())
    finally:
        conn.close()


def recent_audit_for(actor, action, target):
    """取某人某动作某目标的最近一条审计（用于「作者本人 24h 内可作废」）。"""
    conn = db()
    try:
        return conn.execute(
            "SELECT ts,actor,action,target,payload FROM audit WHERE actor=? AND action=? AND target=?"
            " ORDER BY id DESC LIMIT 1",
            (actor, action, target),
        ).fetchone()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 4. 源表适配器
# ---------------------------------------------------------------------------


class SheetUnavailable(Exception):
    """读源表失败 → 503 sheet_unavailable。"""


class WriteNotSupported(Exception):
    """该适配器不支持写 → 501 write_not_supported。"""


class AppendFailed(Exception):
    """写源表失败 → 进队列，202。"""


class SheetAdapter(object):
    """源表适配器统一接口。"""

    name = "base"
    supports_write = False

    def read(self):
        """返回 {"rows": [15 列 dict...], "raw_items": [源事项 dict...]}"""
        raise NotImplementedError

    def append(self, rows):
        """向源表末尾追加若干行（15 列 dict）。"""
        raise WriteNotSupported("适配器 %s 不支持写入" % self.name)


def normalize_row(raw):
    """把一行源表数据规整成 15 键、日期列 YYYY-MM-DD 的标准形状。"""
    out = {}
    for key in ROW_KEYS:
        value = raw.get(key, "")
        if value is None:
            value = ""
        elif isinstance(value, str):
            value = value.strip()
        out[key] = value
    seq = out[SEQ_KEY]
    if isinstance(seq, str):
        seq = seq.strip()
    if seq not in ("", None):
        try:
            out[SEQ_KEY] = int(float(seq))
        except (TypeError, ValueError):
            out[SEQ_KEY] = seq
    else:
        out[SEQ_KEY] = ""
    for key in DATE_COLUMNS:
        parsed = parse_date(out[key])
        if parsed:
            out[key] = fmt_date(parsed)
        elif out[key] == "":
            out[key] = ""
        else:
            out[key] = str(out[key]).strip()
    return out


class FileSheetAdapter(SheetAdapter):
    """只读本地快照 data/rows_v2.json。写一律 501。"""

    name = "file"
    supports_write = False

    def read(self):
        rows = load_json(ROWS_V2)
        if not isinstance(rows, list):
            raise SheetUnavailable("data/rows_v2.json 不可读或格式不对")
        raw_items = load_json(TASKS_ONLINE) or []
        return {"rows": [normalize_row(r) for r in rows], "raw_items": raw_items}

    def append(self, rows):
        raise WriteNotSupported("file 适配器只读")


class MockSheetAdapter(SheetAdapter):
    """测试适配器：读 data/rows_v2.json，追加写本地 data/mock_sheet.json。绝不碰真表。"""

    name = "mock"
    supports_write = True

    def read(self):
        rows = load_json(ROWS_V2)
        if not isinstance(rows, list):
            raise SheetUnavailable("data/rows_v2.json 不可读或格式不对")
        extra = load_json(MOCK_SHEET) or []
        merged = list(rows) + list(extra)
        raw_items = load_json(TASKS_ONLINE) or []
        return {"rows": [normalize_row(r) for r in merged], "raw_items": raw_items}

    def append(self, rows):
        current = load_json(MOCK_SHEET) or []
        for row in rows:
            current.append({key: row.get(key, "") for key in ROW_KEYS})
        try:
            write_json_atomic(MOCK_SHEET, current)
        except OSError as exc:
            # 写不进去（磁盘满 / 权限 / 路径被占）→ 当成临时失败，进队列重放
            raise AppendFailed("写 mock 表失败：%s" % exc)


class CliSheetAdapter(SheetAdapter):
    """默认适配器：用本机 wecom-cli 读写企业微信在线表格。"""

    name = "cli"
    supports_write = True

    # -- 底层调用 ---------------------------------------------------------
    def _run(self, args, timeout=None):
        cmd = ["wecom-cli"] + list(args)
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout or CLI_TIMEOUT
            )
        except subprocess.TimeoutExpired:
            raise SheetUnavailable("wecom-cli 超时（%s）" % " ".join(args[:3]))
        except OSError as exc:
            raise SheetUnavailable("wecom-cli 不可用：%s" % exc)
        raw = proc.stdout or ""
        idx = raw.find("{")
        if idx < 0:
            raise SheetUnavailable(
                "wecom-cli 无 JSON 输出：%s" % ((proc.stderr or raw).strip()[:200])
            )
        try:
            data = json.loads(raw[idx:])
        except ValueError:
            raise SheetUnavailable("wecom-cli 输出不是合法 JSON")
        if data.get("errcode"):
            raise SheetUnavailable(
                "wecom-cli errcode=%s errmsg=%s" % (data.get("errcode"), data.get("errmsg"))
            )
        return data

    @staticmethod
    def _cell_text(cell):
        value = (cell or {}).get("cell_value") or {}
        if "text" in value:
            return value["text"] or ""
        if "number" in value:
            number = value["number"]
            try:
                return str(int(number)) if float(number).is_integer() else str(number)
            except (TypeError, ValueError):
                return str(number)
        if "time" in value:
            t = value["time"]
            return "%04d-%02d-%02d %02d:%02d:%02d" % (
                t.get("year", 1970),
                t.get("month", 1),
                t.get("day", 1),
                t.get("hour", 0),
                t.get("minute", 0),
                t.get("second", 0),
            )
        return ""

    def _sheets(self):
        data = self._run(["sheet", "get", "--json", json.dumps({"docid": DOCID})])
        return data.get("sheets") or []

    def _sheet_by_title(self, title):
        """**必须按标题定位**，v2 工作表插在第 1 位，不能用 sheets[0]。"""
        for sheet in self._sheets():
            if sheet.get("title") == title:
                return sheet
        return None

    def _read_grid(self, sheet_id, row_count, col_count, chunk=100):
        """读 A1:{col}{row_count}，分块。返回二维字符串数组（跳过全空行）。"""
        last_col = chr(ord("A") + col_count - 1)
        rows = []
        for start in range(0, max(row_count, 1), chunk):
            end = min(start + chunk, max(row_count, 1))
            rng = "A%d:%s%d" % (start + 1, last_col, end)
            data = self._run(
                [
                    "sheet",
                    "ranges",
                    "get",
                    "--docid",
                    DOCID,
                    "--sheet-id",
                    sheet_id,
                    "--range",
                    rng,
                    "--mode",
                    "default",
                ]
            )
            grid = data.get("grid_data") or {}
            for row in grid.get("rows") or []:
                cells = [self._cell_text(c) for c in (row.get("values") or [])]
                cells = (cells + [""] * col_count)[:col_count]
                if any(str(c).strip() for c in cells):
                    rows.append(cells)
        return rows

    # -- 读 ---------------------------------------------------------------
    def _read_raw_items(self):
        """读「工作表1」（短格式原始表）→ 源事项列表。

        「待核 / 待补」判定需要**原始进展文本**（进展原文里有一行没有 MMDD 日期前缀
        → 该行按开始时间落行 → 待核）。长表里已经把日期前缀剥掉了，从长表无法还原，
        所以这里回读原始表；读不到就退回本地快照 data/tasks_online.json。
        """
        sheet = self._sheet_by_title(RAW_SHEET_TITLE)
        if not sheet:
            sheets = self._sheets()
            if sheets:
                sheet = max(sheets, key=lambda s: s.get("column_count", 0) or 0)
        if not sheet:
            return load_json(TASKS_ONLINE) or []
        try:
            grid = self._read_grid(sheet.get("sheet_id"), sheet.get("row_count") or 200, 13)
        except SheetUnavailable:
            return load_json(TASKS_ONLINE) or []
        items = []
        cat = ""
        for line in grid[3:]:                       # 前 3 行是表头 / 说明
            seq, c1, c2, dcol, summary, prog, week, start, end, owner, lead, typ, coord = (
                line + [""] * 13
            )[:13]
            if dcol.strip():
                item, group = dcol.strip(), c2.strip()
            elif c2.strip() and summary.strip():
                item, group = c2.strip(), ""
            else:
                continue
            if c1.strip():
                cat = c1.strip()
            items.append(
                {
                    "seq": seq,
                    "cat": cat,
                    "group": group,
                    "item": item,
                    "summary": summary.strip(),
                    "progress": prog.strip(),
                    "week": week.strip(),
                    "start": start.strip(),
                    "end": end.strip(),
                    "owner": owner.strip(),
                    "lead": lead.strip(),
                    "typ": typ.strip(),
                    "coord": coord.strip(),
                }
            )
        return items or (load_json(TASKS_ONLINE) or [])

    def read(self):
        sheet = self._sheet_by_title(SHEET_TITLE)
        if not sheet:
            raise SheetUnavailable("找不到子表「%s」" % SHEET_TITLE)
        grid = self._read_grid(sheet.get("sheet_id"), sheet.get("row_count") or 200, 15)
        rows = []
        for cells in grid:
            if cells and str(cells[0]).strip() == SEQ_KEY:      # 表头
                continue
            row = normalize_row(dict(zip(ROW_KEYS, cells)))
            if not row[ITEM_KEY]:
                continue
            rows.append(row)
        return {"rows": rows, "raw_items": self._read_raw_items()}

    # -- 写（只在生产用；测试永远不会走到这里） ---------------------------
    def append(self, rows):
        """向子表末尾追加行。

        只用 `sheet cells append`（契约 §4 首选）：它由服务端定位末尾行，
        不会出现「batchset 到 A{lastRow+1}」那种两人同时写互相错位的风险。
        """
        sheet = self._sheet_by_title(SHEET_TITLE)
        if not sheet:
            raise AppendFailed("找不到子表「%s」" % SHEET_TITLE)
        sheet_id = sheet.get("sheet_id")
        for row in rows:
            values = [row.get(key, "") for key in ROW_KEYS]
            payload = {"docid": DOCID, "sheet": sheet_id, "row": values}
            try:
                data = self._run(
                    ["sheet", "cells", "append", "--json", json.dumps(payload, ensure_ascii=False)]
                )
            except SheetUnavailable as exc:
                raise AppendFailed(str(exc))
            if data.get("errcode"):
                raise AppendFailed("errcode=%s errmsg=%s" % (data.get("errcode"), data.get("errmsg")))


ADAPTERS = {
    "cli": CliSheetAdapter,
    "file": FileSheetAdapter,
    "mock": MockSheetAdapter,
}


# ---------------------------------------------------------------------------
# 5. 数据集缓存 + 业务模型
# ---------------------------------------------------------------------------


class DatasetCache(object):
    """源表读缓存：CLI 读一次要几秒，不能每个请求都打一遍。"""

    def __init__(self, adapter):
        self.adapter = adapter
        self._lock = threading.Lock()
        self._data = None
        self._stamp = 0.0

    def get(self, force=False):
        with self._lock:
            fresh = self._data is not None and (time.time() - self._stamp) < CACHE_TTL
            if fresh and not force:
                return self._data
            data = self.adapter.read()
            self._data = data
            self._stamp = time.time()
            return data

    def invalidate(self):
        with self._lock:
            self._stamp = 0.0


def build_items(rows):
    """行 → 事项模型（按事项名聚合，**不按序号**——源表序号撞号）。"""
    order = []
    groups = {}
    for row in rows:
        name = row.get(ITEM_KEY) or ""
        if not name:
            continue
        if name not in groups:
            groups[name] = []
            order.append(name)
        groups[name].append(row)
    items = []
    for name in order:
        group = groups[name]
        first = group[0]
        subs = []
        for row in group:
            sub = row.get(SUB_KEY) or ""
            if sub and sub not in subs:
                subs.append(sub)
        items.append(
            {
                "seq": first.get(SEQ_KEY, ""),
                "item": name,
                "module": first.get(MODULE_KEY, ""),
                "nature": first.get(NATURE_KEY, ""),
                "summary": first.get(INTRO_KEY, ""),
                "start": first.get(START_KEY, ""),
                "end": first.get(END_KEY, ""),
                "owner": first.get(OWNER_KEY, ""),
                "ownerNames": split_names(first.get(OWNER_KEY, "")),
                "lead": first.get(LEAD_KEY, ""),
                "leadType": first.get(LEAD_TYPE_KEY, ""),
                "coord": first.get(COORD_KEY, ""),
                "subs": subs,
                "rowCount": len(group),
            }
        )
    return items, groups


def pending_rows(items, groups, raw_items, voided):
    """待核 / 待补 的行级判定（与 scripts/build_data_js.py 的清洗规则一致）。

    待核：源表进展原文里有一行没有 MMDD 日期前缀 → 该行按开始时间落行。
    待补：进展与计划都为空 → 按开始时间落一行空行（新建任务首行也算）。
    """
    pending_items = set()
    filler_items = set()
    for raw in raw_items or []:
        name = raw.get("item") or raw.get(ITEM_KEY) or ""
        if not name:
            continue
        raw_progress = raw.get("progress") or raw.get(PROGRESS_KEY) or ""
        raw_week = raw.get("week") or raw.get(PLAN_KEY) or ""
        p_lines = [l.strip() for l in str(raw_progress).split("\n") if l.strip()]
        w_lines = [
            l.strip()
            for l in str(raw_week).split("\n")
            if l.strip() and l.strip() not in ("/", "-", "—", "无")
        ]
        if p_lines and any(not l[:4].isdigit() for l in p_lines):
            pending_items.add(name)
        if not p_lines and not w_lines:
            filler_items.add(name)

    flags = {}
    for item in items:
        name = item["item"]
        start = item["start"]
        group = groups.get(name, [])
        has_real = any(is_real_progress(r.get(PROGRESS_KEY)) for r in group)
        for row in group:
            content = (row.get(PROGRESS_KEY) or "").strip()
            plan = (row.get(PLAN_KEY) or "").strip()
            flag = None
            if name in pending_items and row.get(DATE_KEY) == start and content:
                flag = PENDING_CHECK
            elif name in pending_items and row.get(DATE_KEY) == start and not content and plan:
                flag = PENDING_CHECK
            elif name in filler_items and not content and not plan:
                flag = PENDING_FILL
            elif not has_real and not content and not plan:
                # 全程没有真实进展（源表里的空行）→ 待补
                flag = PENDING_FILL
            elif not has_real and content == TASK_FILLER:
                # 新建任务首行的占位进展 → 待补（交互方案 §3.3）
                flag = PENDING_FILL
            if flag:
                flags[(name, row.get(SUB_KEY, ""), row.get(DATE_KEY, ""))] = flag
    return flags, pending_items, filler_items


def field(obj, key, default=None):
    """dict / sqlite3.Row 都能取字段。"""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    try:
        value = obj[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def can_write(item, me):
    """契约 §2.1 的唯一规则。me 为 None → 不可写。"""
    if not me:
        return False
    role = field(me, "role")
    if role == "viewer":
        return False
    if role == "admin":
        return True
    name = field(me, "name")
    owners = item.get("ownerNames") or split_names(item.get(OWNER_KEY, ""))
    if name and name in owners:
        return True
    if name and name == (item.get("lead") or ""):
        return True
    return False


def visible_items(items, me):
    """契约 §2.2：scope 过滤在**服务端**做，前端拿到的行就已经少了。"""
    if not me:
        return list(items)
    scope = field(me, "scope") or "all"
    if scope == "modules":
        allowed = set(m.strip() for m in (field(me, "modules") or "").split(",") if m.strip())
        return [i for i in items if i["module"] in allowed]
    if scope == "self":
        name = field(me, "name")
        return [
            i
            for i in items
            if name in (i.get("ownerNames") or []) or name == (i.get("lead") or "")
        ]
    return list(items)


def week_bounds(today):
    """本周 = 周一至周日（与前端 weekRange() 一致）。"""
    start = today - datetime.timedelta(days=today.weekday())
    return start, start + datetime.timedelta(days=6)


def compute_state(item, group, today, voided):
    """已完成 / 逾期 / 进行中（契约 §3.7）。

    已完成 = 存在一条非空进展，其日期 ≥ 该事项的完成时间
    逾期   = 今天已过完成时间，且不存在上述进展
    进行中 = 其余
    """
    end = parse_date(item.get("end"))
    done = False
    last = None
    for row in group:
        content = (row.get(PROGRESS_KEY) or "").strip()
        if not content or is_void_text(content):
            continue
        key = "%s|%s|%s" % (item["item"], row.get(SUB_KEY, ""), row.get(DATE_KEY, ""))
        if key in voided:
            continue
        progress_date = parse_date(row.get(DATE_KEY))
        if not progress_date:
            continue
        if last is None or progress_date > last:
            last = progress_date
        if end and progress_date >= end:
            done = True
    if done:
        state = "done"
    elif end and end < today:
        state = "overdue"
    else:
        state = "doing"
    return state, last


# ---------------------------------------------------------------------------
# 6. 面板（契约 §3.7）
# ---------------------------------------------------------------------------


def build_panel(items, groups, voided, me, today):
    vis = visible_items(items, me)
    vis_names = set(i["item"] for i in vis)
    item_by_name = {i["item"]: i for i in vis}

    states = {}
    lasts = {}
    for item in vis:
        state, last = compute_state(item, groups.get(item["item"], []), today, voided)
        states[item["item"]] = state
        lasts[item["item"]] = last

    week_start, week_end = week_bounds(today)

    # 本周动态（只算真实进展；作废行不算）
    week_entries = []
    for name in [i["item"] for i in vis]:
        item = item_by_name[name]
        for row in groups.get(name, []):
            content = (row.get(PROGRESS_KEY) or "").strip()
            if not content or is_void_text(content):
                continue
            key = "%s|%s|%s" % (name, row.get(SUB_KEY, ""), row.get(DATE_KEY, ""))
            if key in voided:
                continue
            progress_date = parse_date(row.get(DATE_KEY))
            if not progress_date or not (week_start <= progress_date <= week_end):
                continue
            week_entries.append(
                {
                    "date": fmt_date(progress_date),
                    "item": name,
                    "module": item["module"],
                    "sub": row.get(SUB_KEY, ""),
                    "actor": row.get(OWNER_KEY, ""),
                    "actorNames": split_names(row.get(OWNER_KEY, "")),
                    "progress": content,
                    "canWrite": can_write(item, me),
                }
            )
    week_entries.sort(key=lambda e: (e["date"], e["item"]), reverse=True)

    by_actor = {}
    for entry in week_entries:
        for actor in entry["actorNames"] or ([entry["actor"]] if entry["actor"] else []):
            by_actor[actor] = by_actor.get(actor, 0) + 1

    # 逾期
    overdue_rows = []
    for item in vis:
        if states[item["item"]] != "overdue":
            continue
        end = parse_date(item.get("end"))
        days = (today - end).days if end else 0
        last = lasts[item["item"]]
        overdue_rows.append(
            {
                "item": item["item"],
                "module": item["module"],
                "owner": item["owner"],
                "end": item.get("end", ""),
                "overdueDays": days,
                "lastProgress": fmt_date(last) if last else None,
                "canWrite": can_write(item, me),
            }
        )
    overdue_rows.sort(key=lambda r: (-r["overdueDays"], r["item"]))

    # 到期（分母 = 已到期项，不是 43）
    due_items = [i for i in vis if parse_date(i.get("end")) and parse_date(i.get("end")) < today]
    due_done = [i for i in due_items if states[i["item"]] == "done"]

    # 7 天无进展
    stale_items = []
    never_updated = 0
    worst_days = 0
    for item in vis:
        last = lasts[item["item"]]
        if last is None:
            stale_items.append(item["item"])
            never_updated += 1
            continue
        days = (today - last).days
        if days >= 7:
            stale_items.append(item["item"])
            worst_days = max(worst_days, days)

    # 按模块
    module_order = []
    for item in items:                       # 源表出现顺序 → 同数时的稳定次序
        if item["module"] not in module_order:
            module_order.append(item["module"])
    by_module = []
    for module in module_order:
        group_items = [i for i in vis if i["module"] == module]
        if not group_items:
            continue
        week_count = sum(
            1
            for e in week_entries
            if item_by_name[e["item"]]["module"] == module
        )
        by_module.append(
            {
                "module": module,
                "count": len(group_items),
                "done": sum(1 for i in group_items if states[i["item"]] == "done"),
                "doing": sum(1 for i in group_items if states[i["item"]] == "doing"),
                "overdue": sum(1 for i in group_items if states[i["item"]] == "overdue"),
                "week": week_count,
            }
        )
    by_module.sort(key=lambda m: -m["count"])
    by_module.sort(key=lambda m: module_order.index(m["module"]))
    by_module.sort(key=lambda m: -m["count"])

    # 按责任人
    owner_map = {}
    for item in vis:
        names = item["ownerNames"] or ([item["owner"]] if item["owner"] else [])
        for owner in names:
            entry = owner_map.setdefault(
                owner,
                {
                    "owner": owner,
                    "count": 0,
                    "done": 0,
                    "doing": 0,
                    "overdue": 0,
                    "week": 0,
                    "last": None,
                    "nonPerson": False,
                },
            )
            entry["count"] += 1
            entry["done" if states[item["item"]] == "done" else
                  "overdue" if states[item["item"]] == "overdue" else "doing"] += 1
    for entry in week_entries:
        for actor in entry["actorNames"] or ([entry["actor"]] if entry["actor"] else []):
            if actor in owner_map:
                owner_map[actor]["week"] += 1
    for item in vis:
        last = lasts[item["item"]]
        if not last:
            continue
        for owner in item["ownerNames"]:
            if owner in owner_map and (owner_map[owner]["last"] is None or last > owner_map[owner]["last"]):
                owner_map[owner]["last"] = last
    by_owner = []
    for entry in owner_map.values():
        by_owner.append(
            {
                "owner": entry["owner"],
                "count": entry["count"],
                "done": entry["done"],
                "doing": entry["doing"],
                "overdue": entry["overdue"],
                "week": entry["week"],
                "lastUpdate": fmt_date(entry["last"]) if entry["last"] else None,
                "nonPerson": entry["owner"] == NON_PERSON,
            }
        )
    by_owner.sort(key=lambda o: (-o["count"], -o["overdue"], o["owner"]))

    # 本周动态按日分组
    week_grouped = []
    for date in sorted(set(e["date"] for e in week_entries), reverse=True):
        week_grouped.append(
            {"date": date, "entries": [e for e in week_entries if e["date"] == date]}
        )

    scope_label = "全部 %d 个事项" % len(vis)
    me_scope = field(me, "scope") or "all"
    if me and me_scope == "modules":
        scope_label = "%s · %d 个事项" % (field(me, "modules") or "", len(vis))
    elif me and me_scope == "self":
        scope_label = "仅与我相关 · %d 个事项" % len(vis)

    return {
        "scope": {"label": scope_label, "count": len(vis)},
        "kpi": {
            "overdue": {
                "n": len(overdue_rows),
                "worstDays": max([r["overdueDays"] for r in overdue_rows] or [0]),
            },
            # 分母 = 已到期（完成时间 < 今天），不是 43
            "dueDone": {"done": len(due_done), "due": len(due_items)},
            "weekActivity": {
                "n": len(week_entries),
                "items": len(set(e["item"] for e in week_entries)),
                "byActor": by_actor,
            },
            "stale": {
                "n": len(stale_items),
                "worstDays": worst_days,
                "neverUpdated": never_updated,
            },
        },
        "byModule": by_module,
        "byOwner": by_owner,
        "overdue": overdue_rows,
        "weekActivity": week_grouped,
    }


# ---------------------------------------------------------------------------
# 7. 会话
# ---------------------------------------------------------------------------


def make_token(name, ttl=None):
    exp = int(time.time() + (ttl or SESSION_TTL))
    payload = "%s|%d" % (name, exp)
    sig = hmac.new(SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")
    return "%s.%s" % (token, sig)


def read_token(token):
    if not token or "." not in token:
        return None
    b64, sig = token.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    expect = hmac.new(SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        return None
    name, _, exp = payload.partition("|")
    try:
        exp = int(exp)
    except ValueError:
        return None
    if exp < time.time():
        return None
    return name


def member_public(row, can_write_count=None):
    out = {
        "name": row["name"],
        "role": row["role"],
        "scope": row["scope"],
    }
    if can_write_count is not None:
        out["canWriteCount"] = can_write_count
    return out


# ---------------------------------------------------------------------------
# 8. HTTP 处理
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "hps/1.0"
    protocol_version = "HTTP/1.1"

    # -- 基础输出 ---------------------------------------------------------
    def _send(self, status, body, content_type, extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or []):
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra_headers)

    def send_error_json(self, status, code, detail=None, extra=None):
        payload = {"error": code}
        if detail:
            payload["detail"] = detail
        if extra:
            payload.update(extra)
        self.send_json(status, payload)

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    # -- 请求解析 ---------------------------------------------------------
    def read_body(self):
        length = self.headers.get("Content-Length")
        try:
            size = int(length or 0)
        except ValueError:
            return None
        if size <= 0:
            return {}
        raw = self.rfile.read(size)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def current_member(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get(COOKIE_NAME)
        if not morsel:
            return None
        name = read_token(morsel.value)
        if not name:
            return None
        return find_member(name)

    # -- 路由 -------------------------------------------------------------
    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self.handle_api(method, path, query)
                return
            if method == "GET":
                self.handle_static(path)
                return
            self.send_error_json(404, "not_found")
        except BrokenPipeError:
            pass
        except Exception as exc:                      # 兜底，别让服务挂掉
            log("!! 未捕获异常 %s: %s" % (type(exc).__name__, exc))
            import traceback
            traceback.print_exc()
            try:
                self.send_error_json(500, "internal_error", str(exc))
            except Exception:
                pass

    # -- 静态文件 ---------------------------------------------------------
    def handle_static(self, path):
        entry = STATIC_FILES.get(path)
        if not entry:
            self.send_error_json(404, "not_found", "没有这个路径：%s" % path)
            return
        rel, content_type = entry
        full = os.path.join(ROOT, rel)
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error_json(404, "not_found", "文件不存在：%s" % rel)
            return
        self._send(200, body, content_type)

    # -- API --------------------------------------------------------------
    def handle_api(self, method, path, query):
        if path == "/api/session" and method == "GET":
            return self.api_session()
        if path == "/api/login" and method == "POST":
            return self.api_login()
        if path in ("/api/login/wecom", "/api/oauth/wecom") and method in ("GET", "POST"):
            # 契约 §2：企微 OAuth 是预留位，接口未实现就返回 501，**不要伪造成功**
            return self.send_error_json(
                501,
                "wecom_oauth_not_enabled",
                "企业微信 OAuth 还没接；先用姓名登录（POST /api/login）",
            )
        if path == "/api/logout" and method == "POST":
            return self.api_logout()
        if path == "/api/data" and method == "GET":
            return self.api_data()
        if path == "/api/progress" and method == "POST":
            return self.api_progress()
        if path == "/api/tasks" and method == "POST":
            return self.api_tasks()
        if path == "/api/void" and method == "POST":
            return self.api_void()
        if path == "/api/panel" and method == "GET":
            return self.api_panel()
        if path == "/api/queue" and method == "GET":
            return self.api_queue()
        if path == "/api/queue/replay" and method == "POST":
            return self.api_queue_replay()
        self.send_error_json(404, "not_found", "没有这个接口：%s %s" % (method, path))

    # -- 数据装载 ---------------------------------------------------------
    def load_dataset(self, force=False):
        try:
            data = CACHE.get(force=force)
        except SheetUnavailable as exc:
            raise SheetUnavailable(str(exc))
        rows = data["rows"]
        items, groups = build_items(rows)
        voided = voided_keys()
        flags, pending_items, filler_items = pending_rows(items, groups, data.get("raw_items"), voided)
        return {
            "rows": rows,
            "items": items,
            "groups": groups,
            "voided": voided,
            "flags": flags,
            "pendingItems": pending_items,
            "fillerItems": filler_items,
            "generatedAt": now_iso(),
        }

    def data_stamp(self, rows):
        """数据截至 = 有非空进展的行里的最大进展日期（**不是** max(进展日期)）。"""
        best = None
        for row in rows:
            content = (row.get(PROGRESS_KEY) or "").strip()
            if not content:
                continue
            progress_date = parse_date(row.get(DATE_KEY))
            if progress_date and (best is None or progress_date > best):
                best = progress_date
        return fmt_date(best) if best else ""

    # -- /api/session -----------------------------------------------------
    def api_session(self):
        me_row = self.current_member()
        try:
            data = self.load_dataset()
        except SheetUnavailable:
            data = {"items": [], "rows": [], "groups": {}, "voided": set(), "flags": {}}
        items = data["items"]

        me = None
        if me_row:
            vis = visible_items(items, me_row)
            me = {
                "name": me_row["name"],
                "role": me_row["role"],
                "userid": me_row["userid"] or "",
                "canWriteCount": sum(1 for i in vis if can_write(i, me_row)),
                "scope": me_row["scope"],
            }
        members = []
        for row in member_rows():
            if not row["active"]:
                continue
            vis = visible_items(items, row)
            members.append(
                member_public(row, sum(1 for i in vis if can_write(i, row)))
            )
        payload = {
            "me": me,
            "members": members,
            "serverTime": now_iso(),
            "dataStamp": self.data_stamp(data["rows"]),
            "adapter": ADAPTER.name,
            "capabilities": {
                "write": bool(me and me["role"] != "viewer"),
                "createTask": bool(me and me["role"] in ("admin", "editor")),
                "admin": bool(me and me["role"] == "admin"),
            },
        }
        self.send_json(200, payload)

    # -- /api/login -------------------------------------------------------
    def api_login(self):
        body = self.read_body()
        if body is None:
            return self.send_error_json(400, "invalid_json", "请求体必须是 JSON 对象")
        name = str(body.get("name") or "").strip()
        if not name:
            return self.send_error_json(400, "name_required", "请提供姓名")
        row = find_member(name)
        if row is None:
            return self.send_error_json(404, "unknown_member", "成员表中没有这个人")
        token = make_token(row["name"])
        cookie = (
            "%s=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d"
            % (COOKIE_NAME, token, SESSION_TTL)
        )
        try:
            data = self.load_dataset()
            vis = visible_items(data["items"], row)
            can_write_count = sum(1 for i in vis if can_write(i, row))
        except SheetUnavailable:
            can_write_count = 0
        me = {
            "name": row["name"],
            "role": row["role"],
            "userid": row["userid"] or "",
            "canWriteCount": can_write_count,
            "scope": row["scope"],
        }
        self.send_json(200, {"ok": True, "me": me}, extra_headers=[("Set-Cookie", cookie)])

    def api_logout(self):
        cookie = "%s=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" % COOKIE_NAME
        self.send_json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie)])

    # -- /api/data --------------------------------------------------------
    def api_data(self):
        me_row = self.current_member()
        try:
            data = self.load_dataset()
        except SheetUnavailable as exc:
            return self.send_error_json(503, "sheet_unavailable", str(exc))
        vis = visible_items(data["items"], me_row)
        vis_names = set(i["item"] for i in vis)
        rows = []
        pending_flags = []
        for name in [i["item"] for i in vis]:
            for row in data["groups"].get(name, []):
                out = dict(row)
                key = (name, row.get(SUB_KEY, ""), row.get(DATE_KEY, ""))
                sheet_key = "%s|%s|%s" % (name, row.get(SUB_KEY, ""), row.get(DATE_KEY, ""))
                flag = data["flags"].get(key)
                if flag:
                    out["__pending"] = flag
                    pending_flags.append(
                        {
                            "item": name,
                            "sub": row.get(SUB_KEY, ""),
                            "date": row.get(DATE_KEY, ""),
                            "flag": flag,
                        }
                    )
                if is_void_text(row.get(PROGRESS_KEY)):
                    # 【作废】标记行：它本身是「这条被作废了」的凭证
                    out["__voidMarker"] = True
                elif sheet_key in data["voided"]:
                    out["__voided"] = True
                rows.append(out)
        pending_items = {}
        for entry in pending_flags:
            pending_items.setdefault(entry["flag"], set()).add(entry["item"])
        payload = {
            "rows": rows,
            "items": [
                {
                    "seq": i["seq"],
                    "item": i["item"],
                    "module": i["module"],
                    "nature": i["nature"],
                    "summary": i["summary"],
                    "start": i["start"],
                    "end": i["end"],
                    "owner": i["owner"],
                    "ownerNames": i["ownerNames"],
                    "lead": i["lead"],
                    "leadType": i["leadType"],
                    "coord": i["coord"],
                    "subs": i["subs"],
                }
                for i in vis
            ],
            "generatedAt": data["generatedAt"],
            "dataStamp": self.data_stamp(data["rows"]),
            "pending": {
                PENDING_CHECK: len(pending_items.get(PENDING_CHECK, ())),
                PENDING_FILL: len(pending_items.get(PENDING_FILL, ())),
            },
            "pendingFlags": pending_flags,
            "visibleCount": len(vis),
        }
        self.send_json(200, payload)

    # -- /api/progress ----------------------------------------------------
    def api_progress(self):
        me_row = self.current_member()
        if me_row is None:
            return self.send_error_json(401, "unauthenticated", "未登录")
        body = self.read_body()
        if body is None:
            return self.send_error_json(400, "invalid_json", "请求体必须是 JSON 对象")
        item_name = str(body.get("item") or "").strip()
        sub_name = str(body.get("sub") or "").strip()
        date_str = str(body.get("date") or "").strip()
        progress = str(body.get("progress") or "").strip()
        plan = str(body.get("plan") or "").strip()

        try:
            data = self.load_dataset()
        except SheetUnavailable as exc:
            return self.send_error_json(503, "sheet_unavailable", str(exc))

        item = next((i for i in data["items"] if i["item"] == item_name), None)
        if item is None:
            return self.send_error_json(404, "unknown_item", "源表里没有这个事项：%s" % item_name)

        if not sub_name:
            sub_name = item_name                     # 单分项事项可省略（等于事项名）
        subs = item["subs"] or [item_name]
        if sub_name not in subs:
            return self.send_error_json(
                422, "unknown_sub", "分项 %s 不属于事项 %s" % (sub_name, item_name)
            )

        if not progress and not plan:
            return self.send_error_json(422, "empty_progress", "进展与计划至少填一个")

        progress_date = parse_date(date_str)
        if progress_date is None:
            return self.send_error_json(422, "invalid_date", "日期格式不对：%s" % date_str)
        today = today_date()
        window_start = today - datetime.timedelta(days=BACKUP_WINDOW_DAYS)
        if progress_date > today or progress_date < window_start:
            return self.send_error_json(
                422,
                "date_out_of_window",
                "日期必须在 [%s, %s] 之间" % (fmt_date(window_start), fmt_date(today)),
            )

        if not can_write(item, me_row):
            return self.send_error_json(
                403, "no_write_permission", "你不是 %s 的责任人/负责人" % item_name
            )

        # 幂等 / 冲突：同一 (item, sub, date)
        sheet_key = "%s|%s|%s" % (item_name, sub_name, fmt_date(progress_date))
        same_slot = [
            r
            for r in data["groups"].get(item_name, [])
            if r.get(SUB_KEY) == sub_name and r.get(DATE_KEY) == fmt_date(progress_date)
        ]
        for row in same_slot:
            if (row.get(PROGRESS_KEY) or "").strip() == progress and (
                row.get(PLAN_KEY) or ""
            ).strip() == plan:
                audit(
                    me_row["name"],
                    me_row["userid"],
                    "progress.append",
                    sheet_key,
                    {"item": item_name, "sub": sub_name, "date": fmt_date(progress_date),
                     "progress": progress, "plan": plan},
                    "conflict",
                )
                return self.send_json(
                    200, {"ok": True, "appended": False, "duplicate": True, "row": row}
                )
        conflicting = None
        own_slot = recent_audit_for(me_row["name"], "progress.append", sheet_key)
        for row in same_slot:
            content = (row.get(PROGRESS_KEY) or "").strip()
            if not content or is_void_text(content):
                continue
            if sheet_key in data["voided"]:
                continue
            # 自己写的行不算冲突（源表只能 append，允许同一人再记一条）
            if own_slot is not None:
                continue
            conflicting = row
            break
        if conflicting is not None:
            audit(
                me_row["name"],
                me_row["userid"],
                "progress.append",
                sheet_key,
                {"item": item_name, "sub": sub_name, "date": fmt_date(progress_date),
                 "progress": progress, "plan": plan},
                "conflict",
            )
            return self.send_json(
                409,
                {
                    "error": "conflict",
                    "detail": "同一 (事项, 分项, 日期) 已有别人的进展行",
                    "existing": conflicting,
                },
            )

        new_row = {
            SEQ_KEY: "",
            MODULE_KEY: item["module"],
            NATURE_KEY: item["nature"],
            ITEM_KEY: item_name,
            SUB_KEY: sub_name,
            INTRO_KEY: item["summary"],
            DATE_KEY: fmt_date(progress_date),
            PROGRESS_KEY: progress,
            START_KEY: item["start"],
            END_KEY: item["end"],
            PLAN_KEY: plan,
            OWNER_KEY: item["owner"],
            LEAD_KEY: item["lead"],
            LEAD_TYPE_KEY: item["leadType"],
            COORD_KEY: item["coord"],
        }
        payload = {
            "item": item_name,
            "sub": sub_name,
            "date": fmt_date(progress_date),
            "progress": progress,
            "plan": plan,
        }
        try:
            append_to_sheet([new_row])
        except WriteNotSupported as exc:
            # 适配器本身不支持写（file 适配器）→ 501，不进队列
            audit(
                me_row["name"], me_row["userid"], "progress.append", sheet_key, payload, "rejected"
            )
            return self.send_error_json(501, "write_not_supported", str(exc))
        except AppendFailed as exc:
            queue_id = self.enqueue(me_row, "progress.append", payload, str(exc))
            audit(
                me_row["name"],
                me_row["userid"],
                "progress.append",
                sheet_key,
                payload,
                "queued",
            )
            return self.send_json(
                202, {"ok": False, "queued": True, "queueId": queue_id, "detail": str(exc)}
            )
        CACHE.invalidate()
        audit(
            me_row["name"],
            me_row["userid"],
            "progress.append",
            sheet_key,
            payload,
            "ok",
        )
        self.send_json(200, {"ok": True, "appended": True, "row": new_row})

    # -- /api/tasks -------------------------------------------------------
    def api_tasks(self):
        me_row = self.current_member()
        if me_row is None:
            return self.send_error_json(401, "unauthenticated", "未登录")
        if me_row["role"] == "viewer":
            return self.send_error_json(403, "no_write_permission", "只读用户不能新建任务")
        body = self.read_body()
        if body is None:
            return self.send_error_json(400, "invalid_json", "请求体必须是 JSON 对象")

        module = str(body.get("module") or "").strip()
        nature = str(body.get("nature") or "").strip()
        item_name = str(body.get("item") or "").strip()
        subs = body.get("subs")
        start = str(body.get("start") or "").strip()
        end = str(body.get("end") or "").strip()
        owners = body.get("owner")
        lead = str(body.get("lead") or "").strip()
        lead_type = str(body.get("leadType") or "").strip()
        coord = str(body.get("coord") or "").strip()
        note = str(body.get("note") or "").strip()

        if module not in MODULES:
            return self.send_error_json(422, "invalid_module", "一级维度必须是：%s" % "、".join(MODULES))
        if nature not in NATURES:
            return self.send_error_json(422, "invalid_nature", "二级维度必须是：%s" % "、".join(NATURES))
        if not item_name:
            return self.send_error_json(422, "item_required", "请填写具体事项")
        if coord:
            return self.send_error_json(
                422, "coord_not_open", "协调事项口径待定，暂不开放填写"
            )
        if not isinstance(owners, list) or not [o for o in owners if str(o).strip()]:
            return self.send_error_json(422, "owner_required", "至少指定一位责任人")
        owners = [str(o).strip() for o in owners if str(o).strip()]
        if not lead:
            return self.send_error_json(422, "lead_required", "请指定负责人")

        start_date = parse_date(start)
        end_date = parse_date(end)
        if start_date is None:
            return self.send_error_json(422, "invalid_start", "开始时间格式不对")
        if end_date is None:
            return self.send_error_json(422, "invalid_end", "完成时间格式不对")
        if end_date < start_date:
            return self.send_error_json(422, "invalid_date_range", "完成时间不能早于开始时间")

        normalized_subs = []
        if isinstance(subs, list) and subs:
            for sub in subs:
                if isinstance(sub, str):
                    name, intro = sub.strip(), ""
                elif isinstance(sub, dict):
                    name = str(sub.get("name") or "").strip()
                    intro = str(sub.get("intro") or "").strip()
                else:
                    name, intro = "", ""
                if not name:
                    return self.send_error_json(422, "sub_required", "分项名不能为空")
                if len(intro) > 100:
                    return self.send_error_json(422, "intro_too_long", "分项内容简介不超过 100 字")
                if name in [s["name"] for s in normalized_subs]:
                    return self.send_error_json(422, "duplicate_sub", "同一事项内分项不能重名")
                normalized_subs.append({"name": name, "intro": intro})
        else:
            normalized_subs = [{"name": item_name, "intro": ""}]

        try:
            data = self.load_dataset()
        except SheetUnavailable as exc:
            return self.send_error_json(503, "sheet_unavailable", str(exc))

        # 全局唯一（对**全部**事项判，不受数据范围影响）
        if any(i["item"] == item_name for i in data["items"]):
            return self.send_error_json(
                409, "duplicate_item", "已存在同名事项「%s」" % item_name
            )

        # 负责人类型只能是源表已出现过的值
        known_lead_types = set(
            r.get(LEAD_TYPE_KEY, "") for r in data["rows"] if (r.get(LEAD_TYPE_KEY) or "").strip()
        )
        if lead_type and lead_type not in known_lead_types:
            return self.send_error_json(
                422,
                "invalid_lead_type",
                "负责人类型只能是源表已出现的值：%s" % "、".join(sorted(known_lead_types)),
            )

        # editor 只能在自己是责任人的模块下建任务
        if me_row["role"] != "admin":
            vis = visible_items(data["items"], me_row)
            allowed = set(
                i["module"] for i in vis if me_row["name"] in (i.get("ownerNames") or [])
            )
            if module not in allowed:
                hint = (
                    "你只能在 %s 下建任务" % "、".join(sorted(allowed))
                    if allowed
                    else "你名下没有模块，不能建任务"
                )
                return self.send_error_json(403, "module_not_allowed", hint)

        rows = []
        for sub in normalized_subs:
            rows.append(
                {
                    SEQ_KEY: "",                            # 新任务不给号（源表序号已撞号）
                    MODULE_KEY: module,
                    NATURE_KEY: nature,
                    ITEM_KEY: item_name,
                    SUB_KEY: sub["name"],
                    INTRO_KEY: sub["intro"],
                    DATE_KEY: fmt_date(start_date),
                    PROGRESS_KEY: TASK_FILLER,
                    START_KEY: fmt_date(start_date),
                    END_KEY: fmt_date(end_date),
                    PLAN_KEY: "",
                    OWNER_KEY: "\n".join(owners),
                    LEAD_KEY: lead,
                    LEAD_TYPE_KEY: lead_type,
                    COORD_KEY: "",
                }
            )
        payload = {
            "module": module,
            "nature": nature,
            "item": item_name,
            "subs": normalized_subs,
            "start": fmt_date(start_date),
            "end": fmt_date(end_date),
            "owner": owners,
            "lead": lead,
            "leadType": lead_type,
            "note": note,
        }
        try:
            append_to_sheet(rows)
        except WriteNotSupported as exc:
            audit(me_row["name"], me_row["userid"], "task.create", item_name, payload, "rejected")
            return self.send_error_json(501, "write_not_supported", str(exc))
        except AppendFailed as exc:
            queue_id = self.enqueue(me_row, "task.create", payload, str(exc))
            audit(
                me_row["name"], me_row["userid"], "task.create", item_name, payload, "queued"
            )
            return self.send_json(
                202, {"ok": False, "queued": True, "queueId": queue_id, "detail": str(exc)}
            )
        CACHE.invalidate()
        audit(me_row["name"], me_row["userid"], "task.create", item_name, payload, "ok")
        self.send_json(
            200, {"ok": True, "item": item_name, "appendedRows": len(rows), "row": rows[0]}
        )

    # -- /api/void --------------------------------------------------------
    def api_void(self):
        me_row = self.current_member()
        if me_row is None:
            return self.send_error_json(401, "unauthenticated", "未登录")
        body = self.read_body()
        if body is None:
            return self.send_error_json(400, "invalid_json", "请求体必须是 JSON 对象")
        item_name = str(body.get("item") or "").strip()
        sub_name = str(body.get("sub") or "").strip()
        date_str = str(body.get("date") or "").strip()
        reason = str(body.get("reason") or "").strip()

        try:
            data = self.load_dataset()
        except SheetUnavailable as exc:
            return self.send_error_json(503, "sheet_unavailable", str(exc))

        item = next((i for i in data["items"] if i["item"] == item_name), None)
        if item is None:
            return self.send_error_json(404, "unknown_item", "源表里没有这个事项：%s" % item_name)
        if not sub_name:
            sub_name = item_name
        progress_date = parse_date(date_str)
        if progress_date is None:
            return self.send_error_json(422, "invalid_date", "日期格式不对：%s" % date_str)
        date_key = fmt_date(progress_date)
        sheet_key = "%s|%s|%s" % (item_name, sub_name, date_key)

        target_rows = [
            r
            for r in data["groups"].get(item_name, [])
            if r.get(SUB_KEY) == sub_name and r.get(DATE_KEY) == date_key
        ]
        if not target_rows:
            return self.send_error_json(404, "row_not_found", "源表里没有这一行")

        # 权限：admin，或作者本人且 24h 内写入（**先判权限**，别泄露作废状态）
        allowed = me_row["role"] == "admin"
        if not allowed:
            own = recent_audit_for(me_row["name"], "progress.append", sheet_key)
            if own:
                try:
                    written_at = datetime.datetime.fromisoformat(own["ts"])
                except (TypeError, ValueError):
                    written_at = None
                if written_at is not None:
                    age = datetime.datetime.now(written_at.tzinfo) - written_at
                    allowed = age.total_seconds() <= 24 * 3600
        if not allowed:
            return self.send_error_json(
                403, "no_void_permission", "只有作者本人 24 小时内或 admin 可以作废"
            )

        if sheet_key in data["voided"]:
            return self.send_json(200, {"ok": True, "alreadyVoided": True})

        original = target_rows[-1]
        marker = {
            SEQ_KEY: original.get(SEQ_KEY, ""),
            MODULE_KEY: item["module"],
            NATURE_KEY: item["nature"],
            ITEM_KEY: item_name,
            SUB_KEY: sub_name,
            INTRO_KEY: item["summary"],
            DATE_KEY: date_key,
            PROGRESS_KEY: VOID_PREFIX + (original.get(PROGRESS_KEY) or ""),
            START_KEY: item["start"],
            END_KEY: item["end"],
            PLAN_KEY: "",
            OWNER_KEY: item["owner"],
            LEAD_KEY: item["lead"],
            LEAD_TYPE_KEY: item["leadType"],
            COORD_KEY: item["coord"],
        }
        payload = {"item": item_name, "sub": sub_name, "date": date_key, "reason": reason}
        try:
            append_to_sheet([marker])
        except WriteNotSupported as exc:
            audit(me_row["name"], me_row["userid"], "progress.void", sheet_key, payload, "rejected")
            return self.send_error_json(501, "write_not_supported", str(exc))
        except AppendFailed as exc:
            queue_id = self.enqueue(me_row, "progress.void", payload, str(exc))
            audit(me_row["name"], me_row["userid"], "progress.void", sheet_key, payload, "queued")
            return self.send_json(
                202, {"ok": False, "queued": True, "queueId": queue_id, "detail": str(exc)}
            )
        CACHE.invalidate()
        conn = db()
        try:
            conn.execute(
                "INSERT INTO voided (sheet_key,voided_by,voided_at,reason) VALUES (?,?,?,?)",
                (sheet_key, me_row["name"], now_iso(), reason),
            )
            conn.commit()
        finally:
            conn.close()
        audit(me_row["name"], me_row["userid"], "progress.void", sheet_key, payload, "ok")
        self.send_json(200, {"ok": True})

    # -- /api/panel -------------------------------------------------------
    def api_panel(self):
        me_row = self.current_member()
        try:
            data = self.load_dataset()
        except SheetUnavailable as exc:
            return self.send_error_json(503, "sheet_unavailable", str(exc))
        panel = build_panel(data["items"], data["groups"], data["voided"], me_row, today_date())
        panel["dataStamp"] = self.data_stamp(data["rows"])
        panel["generatedAt"] = data["generatedAt"]
        self.send_json(200, panel)

    # -- 队列 -------------------------------------------------------------
    def enqueue(self, me_row, action, payload, error):
        conn = db()
        try:
            payload = dict(payload or {})
            payload.setdefault("actor", me_row["name"] if me_row else "")
            cur = conn.execute(
                "INSERT INTO queue (ts,actor,action,payload,status,last_error) VALUES (?,?,?,?,?,?)",
                (
                    now_iso(),
                    me_row["name"] if me_row else "",
                    action,
                    json.dumps(payload, ensure_ascii=False),
                    "pending",
                    error,
                ),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def api_queue(self):
        me_row = self.current_member()
        if me_row is None:
            return self.send_error_json(401, "unauthenticated", "未登录")
        if me_row["role"] != "admin":
            return self.send_error_json(403, "admin_only", "只有 admin 能看队列")
        conn = db()
        try:
            rows = conn.execute(
                "SELECT id,ts,actor,action,payload,status,last_error FROM queue ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        out = []
        for row in rows:
            try:
                payload = json.loads(row["payload"]) if row["payload"] else None
            except ValueError:
                payload = row["payload"]
            out.append(
                {
                    "id": row["id"],
                    "ts": row["ts"],
                    "actor": row["actor"],
                    "action": row["action"],
                    "payload": payload,
                    "status": row["status"],
                    "last_error": row["last_error"],
                }
            )
        self.send_json(200, out)

    def api_queue_replay(self):
        me_row = self.current_member()
        if me_row is None:
            return self.send_error_json(401, "unauthenticated", "未登录")
        if me_row["role"] != "admin":
            return self.send_error_json(403, "admin_only", "只有 admin 能重放队列")
        body = self.read_body()
        if body is None:
            body = {}
        wanted = body.get("ids")
        conn = db()
        try:
            if wanted:
                rows = conn.execute(
                    "SELECT id,actor,action,payload FROM queue WHERE status='pending' AND id IN (%s)"
                    % ",".join("?" * len(wanted)),
                    tuple(wanted),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id,actor,action,payload FROM queue WHERE status='pending' ORDER BY id"
                ).fetchall()
        finally:
            conn.close()
        results = []
        ok_count = 0
        for row in rows:
            try:
                payload = json.loads(row["payload"]) if row["payload"] else {}
            except ValueError:
                payload = {}
            try:
                self.replay_one(row["action"], payload)
            except Exception as exc:                      # 重放失败 → 保留 pending
                conn = db()
                try:
                    conn.execute(
                        "UPDATE queue SET last_error=? WHERE id=?", (str(exc), row["id"])
                    )
                    conn.commit()
                finally:
                    conn.close()
                results.append({"id": row["id"], "ok": False, "error": str(exc)})
                continue
            conn = db()
            try:
                conn.execute("UPDATE queue SET status='done', last_error=NULL WHERE id=?", (row["id"],))
                conn.commit()
            finally:
                conn.close()
            ok_count += 1
            results.append({"id": row["id"], "ok": True})
        CACHE.invalidate()
        self.send_json(
            200, {"ok": True, "replayed": ok_count, "failed": len(results) - ok_count, "results": results}
        )

    def replay_one(self, action, payload):
        """把队列里的一条按原动作重新写回源表。"""
        if action == "progress.append":
            item_name = payload.get("item")
            sub_name = payload.get("sub") or item_name
            progress_date = parse_date(payload.get("date"))
            if progress_date is None:
                raise ValueError("队列里的日期不对")
            data = self.load_dataset(force=True)
            item = next((i for i in data["items"] if i["item"] == item_name), None)
            if item is None:
                raise ValueError("源表里已经找不到事项：%s" % item_name)
            row = {
                SEQ_KEY: "",
                MODULE_KEY: item["module"],
                NATURE_KEY: item["nature"],
                ITEM_KEY: item_name,
                SUB_KEY: sub_name,
                INTRO_KEY: item["summary"],
                DATE_KEY: fmt_date(progress_date),
                PROGRESS_KEY: payload.get("progress") or "",
                START_KEY: item["start"],
                END_KEY: item["end"],
                PLAN_KEY: payload.get("plan") or "",
                OWNER_KEY: item["owner"],
                LEAD_KEY: item["lead"],
                LEAD_TYPE_KEY: item["leadType"],
                COORD_KEY: item["coord"],
            }
            append_to_sheet([row])
            audit(payload.get("actor") or "", "", "progress.append",
                  "%s|%s|%s" % (item_name, sub_name, fmt_date(progress_date)), payload, "ok")
            return
        if action == "task.create":
            rows = []
            for sub in payload.get("subs") or [{"name": payload.get("item"), "intro": ""}]:
                rows.append(
                    {
                        SEQ_KEY: "",
                        MODULE_KEY: payload.get("module") or "",
                        NATURE_KEY: payload.get("nature") or "",
                        ITEM_KEY: payload.get("item") or "",
                        SUB_KEY: sub.get("name") or "",
                        INTRO_KEY: sub.get("intro") or "",
                        DATE_KEY: payload.get("start") or "",
                        PROGRESS_KEY: TASK_FILLER,
                        START_KEY: payload.get("start") or "",
                        END_KEY: payload.get("end") or "",
                        PLAN_KEY: "",
                        OWNER_KEY: "\n".join(payload.get("owner") or []),
                        LEAD_KEY: payload.get("lead") or "",
                        LEAD_TYPE_KEY: payload.get("leadType") or "",
                        COORD_KEY: "",
                    }
                )
            append_to_sheet(rows)
            audit(payload.get("actor") or "", "", "task.create", payload.get("item") or "", payload, "ok")
            return
        if action == "progress.void":
            data = self.load_dataset(force=True)
            item = next((i for i in data["items"] if i["item"] == payload.get("item")), None)
            if item is None:
                raise ValueError("源表里已经找不到事项：%s" % payload.get("item"))
            marker = {
                SEQ_KEY: "",
                MODULE_KEY: item["module"],
                NATURE_KEY: item["nature"],
                ITEM_KEY: item["item"],
                SUB_KEY: payload.get("sub") or item["item"],
                INTRO_KEY: item["summary"],
                DATE_KEY: payload.get("date") or "",
                PROGRESS_KEY: VOID_PREFIX,
                START_KEY: item["start"],
                END_KEY: item["end"],
                PLAN_KEY: "",
                OWNER_KEY: item["owner"],
                LEAD_KEY: item["lead"],
                LEAD_TYPE_KEY: item["leadType"],
                COORD_KEY: item["coord"],
            }
            append_to_sheet([marker])
            return
        raise ValueError("未知的队列动作：%s" % action)


# ---------------------------------------------------------------------------
# 9. 启动
# ---------------------------------------------------------------------------

ADAPTER = ADAPTERS.get(ADAPTER_NAME)
if ADAPTER is None:
    log("!! 未知适配器 HPS_SHEET_ADAPTER=%s，可选：%s" % (ADAPTER_NAME, "、".join(sorted(ADAPTERS))))
    sys.exit(2)
ADAPTER = ADAPTER()
CACHE = DatasetCache(ADAPTER)
# 源表写入串行化（交互方案 §4.7）：同一张源表的写入排队执行，
# 避免两个人同时追加到相邻行造成错位。
WRITE_LOCK = threading.Lock()


def append_to_sheet(rows):
    """串行化写源表：一次只追加一批，别的请求排队等。"""
    with WRITE_LOCK:
        return ADAPTER.append(rows)


def banner():
    print("=" * 74)
    print(" 集团人力重点工作进度表 · 后端服务")
    print(" 地址      http://%s:%d" % (HOST, PORT))
    print(" 适配器    %s%s" % (ADAPTER.name, "" if ADAPTER.supports_write else "（只读）"))
    print(" 源表      docid=%s 子表=%s" % (DOCID, SHEET_TITLE))
    print(" 数据库    %s" % os.path.relpath(DB_PATH, ROOT))
    print(" 补录窗口  %d 天" % BACKUP_WINDOW_DAYS)
    if SECRET == DEFAULT_SECRET:
        print("")
        print("!" * 74)
        print("!! 警告：HPS_SECRET 仍是默认开发值「%s」" % DEFAULT_SECRET)
        print("!!       会话 cookie 可被伪造。上线前必须设置 HPS_SECRET 环境变量。")
        print("!" * 74)
    print("=" * 74)
    sys.stdout.flush()


def main():
    banner()
    init_db()
    try:
        data = CACHE.get(force=True)
        log("源表已装载：%d 行 / %d 事项（适配器 %s）"
            % (len(data["rows"]), len(build_items(data["rows"])[0]), ADAPTER.name))
    except SheetUnavailable as exc:
        log("!! 源表首次读取失败：%s（接口会返回 503 sheet_unavailable）" % exc)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    log("服务已启动，按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl+C，正在退出")
        httpd.shutdown()


if __name__ == "__main__":
    main()
