#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 rows_v2.json + tasks_online.json 打包成浏览器可直接加载的 data/rows.js。

为什么要有这一步：网页要能在 file:// 下直接打开（不发请求、不吃 CORS），
所以数据不能是 fetch('data/rows_v2.json')，必须是一个普通 <script src="data/rows.js">，
脚本里执行 `window.HR_DATA = {...}`。

产物：data/rows.js
    window.HR_DATA = {
      rows:      [ ...与 rows_v2.json 完全一致的 167 行、15 键 ... ],
      items:     [ ...与 tasks_online.json 完全一致的 43 条事项 ... ],
      generatedAt: "2026-10-24T14:03:11+08:00"
    }

用法：
    python3 scripts/build_data_js.py            # 生成
    python3 scripts/build_data_js.py --check    # 只校验数据自洽性，不写文件
    python3 scripts/build_data_js.py --stdout   # 打到标准输出（调试用）

校验口径见 docs/口径说明.md。
"""
import argparse
import collections
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS_SRC = os.path.join(ROOT, "data", "rows_v2.json")
ITEMS_SRC = os.path.join(ROOT, "data", "tasks_online.json")
OUT = os.path.join(ROOT, "data", "rows.js")

# rows_v2.json 的 15 列，顺序即网页明细视图的列序（不可改）
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

MODULES = [
    "人力资源规划",
    "招聘与配置",
    "培训与开发",
    "绩效管理",
    "薪酬福利",
    "员工关系",
    "待定位",
]

NATURES = ["人", "流程", "成本"]


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_pending_sets(items):
    """复刻 scripts/build_rows.py 的清洗判定，返回（待核事项名集合，待补事项名集合）。

    待核：进展原文里有一行没有 MMDD 日期前缀 → 按开始时间落行，标「待核」。
    待补：进展与周计划都为空 → 按开始时间落一行空行，标「待补」。

    注意：原始进展是按「行」判定的，不是按事项整体判定。
    例：确定保留项目及发放方式 = "1012已确定部分取消项目\\n以上四项待确定"，
        第一行有日期、第二行没有 → 只有第二行那一条是待核。
    """
    pending = set()
    filler = set()
    for it in items:
        raw = (it.get("progress") or "")
        lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]
        week = (it.get("week") or "").strip()
        if lines and any(not ln[:4].isdigit() for ln in lines):
            pending.add(it["item"])
        if not lines and not week:
            filler.add(it["item"])
    return pending, filler


def check(rows, items):
    """数据自洽性校验。返回 (ok, 报告行列表)。"""
    out = []
    ok = True

    def say(flag, msg):
        nonlocal ok
        out.append(("OK  " if flag else "FAIL") + "  " + msg)
        if not flag:
            ok = False

    # 1) 行数与列数
    say(len(rows) == 167, "行数 167（实际 %d）" % len(rows))
    say(len(items) == 43, "事项数 43（实际 %d）" % len(items))

    # 2) 每行 15 键、键名与键序完全一致
    bad_keys = [i for i, r in enumerate(rows) if list(r.keys()) != ROW_KEYS]
    say(not bad_keys, "每行 15 键且键序一致（异常行 %s）" % (bad_keys[:5] or "无"))
    say(all(isinstance(r["事项序号"], int) for r in rows), "事项序号均为整数")

    # 3) 每个事项至少有一行；每行都能对上源事项
    by_item = collections.Counter(r["具体事项"] for r in rows)
    no_rows = [it["item"] for it in items if by_item.get(it["item"], 0) == 0]
    say(not no_rows, "每个事项至少 1 行（缺行：%s）" % (no_rows or "无"))
    orphan = sorted(set(by_item) - {it["item"] for it in items})
    say(not orphan, "没有孤儿行（无对应源事项：%s）" % (orphan or "无"))

    # 4) 事项级字段（行内冗余）必须与源事项一致，否则网页取值会打架
    by_name = {it["item"]: it for it in items}
    diff = collections.Counter()
    for r in rows:
        it = by_name.get(r["具体事项"])
        if not it:
            continue
        if r["开始时间"] != it["start"]:
            diff["开始时间"] += 1
        if r["完成时间"] != it["end"]:
            diff["完成时间"] += 1
        if r["责任人"] != it["owner"]:
            diff["责任人"] += 1
        if r["负责人"] != it["lead"]:
            diff["负责人"] += 1
        if r["负责人类型"] != it["typ"]:
            diff["负责人类型"] += 1
        if r["协调事项"] != it["coord"]:
            diff["协调事项"] += 1
    say(not diff, "行内事项级字段与源事项一致（差异：%s）" % (dict(diff) or "无"))

    # 5) 维度取值合法，且同一事项内不打架
    bad_mod = sorted({r["一级维度（六大模块）"] for r in rows} - set(MODULES))
    say(not bad_mod, "一级维度取值合法（异常：%s）" % (bad_mod or "无"))
    bad_nat = sorted({r["二级维度（人/流程/成本）"] for r in rows} - set(NATURES))
    say(not bad_nat, "二级维度取值合法（异常：%s）" % (bad_nat or "无"))
    mixed = [
        k for k, v in by_item.items()
        if len({r["一级维度（六大模块）"] for r in rows if r["具体事项"] == k}) > 1
        or len({r["二级维度（人/流程/成本）"] for r in rows if r["具体事项"] == k}) > 1
    ]
    say(not mixed, "同一事项的模块/性质唯一（异常：%s）" % (mixed or "无"))

    # 6) 日期可解析、开始不晚于完成
    bad_date = []
    for i, r in enumerate(rows):
        for k in ("进展日期", "开始时间", "完成时间"):
            if not r[k]:
                continue
            try:
                datetime.datetime.strptime(r[k], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                bad_date.append((i, k, r[k]))
    say(not bad_date, "日期格式合法（异常：%s）" % (bad_date[:3] or "无"))
    inv = [(r["具体事项"], r["开始时间"], r["完成时间"])
           for r in rows if r["开始时间"] and r["完成时间"] and r["开始时间"] > r["完成时间"]]
    say(not inv, "无「开始晚于完成」（异常：%s）" % (inv[:3] or "无"))

    # 7) 待核 / 待补 判定
    pending, filler = build_pending_sets(items)
    pending_rows = [
        r for r in rows
        if r["具体事项"] in pending
        and r["进展日期"] == by_name[r["具体事项"]]["start"]
        and r["进展内容"].strip()
    ]
    filler_rows = [
        r for r in rows
        if r["具体事项"] in filler
        and not r["进展内容"].strip()
        and not r["当日计划（周计划）"].strip()
    ]
    say(len(pending) == 5, "待核事项 5 条（实际 %d：%s）"
        % (len(pending), "、".join(sorted(pending))))
    say(len(pending_rows) == 5, "待核行 5 条（实际 %d）" % len(pending_rows))
    say(len(filler) == 1, "待补事项 1 条（实际 %d：%s）"
        % (len(filler), "、".join(sorted(filler))))
    say(len(filler_rows) == 1, "待补行 1 条（实际 %d）" % len(filler_rows))

    # 8) 源事项序号撞号（源表重排导致，网页排序需二级键兜底）
    seq_ct = collections.Counter(it["seq"] for it in items)
    dup_seq = sorted(s for s, c in seq_ct.items() if c > 1)
    say(True, "源事项序号撞号：%s（网页按 序号→模块→事项名 次序排序）" % (dup_seq or "无"))

    # 9) 已知空列
    say(all(r["协调事项"] == "" for r in rows), "协调事项整列为空（保留列，页面显示「—」）")
    say(all(r["负责人类型"] == "B" for r in rows), "负责人类型全为 B（含义未知，页面不臆造）")

    return ok, out


def js_string(value):
    """JSON 编码为 JS 字面量；额外转义 U+2028/U+2029（ES2019 前是 JS 非法字符）。"""
    s = json.dumps(value, ensure_ascii=False)
    return s.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def main():
    ap = argparse.ArgumentParser(description="生成 data/rows.js")
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    ap.add_argument("--stdout", action="store_true", help="打到标准输出，不写文件")
    args = ap.parse_args()

    rows = load_json(ROWS_SRC)
    items = load_json(ITEMS_SRC)

    ok, report = check(rows, items)
    for line in report:
        print(line)
    if not ok:
        print("\n数据自洽性校验未通过，已中止。", file=sys.stderr)
        return 1

    if args.check:
        print("\n全部校验通过。")
        return 0

    payload = {
        "rows": rows,
        "items": items,
        "generatedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    body = (
        "/* 本文件由 scripts/build_data_js.py 自动生成，请勿手工编辑。\n"
        "   数据源：data/rows_v2.json（%d 行） + data/tasks_online.json（%d 事项）\n"
        "   生成时间：%s */\n"
        "window.HR_DATA = %s;\n" % (
            len(rows), len(items), payload["generatedAt"], js_string(payload)
        )
    )

    if args.stdout:
        sys.stdout.write(body)
        return 0

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(body)
    print("\n已写出：%s（%d 字节）" % (os.path.relpath(OUT, ROOT), len(body.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
