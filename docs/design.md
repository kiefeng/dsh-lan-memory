# dsh-lan-memory v2 实施计划

> 制定日期：2026-10-22 ｜ 目标宿主：DSH Desktop 0.2.1-rc.2（Node 24.21.0）
> 前置调研：[评估报告](../dsh-lan-memory-评估报告.md)、[源码审计](01-lan-memory-audit.md)、[竞品横评](02-plugin-landscape.md)、[平台能力](03-platform-capabilities.md)
> v1 源码：`../dsh-lan-memory-master/`（2026-08-17 最后一次提交）

---

## 一、定位（先定不做什么）

**v2 = 个人自用的「本地记忆 + 人格/情绪」层。不参与通用记忆插件竞争。**

不做：

- ❌ Python/Node 常驻服务、Docker、Neo4j/Qdrant/LanceDB、embedding/向量检索
- ❌ 需要外部 API Key 的后台 LLM 抽取（EverOS/MemOS 的重量所在）
- ❌ MCP 桥接（dsh-memos-bridge 那条路的代价是养一整套栈 + 改上游源码）
- ❌ 自动、不可见的记忆改写（整理必须是显式、可干跑、可回滚的动作）
- ❌ 每工作区独立库（本次确认：全局一份）

保留：

- ✅ 三层记忆（pinned / memory / experience）
- ✅ SOUL 人格 + MOOD 情绪状态池
- ✅ 可管理 / 可修改 / 可整理（设置页入口 + 独立面板）
- ✅ 纯本地文件、零运行时依赖、JSONL/Markdown 可读可手改

三条设计原则：

1. **文件是唯一真源**；索引、视图、缓存都是可删可重建的派生物。
2. **捕获便宜到可以无脑开，整理贵到必须由人/模型显式点头**。
3. **人格常量、记忆增量、MOOD 每轮变量走三条独立注入预算**；整理只能动记忆。

---

## 二、竞品对标结论（含"memos"口径）

> 口径说明：你提到的 "memos" 我按 **MemOS / dsh-memos-bridge** 理解（DSH 生态里叫 memos 的记忆插件实际是 MemOS MCP 桥）。若你指的是 Memos 笔记应用，请纠正，方案里"跨应用笔记同步"需另加一节。

| 对象 | 真正强的地方 | 代价 / 短板 | v2 取什么、舍什么 |
|---|---|---|---|
| **EverOS**（EverMind） | Markdown 真源；捕获只落盘不调 LLM、flush 六条件延迟整理；user/agent 五维隔离；来源标注 + 围栏防自喂养；fail-open | Python 3.12 服务 + OpenRouter key + SQLite/LanceDB；**无管理 UI、无 remember/forget 工具**；DSH 插件只声明支持 0.1.x，本机 0.2.1 装不上 | 取：capture→flush 生命周期、Markdown 可读真源、来源标注、fail-open；舍：Python 服务、外部 key、向量库 |
| **MemOS / dsh-memos-bridge** | 图 + 向量 + 记忆调度 + Cube 分区；"零改 Harness、只加一层 MCP patch" | Docker（Neo4j+Qdrant）+ venv + 上游 5 处源码补丁 + LLM/Embedding 网关 | 只取"分区（scope/tag）"概念；舍整栈 |
| **dsh-memory-board** | 写盘五步护栏（指纹→幂等→改前备份→tmp+rename→复核）；只读默认、删除要原样打出编号 | 管的是人写日记，不是 agent 记忆；无自动捕获 | 取：写盘护栏、改前备份、危险操作二次确认 |
| **dsh-memory-md** | 两段式注入（`section()` 常量 + `context()` 读盘）；`{{` 中和；user/project 双域 + 阈值触发 | 轮末后台 LLM 调用；设置页刻意不列条目 | 取：注入分通道、`interpolate:false` 卫生；舍：后台 LLM |
| **@fooxe/dsh-memory** | `MEMORY.md` 索引守卫、user/project 物理隔离、日期化索引、同主题原地更新 | 无整理、无自动沉淀 | 取：索引行 + 日期 + 原地更新（减少整理时的"新增"） |
| **ReMe / memsearch** | 日记→知识两段式；审阅面板（候选→review→install，绝不自动安装）；memory-to-skill 需 ≥3 次复现 | Python 服务 / Milvus | 取：收件箱+审阅+人工点头；舍服务与向量库 |
| **lan-memory v1** | 三层模型 + SOUL/MOOD + GUI + 手动整理；零依赖、设计判断对 | 装不上（漏依赖、peer 断档）；Dream 硬编码 provider；`~/.dsh` 全局；`readText` 静默丢数据；`.trash` 不释放；无测试 | 保留设计资产，重写工程壳 |

