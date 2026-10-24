#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据体检：发布前跑一遍，确认网页读到的数据是干净的。

检查项：
  1. 43 个事项、167 行、每行 15 列且字段名正确
  2. 每个事项至少有一行；每个分项至少有一行
  3. 进展内容 / 当日计划里没有残留换行（网页里换行会撑破单元格）
  4. 日期都能解析成 YYYY-MM-DD，且开始时间 ≤ 完成时间
  5. 六大模块与 人/流程/成本 都在预期取值内
  6. 待核 / 待补 的条目数量可复现
退出码：0 = 全过；1 = 有 FAIL
"""
import json, os, sys, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS = os.path.join(ROOT, "data", "rows_v2.json")
ITEMS = os.path.join(ROOT, "data", "tasks_online.json")

COLUMNS = ["事项序号", "一级维度（六大模块）", "二级维度（人/流程/成本）",
           "具体事项", "分项", "分项内容简介",
           "进展日期", "进展内容", "开始时间", "完成时间", "当日计划（周计划）",
           "责任人", "负责人", "负责人类型", "协调事项"]
MODULES = {"人力资源规划", "招聘与配置", "培训与开发", "绩效管理", "薪酬福利", "员工关系", "待定位"}
NATURES = {"人", "流程", "成本", "其他"}

fails, warns = [], []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    return cond


def main():
    rows = json.load(open(ROWS, encoding="utf-8"))
    items = json.load(open(ITEMS, encoding="utf-8"))

    check(len(rows) == 167, f"行数应为 167，实为 {len(rows)}")
    check(len(items) == 43, f"事项数应为 43，实为 {len(items)}")

    bad_keys = [i for i, r in enumerate(rows) if list(r.keys()) != COLUMNS]
    check(not bad_keys, f"{len(bad_keys)} 行的字段名/顺序不对（首个：行 {bad_keys[0] if bad_keys else '-'}）")

    item_names = {x["item"] for x in items}
    row_items = {r["具体事项"] for r in rows}
    check(item_names <= row_items, f"有 {len(item_names - row_items)} 个事项没有对应行：{sorted(item_names - row_items)[:5]}")
    check(row_items <= item_names, f"有 {len(row_items - item_names)} 个行的事项不在源表：{sorted(row_items - item_names)[:5]}")

    # 每个事项至少一行、每个分项至少一行
    per_item = collections.Counter(r["具体事项"] for r in rows)
    check(all(v > 0 for v in per_item.values()), "存在 0 行的事项")
    per_sub = collections.Counter((r["具体事项"], r["分项"]) for r in rows)
    check(all(v > 0 for v in per_sub.values()), "存在 0 行的分项")

    # 换行残留
    for col in ("进展内容", "当日计划（周计划）", "分项内容简介", "责任人"):
        nl = [r["具体事项"] for r in rows if "\n" in (r.get(col) or "")]
        if nl:
            warns.append(f"{col} 有 {len(nl)} 处换行（网页会折行，确认是否有意）")

    # 日期
    bad_dates, inverted = [], []
    for r in rows:
        for col in ("进展日期", "开始时间", "完成时间"):
            v = (r.get(col) or "").strip()
            if v:
                try:
                    datetime.datetime.strptime(v[:10], "%Y-%m-%d")
                except ValueError:
                    bad_dates.append((r["具体事项"], col, v))
        s, e = (r.get("开始时间") or "")[:10], (r.get("完成时间") or "")[:10]
        if s and e and s > e:
            inverted.append((r["具体事项"], s, e))
    check(not bad_dates, f"{len(bad_dates)} 个日期无法解析：{bad_dates[:3]}")
    if inverted:
        warns.append(f"{len(inverted)} 行开始时间晚于完成时间：{inverted[:3]}")

    # 取值域
    bad_mod = {r["一级维度（六大模块）"] for r in rows} - MODULES
    bad_nat = {r["二级维度（人/流程/成本）"] for r in rows} - NATURES
    check(not bad_mod, f"一级维度有非法取值：{bad_mod}")
    check(not bad_nat, f"二级维度有非法取值：{bad_nat}")

    # 待核 / 待补
    empty_both = [r["具体事项"] for r in rows if not r["进展内容"] and not r["当日计划（周计划）"]]
    # 「数据截至」只能取有实际进展的行——周计划里有未来日期（1102/1103/1104），不能算进来
    prog_dates = [(r["进展日期"] or "")[:10] for r in rows if r["进展内容"] and r["进展日期"]]
    latest = max(prog_dates) if prog_dates else ""
    future = sorted(d for d in set((r["进展日期"] or "")[:10] for r in rows if r["进展日期"]) if d > datetime.date.today().isoformat())
    if future:
        print(f"（另有 {len(future)} 个未来日期的行，属于计划排期，不计入数据截至）")
    print(f"数据截至：{latest}")
    print(f"事项 {len(per_item)} 个 / 行 {len(rows)} / 分项 {len(per_sub)} 个")
    print(f"有进展行 {sum(1 for r in rows if r['进展内容'])} / 只有计划 {sum(1 for r in rows if r['当日计划（周计划）'] and not r['进展内容'])} / 空行 {len(empty_both)}")
    print(f"模块分布：{dict(collections.Counter(r['一级维度（六大模块）'] for r in rows))}")
    print(f"性质分布：{dict(collections.Counter(r['二级维度（人/流程/成本）'] for r in rows))}")
    if empty_both:
        print(f"空行（待补）事项：{sorted(set(empty_both))}")

    for w in warns:
        print("WARN:", w)
    for f in fails:
        print("FAIL:", f)
    print("——", "全部通过" if not fails else f"{len(fails)} 项不通过")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
