# API 契约 · 多用户 / 写进度 / 建任务 / 进度面板

> 本文件是**前后端唯一约定**。后端按本文实现 API，前端按本文调用，两者并行开发。
> 设计依据：`docs/交互方案-身份与写入.md`（用户体验设计师方案）。

## 0. 总体形态

单进程服务，同时提供**静态页面**与**JSON API**，一个端口：

```
python3 server.py            # 默认 http://127.0.0.1:8787
PORT=9000 python3 server.py  # 换端口
```

- 零第三方依赖：只用 Python 标准库（`http.server` / `sqlite3` / `json` / `urllib` / `hmac` / `subprocess`）。
- 静态文件从仓库根目录直接伺服（`index.html` / `styles.css` / `app.js` / `data/rows.js`）。
- **源表 = 企业微信在线表格**《集团人力近期重点工作进度表》的子表「**重点工作进度 v2**」（15 列）。读和写都走它，网页不是另一份真相源。

### 0.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HPS_SECRET` | `dev-secret-change-me` | 会话签名密钥，**上线必须改** |
| `PORT` | `8787` | 监听端口 |
| `HPS_SHEET_ADAPTER` | `cli` | `cli`＝用本机 `wecom-cli` 读写源表；`file`＝只读本地 `data/rows_v2.json`（无企微环境时的降级，写操作会返回 501） |
| `HPS_WECOM_DOCID` | `e3_ARsADAagAHQCNea2Y2u1wSA00hrX0` | 源表 docid |
| `HPS_WECOM_SHEET_TITLE` | `重点工作进度 v2` | 源表子表名 |
| `HPS_BACKUP_WINDOW_DAYS` | `90` | 补录窗口（更早需 admin） |

## 1. 数据存储

SQLite 文件 `data/app.db`（首次启动自动建表 + 灌种子成员）。**不存业务数据**，业务数据在源表；这里只存身份、映射、审计、队列。

```sql
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,          -- 显示名，与源表姓名一致
  userid TEXT,                        -- 企微 userid，可空（未匹配到人）
  role TEXT NOT NULL DEFAULT 'editor',-- admin | editor | viewer
  scope TEXT NOT NULL DEFAULT 'all',  -- all | modules | self
  modules TEXT,                       -- scope=modules 时的模块名，逗号分隔
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

CREATE TABLE name_map (               -- 源表姓名 → 成员（权限判定用）
  name TEXT PRIMARY KEY,
  member_id INTEGER,
  confidence TEXT,                    -- exact | manual | stale | none
  note TEXT
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT, actor_userid TEXT,
  action TEXT,                        -- progress.append | task.create | progress.void | member.update
  target TEXT,
  payload TEXT,                       -- JSON 字符串
  result TEXT                         -- ok | rejected | conflict | queued
);

CREATE TABLE voided (                 -- 作废标记（源表只 append，不能删行）
  id INTEGER PRIMARY KEY,
  sheet_key TEXT NOT NULL,            -- 事项名|分项|日期
  voided_by TEXT, voided_at TEXT, reason TEXT
);

CREATE TABLE queue (                  -- 写入失败/离线时的待重放队列
  id INTEGER PRIMARY KEY,
  ts TEXT, actor TEXT, action TEXT, payload TEXT,
  status TEXT,                        -- pending | done | failed
  last_error TEXT
);
```

**种子成员**（来自源表实际出现的 13 个姓名 + 角色分配）：

| 姓名 | 角色 | 备注 |
|---|---|---|
| 陈信克 | admin | 负责人，出现 38 次 |
| 刘玉文 | admin | 负责人，出现 5 次 |
| 汪洋 | editor | 责任人 17 项 |
| 盛琳莺 | editor | 责任人 16 项 |
| 倪国楷 / 黄法 / 蒋成 / 李雪 / 汤素琴 / 蔡宇翔 / 朱彦隽 | editor | 责任人各 1–3 项 |
| 各机构人力负责人 | editor | **非自然人**：userid 为空，按规则只能由负责人/admin 代写 |