**一句话**：EverOS 的生命周期 + memory-board 的写盘护栏 + dsh-memory-md 的注入卫生 + 你原有的"可管理可整理"，就是 v2。

---

## 三、v2 架构

### 3.1 运行时形态

```
DSH Host 进程
└─ dsh-lan-memory (单个 host 插件，零运行时依赖)
   ├─ store.js      文件存储（原子写 + 备份 + 迁移 + 锁）
   ├─ search.js     CJK bigram + BM25（内存索引，启动重建）
   ├─ capture.js    session/event → journal（零 LLM）
   ├─ organize.js   确定性整理 + 整理包（review pack）
   ├─ http.js       /lan-memory/* REST + 面板静态页
   └─ index.js      apply(ctx): tools / systemPrompt / webServer / 事件
```

- 不 import `@deepseek-ai/dsh-llm`（v1 漏声明导致装不上）；`@deepseek-ai/dsh-tools` 以 **peerDependencies** 正确声明（宿主运行时供应），**不放进 `dependencies`**（npm `latest` 是 0.0.1-rc.1 的极旧版）。
- 工具用 `defineTool` + `ctx.tools.register` 注册；`parameters` 是"属性名→规格"映射（不是原始 JSON Schema），`output: {schema, render}` 必填。
- `engines.dsh: "^0.2.1-rc.2"`（宿主用 `includePrerelease` 判定，可覆盖 0.2.x；有 `engines.dsh` 时 peer 范围不参与兼容判定）。

### 3.2 数据布局（默认 `$DSH_HOME/lan-memory/`）

```
lan-memory/
├── persona.md              # SOUL / MOOD 契约 / 模式；真源，整理流程只读
├── pinned.md               # 常驻记忆（Markdown 列表，可手改）
├── memory.jsonl            # 检索记忆 {id,tags,content,created_at,updated_at,source,hash}
├── experience.jsonl        # 经验库
├── mood.jsonl              # 最近 200 条情绪状态
├── journal/YYYY-MM-DD.jsonl# 零 LLM 捕获（每轮一条，30 天滚动）
├── views/memory.md         # 派生只读视图（可重建，给人看/给 git diff）
├── backups/<ts>/           # 每次整理/删除前整份快照 + manifest.sha256
├── index.json              # 派生倒排索引（可删，启动重建）
├── meta.json               # schemaVersion / lastOrganize / stats
└── .lock                   # 单写者锁（多进程时告警不静默覆盖）
```

旧数据迁移：首次启动检测 `$DSH_HOME/hanako/`（v1 默认目录）→ **复制不移动**到 `lan-memory/`，`persona.json` → `persona.md`，JSONL 原样，写 `backups/migrate-<ts>/` 快照；旧目录保持只读，可随时回退。

### 3.3 注入（三类内容、三条通道、三个预算）

| 通道 | 内容 | 预算 | 说明 |
|---|---|---|---|
| `systemPrompt.section` | `lan:persona`（SOUL + MOOD 契约 + 模式） | ≤ 2 KB | 稳定常量，`interpolate:false`，防 `{{}}` 炸提示词 |
| `systemPrompt.section` | `lan:rules`（写入纪律：何时记、一条一事、不记密钥） | ≤ 600 B | 稳定常量 |
| `systemPrompt.context` | `lan:pinned`（常驻记忆全文） | ≤ 4 KB | 读盘；变化才进历史快照，KV 前缀不失效 |
| `systemPrompt.context` | `lan:index`（记忆条数 / 待整理条数 / 最近 3 条 id） | ≤ 300 B | **收件箱正文不进注入**，只给计数，避免膨胀 |
| `systemPrompt.context` | `lan:mood`（上一轮状态池） | ≤ 1 KB | 每轮变量 |

- 所有预算用 `Buffer.byteLength`，按条目截断（修 v1 的 `length*2` 估算错误）。
- 所有 memory 相关 section/context 一律 `interpolate:false`。
- 每轮注入总量硬上限 ≈ 8 KB，可在 `meta.json` 配置。

### 3.4 Agent 工具（6 个，替代 v1 的 12 个）

