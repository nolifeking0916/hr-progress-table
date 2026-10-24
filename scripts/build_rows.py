#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把《集团人力近期重点工作进度表》展开成 v2 长表行数据。

输入：tasks_online.json（默认，从企业微信在线表格抽取）/ tasks.json（旧快照）
输出：rows_v2.json
行规则：
    行 = 事项 × 分项 × 日期
    - 有进展的 (分项, 日期) → 一行，带当天进展内容
    - 只有计划、没有进展的 (事项, 日期) → 一行，分项=主分项，进展内容留空
    - 同一 (事项, 日期) 的计划只出现一次：优先挂在当天的第一条进展行上
归属表按「事项名」索引——源表被重排/增删后仍然对得上。
"""
import json, re, os, datetime, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "tasks_online.json")
OUT = os.path.join(ROOT, "data", "rows_v2.json")
YEAR = 2026

MODULES = ["人力资源规划", "招聘与配置", "培训与开发", "绩效管理", "薪酬福利", "员工关系", "待定位"]
NATURES = ["人", "流程", "成本", "其他"]

# 「4 个制度、6 个细则」的具体名单
# 来源：make_wecom_smartsheet.py 的《制度（试行稿）征求意见收集表》DOCS 清单，数目与概要完全吻合
POLICY = [
    ("部门设置标准细则（7-1）", "人力资源规划"),
    ("员工作休细则（7-31）", "员工关系"),
    ("招聘管理制度（9-0）", "招聘与配置"),
    ("绩效考核管理制度（11-0）", "绩效管理"),
    ("绩效考核细则（11-2）", "绩效管理"),
    ("薪酬管理制度（12-0）", "薪酬福利"),
    ("晋升管理制度（36-0）", "人力资源规划"),
    ("O序列员工晋升管理细则（36-1）", "人力资源规划"),
    ("P序列员工晋升管理细则（36-2）", "人力资源规划"),
    ("M序列员工晋升管理细则（36-3）", "人力资源规划"),
]
POLICY_SUMMARY = ("4 个制度 + 6 个细则（逐项归口已定位，待补逐项进展）："
                  "部门设置标准细则（7-1）→人力资源规划；员工作休细则（7-31）→员工关系；"
                  "招聘管理制度（9-0）→招聘与配置；绩效考核管理制度（11-0）、绩效考核细则（11-2）→绩效管理；"
                  "薪酬管理制度（12-0）→薪酬福利；晋升管理制度（36-0）、O/P/M 序列员工晋升管理细则（36-1/2/3）→人力资源规划")
POLICY_SUB = "主要人力制度（4 制度 6 细则）"
POLICY_ITEMS = {"优化及发布试行稿", "收集意见、评估", "审批发布并更新制度库"}

# 事项级归属：事项名 -> (一级维度, 二级维度)
OWN = {
    "优化及发布试行稿": ("待定位", "流程"),
    "收集意见、评估": ("待定位", "流程"),
    "审批发布并更新制度库": ("待定位", "流程"),
    "销售提点": ("薪酬福利", "成本"),
    "积分制评估": ("绩效管理", "流程"),
    "高温、低温补贴": ("薪酬福利", "成本"),
    "全员营销": ("薪酬福利", "成本"),
    "确定保留项目及发放方式": ("薪酬福利", "成本"),
    "研创院、工程绩考核方案确定": ("绩效管理", "流程"),
    "集团其他制度、细则修订发布并更新制度库": ("待定位", "流程"),
    "各机构制度、细则修订发布并更新制度库": ("待定位", "流程"),
    "各机构绩效考核方案": ("绩效管理", "流程"),
    "办公配置标准、住宿标准梳理": ("员工关系", "流程"),
    "武进人力成本比较分析": ("人力资源规划", "成本"),
    "浙江营销编制、薪资盘点分析": ("人力资源规划", "人"),
    "余休调休工作分析": ("员工关系", "人"),
    "MP序列岗位学历标准优化": ("人力资源规划", "流程"),
    "MP序列称职度评估": ("人力资源规划", "人"),
    "一本人员访谈": ("人力资源规划", "人"),
    "候选人分析前置": ("招聘与配置", "流程"),
    "调薪调级流程审批及闭合": ("薪酬福利", "流程"),
    "核心人员离职评估报告定稿及发布": ("员工关系", "流程"),
    "常态化管理": ("员工关系", "流程"),
    "员工信息档案完善": ("员工关系", "人"),
    "部门合并落实": ("人力资源规划", "流程"),
    "职位职级调整：内网、企微职务职级实时更新": ("人力资源规划", "流程"),
    "后台月薪标准调整：企微“薪酬绩效”板块取消管理层年薪”显示，增加最新调岗调薪结果显示": ("薪酬福利", "流程"),
    "后台职级薪资体系调整：企微“薪酬绩效”板块的“晋升通道”按最新职级体系更新显示": ("薪酬福利", "流程"),
    "后台编制、待招岗位匹配：增加待招岗位职务职级录入端口，手工录入，体现到编制统计表中，可按机构按职级查看待招聘岗位": ("招聘与配置", "人"),
    "会议组织安排": ("培训与开发", "人"),
    "闭卷考试及通报": ("培训与开发", "人"),
    "问卷调研及分析": ("培训与开发", "人"),
    "分层级宣贯落实": ("培训与开发", "人"),
    "机构一把手岗位称职度盘点": ("人力资源规划", "人"),
    "储备干部编制及后续管理计划": ("人力资源规划", "人"),
    "火线提拔计划落实": ("人力资源规划", "人"),
    "猎头合作拓展及协议签订": ("招聘与配置", "流程"),
    "招聘负责人外招到岗": ("招聘与配置", "人"),
    "关键岗位招聘策略及计划": ("招聘与配置", "人"),
    "M、P序列培训计划发布": ("培训与开发", "人"),
    "编制合理性评估及优化计划": ("人力资源规划", "人"),
    "P序列定级标准": ("人力资源规划", "流程"),
    "P序列胜任力评估选聘标准": ("人力资源规划", "流程"),
}

# 分项展开：只拆「源文本点名了子项」的事项；其余分项 = 事项名
SPLIT = {
    "销售提点": ["茅森提点", "恐龙提点", "聚力提点"],
    "研创院、工程绩考核方案确定": ["研创院考核方案", "工程考核方案"],
    "职位职级调整：内网、企微职务职级实时更新": ["行政管理中心", "财务和创建", "其余机构"],
    "后台月薪标准调整：企微“薪酬绩效”板块取消管理层年薪”显示，增加最新调岗调薪结果显示": ["集团本部", "创建部", "其余机构"],
}

# 进展逐分项归属（源文本点名到子项时，手工切分到子项粒度）
PROG = {
    "销售提点": [("1010", "茅森提点", "已提报董事长，待确认"),
                 ("1010", "恐龙提点", "已提报董事长，待确认"),
                 ("1012", "聚力提点", "已提报董事长，待确认")],
    "研创院、工程绩考核方案确定": [("1018", "研创院考核方案", "完成研创院考核方案初稿"),
                                   ("1024", "工程考核方案", "完成工程管理分公司考核方案初稿，均已提报文婷，待确认")],
    "职位职级调整：内网、企微职务职级实时更新": [
        ("1018", "行政管理中心", "已完成复核"),
        ("1018", "财务和创建", "需核查"),
        ("1018", "其余机构", "待抽查"),
        ("1019", "财务和创建", "已完成财务管理中心及创建事业部核查"),
        ("1022", "其余机构", "各机构抽查已完成")],
    "后台月薪标准调整：企微“薪酬绩效”板块取消管理层年薪”显示，增加最新调岗调薪结果显示": [
        ("1018", "集团本部", "已完成系统后台调整"),
        ("1018", "创建部", "待核查"),
        ("1018", "其余机构", "待抽查"),
        ("1019", "财务和创建", "已完成财务管理中心及创建事业部核查"),
        ("1022", "其余机构", "各机构抽查已完成")],
}

DATE_TYPO = {"1118": "1018"}
NOTES = []   # 清洗/存疑记录


def md_to_date(mmdd):
    return datetime.date(YEAR, int(mmdd[:2]), int(mmdd[2:]))


def norm_mmdd(tok):
    """笔误归一：1118→1018；20xx→10xx（1021/1023/1025 写成 2021/2023/1025）"""
    tok = DATE_TYPO.get(tok, tok)
    if tok.startswith("20"):
        tok = "10" + tok[2:]
    return tok


def strip_marker(s):
    return re.sub(r"^\s*\d+\s*[、.）)]\s*", "", s)


def parse_progress(seq, item, text, subs, start_mmdd):
    out = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^(\d{4})", line)
        if m:
            mmdd = norm_mmdd(m.group(1))
            body = line[4:].strip()
        else:
            mmdd = start_mmdd
            body = line
            NOTES.append({"seq": seq, "item": item, "kind": "进展无日期", "raw": line,
                          "处理": f"按开始时间 {start_mmdd} 落行，标待核"})
        sub = None
        for s in subs:
            if s in body:
                sub = s
                break
        if sub is None:
            sub = subs[0]
        content = body
        for sep in ("：", ":"):
            if sep in body:
                left, right = body.split(sep, 1)
                if left.strip() in subs:
                    sub, content = left.strip(), right.strip()
                break
        out.append((mmdd, sub, content))
    return out


def parse_plan(seq, item, text, start_mmdd):
    out = collections.OrderedDict()
    for raw in text.split("\n"):
        line = strip_marker(raw.strip())
        if not line or line in ("/", "-", "—", "无", " "):
            continue
        m = re.match(r"^(\d{4})\s*[-—~至]\s*(\d{4})", line)
        if m:
            a = md_to_date(norm_mmdd(m.group(1)))
            b = md_to_date(norm_mmdd(m.group(2)))
            body = line[m.end():].strip()
            d = a
            while d <= b:
                out.setdefault(d.strftime("%m%d"), []).append(body)
                d += datetime.timedelta(days=1)
            continue
        m2 = re.match(r"^(\d{4})", line)
        if not m2:
            NOTES.append({"seq": seq, "item": item, "kind": "计划无日期", "raw": line,
                          "处理": "按开始时间落行，标待核"})
            out.setdefault(start_mmdd, []).append(line)
            continue
        mmdd = norm_mmdd(m2.group(1))
        body = line[m2.end():].strip()
        out.setdefault(mmdd, []).append(body)
    return {k: "；".join(v) for k, v in out.items()}


def main():
    tasks = json.load(open(SRC, encoding="utf-8"))
    rows = []
    per_seq = collections.Counter()
    unmapped = []

    for t in tasks:
        seq = t["seq"]
        item = t["item"]
        summary = t["summary"]
        if item in OWN:
            mod, nat = OWN[item]
        else:
            mod, nat = "待定位", "其他"
            unmapped.append(item)

        if item in POLICY_ITEMS:
            subs = [POLICY_SUB]
            mod = "待定位"
            sub_mod = {POLICY_SUB: mod}
            sub_intro = {POLICY_SUB: POLICY_SUMMARY}
        else:
            subs = SPLIT.get(item, [item])
            sub_mod = {s: mod for s in subs}
            sub_intro = {s: summary for s in subs}

        start = t["start"]
        end = t["end"]
        start_mmdd = (start[5:7] + start[8:10]) if start else "1024"

        if item in PROG:
            prog = list(PROG[item])
        else:
            prog = parse_progress(seq, item, t["progress"], subs, start_mmdd)
        plan = parse_plan(seq, item, t["week"], start_mmdd)

        by_date = collections.OrderedDict()
        for mmdd, sub, content in prog:
            by_date.setdefault(mmdd, []).append((sub, content))

        all_dates = sorted(set(list(by_date.keys()) + list(plan.keys())), key=md_to_date)
        if not all_dates:
            all_dates = [start_mmdd]
            NOTES.append({"seq": seq, "item": item, "kind": "进展与计划均无",
                          "raw": "(空)", "处理": f"按开始时间 {start_mmdd} 落一行，内容待补"})
        for mmdd in all_dates:
            prog_list = by_date.get(mmdd, [])
            pl = plan.get(mmdd, "")
            if prog_list:
                for i, (sub, content) in enumerate(prog_list):
                    rows.append({
                        "事项序号": seq, "一级维度（六大模块）": sub_mod.get(sub, mod),
                        "二级维度（人/流程/成本）": nat, "具体事项": item, "分项": sub,
                        "分项内容简介": sub_intro.get(sub, summary),
                        "进展日期": f"{YEAR}-{mmdd[:2]}-{mmdd[2:]} 00:00:00",
                        "进展内容": content, "开始时间": start, "完成时间": end,
                        "当日计划（周计划）": pl if i == 0 else "",
                        "责任人": t["owner"], "负责人": t["lead"],
                        "负责人类型": t["typ"], "协调事项": t["coord"]})
                    per_seq[seq] += 1
            else:
                rows.append({
                    "事项序号": seq, "一级维度（六大模块）": sub_mod.get(subs[0], mod),
                    "二级维度（人/流程/成本）": nat, "具体事项": item, "分项": subs[0],
                    "分项内容简介": sub_intro.get(subs[0], summary),
                    "进展日期": f"{YEAR}-{mmdd[:2]}-{mmdd[2:]} 00:00:00",
                    "进展内容": "", "开始时间": start, "完成时间": end,
                    "当日计划（周计划）": pl,
                    "责任人": t["owner"], "负责人": t["lead"],
                    "负责人类型": t["typ"], "协调事项": t["coord"]})
                per_seq[seq] += 1

    json.dump(rows, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("总行数:", len(rows))
    print("按模块:", dict(collections.Counter(r["一级维度（六大模块）"] for r in rows)))
    print("按性质:", dict(collections.Counter(r["二级维度（人/流程/成本）"] for r in rows)))
    print("有进展行:", sum(1 for r in rows if r["进展内容"]))
    print("只有计划的行:", sum(1 for r in rows if not r["进展内容"] and r["当日计划（周计划）"]))
    print("空行:", sum(1 for r in rows if not r["进展内容"] and not r["当日计划（周计划）"]))
    print("事项覆盖:", len(per_seq), "单事项行数区间:", min(per_seq.values()), "-", max(per_seq.values()))
    if unmapped:
        print("!! 未映射归属的事项:", unmapped)
    print("--- 清洗备注 ---")
    for n in NOTES:
        print(n)
    print("输出:", OUT)


if __name__ == "__main__":
    main()