`name_map` 首次启动时用成员表初始化（exact），`各机构人力负责人` 标记 `nonPerson`。

## 2. 身份与会话

- 登录：`POST /api/login` `{"name":"汪洋"}` → 校验在 `members` 里 → 下发 HttpOnly cookie `hpsid`（HMAC-SHA256 签名，含 name + 过期时间；**不是**真会话存储，够单机内网用）。
- 未登录：只读可读数据（`/api/data`），所有写接口返回 `401 {"error":"unauthenticated"}`。
- 企业微信 OAuth 是**预留位**：登录页保留「用企业微信登录」按钮，接口未实现时返回 `501 {"error":"wecom_oauth_not_enabled"}`，**不要伪造成功**。

### 2.1 权限判定（唯一规则，前后端都要实现）

```
canWrite(item, me) =
      me.role != 'viewer'
  AND ( me.role == 'admin'
        OR me.name ∈ splitNames(item.责任人)
        OR me.name == item.负责人 )

splitNames(s) = 按 \n 、 ， , 、； 分隔后去空白
```

- 姓名匹配**精确**（源表姓名就是成员名）。匹配不上 → 不可写。
- 非自然人责任人（`各机构人力负责人`）匹配不到任何自然人 → 该事项可写人只有负责人 + admin。
- 前端**没有写权限的按钮一律不渲染**（不用 disabled）。

### 2.2 数据范围（scope）

| scope | 含义 | 生效位置 |
|---|---|---|
| `all` | 全部可见 | 默认 |
| `modules` | 只见 `members.modules` 列出的模块 | **服务端过滤**（前端拿到的行就少了） |
| `self` | 只见自己是责任人/负责人的事项 | 同上 |

面板的 KPI / 模块表 / 责任人表 / 逾期 / 本周动态**全部按可见集合重算**。

## 3. API

所有响应 `Content-Type: application/json; charset=utf-8`。错误统一 `{"error":"...","detail":"..."}`。

### 3.1 `GET /api/session`

```json
{
  "me": {"name":"汪洋","role":"editor","userid":"","canWriteCount":17,"scope":"all"},
  "members": [{"name":"陈信克","role":"admin","scope":"all","canWriteCount":43}],
  "serverTime": "2026-10-24T14:40:00+08:00",
  "dataStamp": "2026-10-24",
  "adapter": "cli",
  "capabilities": {"write": true, "createTask": true, "admin": false}
}
```

未登录时 `me` 为 `null`，`capabilities` 全 false。

### 3.2 `POST /api/login`

请求 `{"name":"汪洋"}` → `200 {"ok":true,"me":{...}}` + `Set-Cookie: hpsid=...; HttpOnly; SameSite=Lax; Path=/`
未知姓名 → `404 {"error":"unknown_member","detail":"成员表中没有这个人"}`

### 3.3 `GET /api/data`

返回当前可见集合的完整数据（前端三视图直接用它）：

```json
{
  "rows": [ {"事项序号":1,"一级维度（六大模块）":"薪酬福利", "…共 15 个键，顺序与源表一致"} ],
  "items": [ {"seq":1,"item":"销售提点","module":"薪酬福利","nature":"成本","start":"2026-10-12","end":"2026-10-22","owner":"黄法","lead":"陈信克","leadType":"B","coord":"","subs":["茅森提点","恐龙提点","聚力提点"]} ],
  "generatedAt": "2026-10-24T14:00:07+08:00",
  "dataStamp": "2026-10-24",
  "pending": {"待核": 5, "待补": 1},
  "visibleCount": 43
}
```

- 读源表失败 → `503 {"error":"sheet_unavailable"}`，前端回落读本地 `data/rows.js`。
- `file` 适配器下数据来自 `data/rows_v2.json`。

### 3.4 `POST /api/progress`（最高频）

请求：

```json
{"item":"销售提点","sub":"茅森提点","date":"2026-10-24","progress":"已提报董事长，待确认","plan":""}
```