| 工具 | 参数 | 行为 |
|---|---|---|
| `lan_remember` | `content` 必填；`layer`: pinned/memory/experience；`tags[]` / `category` | 一条一事；同主题原地更新（按 hash/主题键），不无脑新增 |
| `lan_recall` | `query`、`top_k`(≤10)、`layer?` | BM25 top-k，字节预算 2 KB |
| `lan_list` | `layer?`、`tag?`、`offset`、`limit`(默认 50) | 分页（修 v1 全量返回） |
| `lan_forget` | `id` 或 `keyword` + `layer`；`dry_run` 默认 true | 先返回命中清单，确认后 `dry_run:false` 才删；删前备份 |
| `lan_organize` | `action`: `preview` / `apply-local` / `review-pack` | preview: 干跑清单；apply-local: 确定性整理；review-pack: 给当前模型一份整理包（模型用前 4 个工具执行） |
| `lan_status` | 无 | 数据目录、各层计数、待整理、最近整理、健康检查 |

旧的 `lan_pin/lan_unpin/lan_dream/lan_exp_*` 在 README 标注弃用；如需兼容别名，可在 P2 追加（默认不加，保持工具清单精简）。

### 3.5 捕获（零 LLM，用户零操作）

- 监听官方事件 **`session/event`**（签名已确认：`(session, event)`，提交后触发）收集 user / assistant / tool 事件；`agent/turn-stopping` 落盘（payload 实测 `{turn, signal, agent}`）。
- **v1 的 mood 捕获在当前宿主上已静默失效**：它读 `agent.session.events`，而 0.2.1 的 `Session` 没有 `events` 字段（只有 `deriveMessages()` / `snapshotEvents()`），`events || []` 退化成空数组且不报错。v2 改用 `session/event` 增量 + `deriveMessages()` 兜底，并在 health 里暴露捕获状态。
- 每轮一条 journal：`{v:1, ts, session, turn, user(截断 500 字), assistant(截断 800 字), tools[名称], hash}`。
- 机械去噪（不调模型）：
  - 精确 hash 去重、同 session 连续相同内容合并；
  - 最小长度门槛（无信息量的"好/继续"不入）；
  - 每轮最多一条、每天上限（默认 300 条）、30 天滚动；
  - 插件自身注入的 context 不捕获（来源标记判断），避免自我喂养。
- 自动收敛（同样零 LLM）：journal 超阈值时本地压缩（去重/截断），只动 journal，不动记忆。
- **降级**：事件形状变化导致捕获失败时，只 `warn` 不抛错，`lan_status` 显示"捕获不可用"，工具写入照常。

### 3.6 整理（可干跑、可回滚、默认只改不增）

| 模式 | 触发 | 做什么 |
|---|---|---|
| 本机整理 `apply-local` | 面板按钮 / `lan_organize` / 自动阈值 | 纯确定性：精确去重、近似去重（bigram 余弦 ≥0.85 给候选不自动删）、标签合并、超龄标记、容量裁剪；**不改人格** |
| 整理包 `review-pack` | 模型调工具 | 返回待整理条目 + 重复簇 + 过期候选 + 建议动作（≤4 KB）；模型用 remember/forget 执行 |
| 自动收敛 | journal ≥200 条 / 30 天 | 只跑 `apply-local` 的保守部分（去重 + 截断），后台、可 undo |

**用户默认零操作（对齐 hanako 的方式）**：写入由模型按"写入纪律"主动完成，捕获全自动；提示词里再加一条整理纪律：

> 当待整理 ≥20 条或每 10 轮，主动 `lan_organize action:"review-pack"`，然后只做三类动作（改写/合并/删除），单次改动 ≤10 条，整理后不需要向用户汇报细节。

这样日常无需用户点任何按钮；面板只用于"想看/想改/想纠错"的时候。自动整理可在 `persona.md` 配置里关掉；每次 apply 前：整份快照 → manifest.sha256 → 执行 → 写 `undo/<ts>.json`；面板提供"撤销上一次整理"。

### 3.7 管理界面（双入口）

- **独立面板**：`http://127.0.0.1:<DSH端口>/lan-memory/`，单 HTML + 原生 JS，零构建、同源、无 CSP 麻烦。
- **设置页入口**：`settings.section`（已确认存在，list/root）注册"澜记忆"页：状态卡 + 常用按钮（打开面板 / 本机整理 / 备份）+ 内嵌 iframe 面板；iframe 被拦时退化为"新标签打开"按钮。普通人从设置页就能找到，不再需要记 URL。
- 5 个 tab：概览 / 记忆 / 收件箱 / 人格 / 维护。
- **写盘护栏**：读带版本指纹（ETag）→ 写带 `If-Match`，冲突返回 409；删除需确认；每次写入备份。
- **API 安全**：只接受同源（`Origin`/`Sec-Fetch-Site` 校验）+ 写操作要求自定义头 `x-lan-ui: 1`（跨站简单请求无法伪造）+ 拒绝 `text/plain` 写；不新增 token 分发。

