#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从企业微信在线表格《集团人力近期重点工作进度表》抽取当前数据。

在线表格「工作表1」结构（注意：今天被重排 + 粘贴过，列对齐不统一）：
  标准行（A序号 B分类 C分组 D事项 E概要 F进展 G周计划 H开始 I完成 J责任人 K负责人 L类型 M协调）
  粘贴行（A序号 B分类 C事项 D空   E概要 F进展 ...）——事项名落在 C 列
所以事项名取法：D 非空取 D；否则 C 非空且 E 非空时取 C。
B/C 在旧表里是纵向合并单元格，只有首行有值 → 向下填充（这正是要避免的合并）。
输出：tasks_online.json（与 tasks.json 同构，供 build_rows.py 使用）
"""
import json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCID = "e3_ARsADAagAHQCNea2Y2u1wSA00hrX0"
SOURCE_SHEET = "工作表1"
OUT = os.path.join(ROOT, "data", "tasks_online.json")


def ranges_get(docid, sheet_id, rng, mode="default"):
    p = subprocess.run(["wecom-cli", "sheet", "ranges", "get", "--docid", docid,
                        "--sheet-id", sheet_id, "--range", rng, "--mode", mode],
                       capture_output=True, text=True)
    raw = p.stdout
    raw = raw[raw.find("{"):]
    try:
        return json.loads(raw)
    except Exception:
        print("PARSE FAIL", rng, raw[:300])
        return {}


def txt(c):
    v = (c or {}).get("cell_value") or {}
    if "text" in v:
        return v["text"] or ""
    if "number" in v:
        n = v["number"]
        return str(int(n)) if float(n).is_integer() else str(n)
    if "time" in v:
        t = v["time"]
        return f"{t['year']:04d}-{t['month']:02d}-{t['day']:02d} {t.get('hour',0):02d}:{t.get('minute',0):02d}:{t.get('second',0):02d}"
    return ""


def to_iso(s):
    s = (s or "").strip()
    if not s or s in ("/", "-", "—", " "):
        return ""
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d} 00:00:00"
    m = re.search(r"(\d{1,2})[月/-](\d{1,2})", s)
    if m:
        return f"2026-{int(m.group(1)):02d}-{int(m.group(2)):02d} 00:00:00"
    return ""


def main():
    p = subprocess.run(["wecom-cli", "sheet", "get", "--json",
                        json.dumps({"docid": DOCID})], capture_output=True, text=True)
    raw = p.stdout
    raw = raw[raw.find("{"):]
    d = json.loads(raw)
    sheets = d.get("sheets") or []
    # 按标题定位「工作表1」；新工作表插在第 1 位，不能再用 sheets[0]
    pick = None
    for s0 in sheets:
        if s0.get("title") == SOURCE_SHEET:
            pick = s0
            break
    if pick is None:
        pick = max(sheets, key=lambda s0: s0.get("column_count", 0))
    sheet_id = pick["sheet_id"]
    nrows = pick.get("row_count", 200)
    print("源工作表:", pick.get("title"), sheet_id, "行", nrows, "列", pick.get("column_count"))

    rows = []
    step = 100
    for start in range(0, nrows, step):
        end = min(start + step, nrows)
        d2 = ranges_get(DOCID, sheet_id, f"A{start+1}:M{end}")
        grid = d2.get("grid_data") or {}
        for r in grid.get("rows") or []:
            rows.append([txt(c) for c in (r.get("values") or [])])
    print("读取行数:", len(rows))

    data = []
    cat = group = ""
    for line in rows[3:]:
        line = (list(line) + [""] * 13)[:13]
        seq, c1, c2, dcol, summary, prog, week, start, end, owner, lead, typ, coord = line
        if dcol.strip():
            item, grp = dcol.strip(), c2.strip()
        elif c2.strip() and summary.strip():
            item, grp = c2.strip(), ""
        else:
            continue
        if c1.strip():
            cat = c1.strip()
        if grp:
            group = grp
        data.append({
            "seq": int(float(seq)) if seq.strip() else None,
            "cat": cat, "group": group,
            "item": item, "summary": summary.strip(),
            "progress": prog.strip(), "week": week.strip(),
            "start": to_iso(start), "end": to_iso(end),
            "owner": owner.strip(), "lead": lead.strip(),
            "typ": typ.strip(), "coord": coord.strip(),
        })
    for i, x in enumerate(data, 1):
        if x["seq"] is None:
            x["seq"] = i

    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("抽取事项数:", len(data), "→", OUT)

    old = "/tmp/tasks.json"
    if os.path.exists(old):
        oldd = {x["item"]: x for x in json.load(open(old, encoding="utf-8"))}
        newd = {x["item"]: x for x in data}
        added = [k for k in newd if k not in oldd]
        removed = [k for k in oldd if k not in newd]
        changed = []
        for k in newd:
            o = oldd.get(k)
            if not o:
                continue
            for f in ("progress", "week", "summary", "start", "end", "owner", "lead", "coord"):
                if (o.get(f) or "").strip() != (newd[k].get(f) or "").strip():
                    changed.append((k, f))
        print(f"新增 {len(added)}: {added}")
        print(f"移除 {len(removed)}: {removed}")
        print(f"内容有变化: {changed}")


if __name__ == "__main__":
    main()