- `progress` 与 `plan` 至少一个非空。
- `date` 必须在 `[今天 - BACKUP_WINDOW_DAYS, 今天]` 之内；越界 → `422 {"error":"date_out_of_window"}`。
- `sub` 必须属于该事项的分项集合；单分项事项可省略（等于事项名）。
- 权限：`canWrite(item, me)` 为假 → `403 {"error":"no_write_permission"}`。
- 成功：`200 {"ok":true,"appended":true,"row":{...新行...}}` —— **向源表「重点工作进度 v2」追加一行**（15 列，顺序见 §5）。
- 源表写失败 → `202 {"ok":false,"queued":true,"queueId":12}`（进 `queue` 表待重放），**不丢数据**。
- 幂等：同一 `(item, sub, date, progress, plan)` 已在源表存在 → `200 {"ok":true,"appended":false,"duplicate":true}`。

### 3.5 `POST /api/tasks`

请求：

```json
{"module":"人力资源规划","nature":"人","item":"新事项名",
 "subs":[{"name":"分项一","intro":"一句话说明"}],
 "start":"2026-10-24","end":"2026-11-05",
 "owner":["汪洋"],"lead":"陈信克","leadType":"B","coord":"","note":"仅 admin 可见的备注"}
```

- `item` **全局唯一**，重名 → `409 {"error":"duplicate_item"}`。
- `module` 必须是六大模块 + 待定位；`nature` 必须是 人/流程/成本/其他。
- `leadType` 只能是源表已出现过的值（当前只有 `B`）；空串允许。
- `coord`（协调事项）**不接受自由输入**：非空 → `422 {"error":"coord_not_open"}`。
- editor 只能在自己是责任人的模块下建任务（`modules` 集合 ⊆ 自己可见模块）→ 否则 `403 {"error":"module_not_allowed"}`。
- 成功：`200 {"ok":true,"item":"新事项名","appendedRows":1}` —— 源表为**每个分项追加一行**（首行带 `进展日期`=开始时间、`进展内容`="（待补）"、`事项序号`=**空串**，不占号）。
- `note` 只进 `audit`，**不进源表**（源表没有这一列）。

### 3.6 `POST /api/void`（作废）

请求 `{"item":"销售提点","sub":"茅森提点","date":"2026-10-12","reason":"填错了"}`

- 仅 admin，或作者本人且 24h 内写入 → 否则 `403`。
- 软删：在 `voided` 表登记，并向源表**追加一行作废标记**（`进展内容` = `【作废】<原内容>`），源表里能看到「有一条被作废」而不是凭空少一行。
- 成功 `200 {"ok":true}`。

### 3.7 `GET /api/panel`

按当前可见集合聚合：

```json
{
  "scope": {"label":"全部 43 个事项","count":43},
  "kpi": {
    "overdue": {"n":7,"worstDays":9},
    "dueDone": {"done":8,"due":15},
    "weekActivity": {"n":20,"items":15,"byActor":{"盛琳莺":10,"汪洋":4}},
    "stale": {"n":29,"worstDays":16,"neverUpdated":1}
  },
  "byModule": [{"module":"人力资源规划","count":13,"done":2,"doing":8,"overdue":3,"week":6}],
  "byOwner":  [{"owner":"汪洋","count":17,"doing":13,"overdue":1,"week":4,"lastUpdate":"2026-10-24","nonPerson":false}],
  "overdue":  [{"item":"…","owner":"…","overdueDays":3,"lastProgress":"2026-10-20","canWrite":true}],
  "weekActivity": [{"date":"2026-10-24","entries":[{"item":"…","actor":"汪洋","progress":"…","canWrite":true}]}]
}
```

口径（必须与现有页面一致）：