### 3.8 兼容与容错

- 每个注册点（tools / section / context / route / event）独立 try/catch，失败只降级；
- `GET /lan-memory/api/health` 返回各能力绑定状态（工具数、注入数、路由数、捕获是否工作），升级 DSH 后一眼看出哪条挂了；
- client 半区保持 ≤150 行，只做"状态 + 入口"；即使 client seam 变动，面板仍可用；
- 不复刻 v1 的 `MutationObserver` DOM hack（mood 卡片移除，改在面板看轨迹）。

### 3.9 已核实的宿主接口（2026-10-22，asar 源码逐条核查 + 本机实测）

| 接口 | 结论 | 证据 |
|---|---|---|
| `defineTool` + `ctx.tools.register(def)` | 都可用；`parameters` 是"属性名→规格"映射（**不是**原始 JSON Schema），`output:{schema,render}` 必填，返回 disposer | dsh-tools 源码 + README |
| `ctx.systemPrompt.section()` / `.context()` | 都存在；section.text 可为函数并返回 disposer；context 是 cache-safe 动态上下文，变化才写入历史 | dsh-system-prompt 源码 + 官方文档 |
| `ctx.webServer.register({kind,path,handler(req,res)})` | exact/prefix 都支持；handler 是 Node 原生 `IncomingMessage/ServerResponse`；**无内置认证，须自管 loopback+Origin** | dsh-host-webserver 源码 + README |
| `agent/turn-stopping` | 存在，serial，payload `{turn, signal, agent}`；`agent.session.events` **不存在**（v1 mood 捕获因此静默失效） | dsh-agent-loop 源码 |
| `session/event` | 存在，emit，`(session, event)`，提交后触发；`session.deriveMessages()` 未废弃，可兜底 | dsh-session 源码 + Event 目录 |
| `settings.section` | 存在，list/root，注册字段 `id/order/label`（`priority` 大概率无效） | client Slots inspect |
| client 半区 | `dsh.client` + `exports["./client"]`，文件包一层 `window.__ModuleLoader__.load({id, factory})`，手写 CJS 即可，无需构建 | dsh-client-modules 源码 |
| `engines.dsh` | 独占兼容判定；`semver.satisfies(..., includePrerelease)`，`^0.2.1-rc.2` 可覆盖 0.2.x 预发布 | dsh-app-boot 源码 |
| 数据目录 | 无 `ctx.dataDir`/`ctx.paths`；按 `$DSH_HOME`（本机 `$DSH_HOME`）自行推导 | 环境变量实测 + home-paths README |
| 安装 | `dsh.cmd` 可用（0.2.1-rc.2）；本地目录可 add；**desktop profile 需 Desktop 完全退出后才能装** | CLI 实测 |

---

## 四、与 v1 的差异

| 项 | v1 | v2 |
|---|---|---|
| 依赖 | 漏声明 `dsh-llm`，`dsh-tools ^0.1.0-rc.6` | 只 peer 依赖宿主自带的 `@deepseek-ai/dsh-tools`，`engines.dsh: ^0.2.1-rc.2`，不碰 `dsh-llm` |
| 注入 | 3 个 section | 2 section + 3 context，三条独立预算，`interpolate:false` |
| 检索 | JSONL 子串打分 | CJK bigram + BM25，字节预算正确 |
| 捕获 | 无 | journal（零 LLM，用户零操作） |
| 整理 | 硬编码 opencode → 3 阶段 × 5 重试 × 180s，最坏 45 分钟 | 当前回合整理包 + 本地确定性整理，秒级、可干跑、可撤销 |
| 数据目录 | `~/.dsh/hanako` 硬编码 | `$DSH_HOME/lan-memory`（可配置），复制式迁移 |
| 可靠性 | IO 错误当空串，可能静默丢全部 | 原子写 + 校验 + 改前备份 + 锁 + 失败可见 |
| GUI | 5 tab + DOM hack | 独立面板 + 设置页入口，无 DOM hack |
| 工具 | 12 个 | 6 个 |
| 分发 | 无 npm、无测试 | 本地 bundle，node:test + 假宿主冒烟；README/CHANGELOG |

---

## 五、实施阶段

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **P0 骨架** | 新仓库、store（原子写/备份/锁/迁移）、search（BM25）、6 工具、注入通道、`engines.dsh` | 1 天 | 单测通过；假 ctx 能注册 6 工具 + 5 注入；迁移样例无损 |
| **P1 捕获** | `session/event` + `turn-stopping` → journal；去噪/滚动；降级与 health | 0.5 天 | 假宿主模拟 20 轮，journal 条数/去重/上限正确；事件缺失时不崩 |
| **P2 面板** | REST + 单页 HTML 5 tab + 写盘护栏 + 撤销 | 1 天 | 浏览器手测增删改查/整理/备份/撤销；409 冲突生效 |
| **P3 设置页** | client 半区 + `settings.section` + iframe/新标签降级 | 0.5 天 | 真实 GUI 设置页能看到"澜记忆"入口；client 加载失败不影响面板 |
| **P4 整理** | 确定性整理、review-pack、自动收敛、整理纪律提示词、undo | 0.5 天 | 干跑清单与执行结果一致；撤销恢复原文；模拟 30 轮后待整理下降 |
| **P5 安装验收** | 安装到 desktop profile、真实会话冒烟、README/CHANGELOG、迁移真实数据 | 0.5 天 | 重启后工具/注入/面板均可用；旧数据完整 |

合计约 **3.5–4 个工作日**。

### 安装与验证方式（需要你配合）

本会话沙箱只能写工作区，读不到 `$DSH_HOME`；且实测 **desktop profile 只能在 Desktop 完全退出后、用自带 CLI 安装**（`dsh.cmd plugin --profile desktop list` 当前直接报错要求先退出 Desktop）。所以分两步：

1. **开发期真机验证（不碰 desktop）**：用一次 `danger-full-access` 授权，或你在终端跑：
   ```powershell
   dsh.cmd plugin --profile lan-test add "<插件目录>"
   dsh.cmd --profile lan-test --dump-config
   ```
   确认 bundle 层被正确插入、版本预检通过；必要时用 `lan-test` 起一次独立实例看工具/注入/面板。
2. **正式装上 desktop（你做，约 1 分钟）**：
   - 完全退出 DeepSeek Harness Desktop；
   - 在终端运行：
     ```powershell
     dsh.cmd plugin --profile desktop add "<插件目录>"
     ```
   - 重启 Desktop，我远程通过 health/面板/工具列表验证。

> 为什么不能我代装：Desktop 运行中会锁住 profile；且插件要重启当前 GUI 才生效，会中断本会话。

---

## 六、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `session/event` / `turn-stopping` 载荷漂移 | 捕获失效 | 只用官方签名；try/catch + health 可见；降级为纯工具写入 |
| client seam（`__ModuleLoader__`/slots）变动 | 设置页入口消失 | 面板独立可用；client 半区最小化；P3 先做 20 行探针验证 |
| 关键词检索召不回 | 记忆"记了等于没记" | 注入索引摘要 + 模型 active recall；<2000 条 BM25 足够；向量检索列为未来可选 |
| 收件箱积压 | 用户不再打开 | 只注入计数；到阈值自动本地压缩；整理由模型主动提议 |
| 迁移丢数据 | 信任归零 | 复制不移动、整份快照、manifest 校验、可回退；先跑 v1 数据副本演练 |
| 多进程同时写 | 互相覆盖 | `.lock` 检测 + 告警 + 只读降级 |
| 面板 iframe 被 CSP 拦 | 设置页看不到内容 | 保留"新标签打开"按钮 |
| 安装权限不足 | 无法真机验收 | 开发期用 `lan-test` profile 验证；desktop 安装由你在 Desktop 退出后跑一条命令 |

---

## 七、验收清单

1. `dsh plugin add` 后重启，`lan_status` 可见，数据目录为 `$DSH_HOME/lan-memory`；
2. 6 个工具在工具列表出现，描述含写入纪律；
3. system prompt 出现 persona/rules/pinned/index/mood 五段，总注入 ≤8 KB；
4. 设置页出现"澜记忆"，可打开面板；
5. 面板 5 个 tab 可用，记忆增删改查即时落盘；
6. 一轮对话后 journal 增加一条，收件箱可见，且不影响注入体积；
7. `lan_organize preview` 返回清单，`apply-local` 执行后旧条目可从 backups 恢复；
8. 删除/整理有备份 + undo；409 冲突不丢数据；
9. 人格文件在整理前后字节一致（整理不动人格）；
10. 旧 `hanako` 数据迁移后条数一致，旧目录未被修改。

---

## 八、待确认（不影响先开工）

1. mood 卡片从聊天区移除、改到面板看轨迹 —— 可接受吗？
2. 旧工具名（`lan_pin` / `lan_dream` / `lan_exp_*`）是否保留兼容别名？
3. 安装走方案 A（你跑一条命令）还是方案 B（授权我代装）？
4. 新仓库放在 `<插件目录>`，还是直接改造现有 clone？