- **已完成** = 存在一条非空进展，其日期 ≥ 该事项的完成时间
- **逾期** = 今天已过完成时间，且不存在上述进展
- **进行中** = 其余
- **到期** = 完成时间 ≤ 今天；**「到期完成 8/15」的分母是已到期 15 项，不是 43**
- **本周** = 周一至周日
- **7 天无进展** = 末次非空进展距今 ≥ 7 天（含从未有进展的）

### 3.8 `GET /api/queue`（admin）

返回待重放队列 `[{id,ts,actor,action,payload,status,last_error}]`。

## 4. 源表读写

- 读：企微在线表格 docid `e3_ARsADAagAHQCNea2Y2u1wSA00hrX0` → 子表「重点工作进度 v2」。
  - `cli` 适配器：`wecom-cli sheet ranges get --docid … --sheet-id … --range "A1:O<rows>" --mode default`。
  - **必须按子表标题定位**（v2 工作表插在第 1 位，不能用 `sheets[0]`）。
- 写：向该子表**末尾追加行**（优先 `wecom-cli sheet cells append`；不可用时 `cells batchset` 到 `A{lastRow+1}`）。
- 追加的 15 列顺序（必须一致）：

```
事项序号 | 一级维度（六大模块） | 二级维度（人/流程/成本） | 具体事项 | 分项 | 分项内容简介
| 进展日期 | 进展内容 | 开始时间 | 完成时间 | 当日计划（周计划） | 责任人 | 负责人 | 负责人类型 | 协调事项
```

- **只 append，不改已有行**（源表是多人共编，改行会覆盖别人的手改）。
- 新建任务时 `事项序号` 写**空串**（源表序号已撞号，不再自动分配）。

## 5. 前端要做的四件事（与专家方案一致）

1. **身份胶囊**：页头右侧，姓名 + 角色徽标 + 「可写 N 个事项」；无写权限的按钮**不渲染**。
2. **记一笔进展**：`#/progress` 抽屉/弹层。桌面居中弹层、移动端 `100dvh` 底部抽屉。**最小输入路径 2 次交互**：选事项（可由入口带入）→ 写内容 → 保存。日期默认今天（`max=今天`，`min=今天-90天`）。单分项事项的分项只读 chip（不给下拉）。「同时记一条当天计划」默认不勾。输入框 `font-size:16px`，按钮 44px，底部条 `padding-bottom: env(safe-area-inset-bottom)`，用 `visualViewport` 把键盘高度写进 `--kb` 并 `translateY(-var(--kb))`。保存成功给绿条提示 +「保存并继续下一条」。
3. **新建任务**：`#/new-task` 全屏页，12 字段（见专家方案 §3.1）。级联：模块 →（按模块过滤的）性质 → 事项（可搜索，可新建，重名报错）→ 分项（作用域=所选事项，默认=事项名）。**负责人类型只列源表已有值（当前只有 B）且不解释含义；协调事项控件禁用并写明「口径待定，暂不开放填写」**。右侧实时预览 + 「工期 N 天」。
4. **进度面板**：第 4 个 tab `#panel`。四张 KPI 卡（逾期 / 到期完成 8/15 / 本周更新 / 7 天无进展）+ ①按模块 ②按责任人 ③逾期项 ④本周动态。**故意不显示"完成率"**（分母是已到期项，不是 43）。面板头常驻作用域提示。模块行可点击下钻回事项视图（筛选联动）。移动端：KPI 2×2，模块/责任人表保持横滚表格不转卡片。

## 6. 离线与冲突

- 写失败 → 后端进 `queue`；前端同时把请求体存 `localStorage`，页面显示「N 条待同步」。
- 恢复联网后前端 `POST /api/queue/replay`（逐条重放）或用户手动点「重试」。
- 冲突定义：源表是多人共编的，网页写入与人在表格里直接改可能撞。
  冲突文案必须说清三件事：**冲突了什么 / 我的内容没有写入 / 下一步怎么办**，给三个动作：查看差异 / 以源表为准 / 重新提交。
  实现上：因为只 append，**同一 (item, sub, date) 已有别人的行**时视为冲突 → `409 {"error":"conflict","existing":{...}}`。
