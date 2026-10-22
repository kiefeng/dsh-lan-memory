# dsh-lan-memory v2 — 澜 · 轻量本地记忆与人格系统

> 个人自用的本地记忆层：文件是唯一真源，零外部服务、零 API Key、零向量库。
> 三层记忆 + SOUL/MOOD 人格 + 零 LLM 捕获 + 本地管理面板。

v2 是对 2026-08 原型（v1.0.0）的重写。设计取舍与调研见 [`docs/design.md`](docs/design.md) 与 [`docs/panel-contract.md`](docs/panel-contract.md)。

## 它是什么 / 不是什么

**是**：一个跑在 DSH 宿主进程里的轻量插件。记忆存在本机 Markdown / JSONL 文件里，
你随时能打开看、能手改、能备份、能整理；人格（SOUL）与情绪状态池（MOOD）继续保留。

**不是**：不是通用记忆 OS。不做 Python 服务、MongoDB/Neo4j/Qdrant、embedding、
外部 LLM 抽取、MCP 桥接。捕获不花一分钱模型调用；整理用当前会话的模型，或纯本地规则。

## 特性

- **三层记忆**：`pinned.md`（始终注入）/ `memory.jsonl`（BM25 检索）/ `experience.jsonl`（经验库）
- **六个工具**：`lan_remember` / `lan_recall` / `lan_list` / `lan_forget` / `lan_organize` / `lan_status`
- **零 LLM 捕获**：`session/event` → 每轮一条 `journal/YYYY-MM-DD.jsonl`，只做机械去噪；收件箱不进系统提示，只计数字
- **可管理 / 可修改 / 可整理**：本地网页面板五个 tab；设置页有「澜记忆」入口；整理可干跑、可撤销
- **写盘护栏**：原子写 + 上一版 `.bak` + 整理/删除前整份快照（manifest.sha256）+ 单写者锁
- **注入卫生**：`section()` 放常量、`context()` 放读盘内容；全部 `interpolate:false`（记忆里出现 `{{…}}` 不会炸提示词）；字节预算按 UTF-8 实算
- **兼容性**：`engines.dsh: ^0.2.1-rc.2`；不 import 任何 DSH 包，工具用裸 ToolDefinition 注册

## 安装

要求：DSH Desktop 0.2.1-rc.2（或同 minor 的 0.2.x）。

### 桌面版（desktop profile）

desktop profile 只能在 **Desktop 完全退出后**用自带 CLI 安装：

```powershell
# 1. 完全退出 DeepSeek Harness Desktop（托盘也要退）
# 2. 安装本地目录（<DSH安装目录> 例如 D:\DSH；插件目录是你 clone/解压后的路径）
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<插件目录>"
# 3. 重启 Desktop
```

如果 `dsh` 已在 PATH 上，等价命令是 `dsh plugin --profile desktop add "<插件目录>"`。

装好后：

- 设置页出现「澜记忆」：状态、待整理数、打开面板 / 本机整理 / 立即备份；
- 管理面板：`http://127.0.0.1:<DSH端口>/lan-memory/`（端口见启动日志或 `DSH_WEB_URL`）；
- 对话里让助手「记住 X」「查一下我之前说过的 Y」「整理记忆」即可。

### 其他 profile（开发/验证）

```powershell
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile lan-test add "<插件目录>"
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" --profile lan-test --dump-config
```

## 数据

默认目录：`$DSH_HOME/lan-memory/`（本机通常是 `C:\Users\<你>\.dsh\lan-memory`），
可用环境变量 `DSH_LAN_DATA_DIR` 覆盖。

```
lan-memory/
├── persona.md              # 人格真源（SOUL + MOOD 契约），可整段手改；整理永不修改它
├── pinned.md               # 常驻记忆，Markdown 列表，可手改
├── memory.jsonl            # 检索记忆
├── experience.jsonl        # 经验库
├── mood.jsonl              # 最近 200 条状态池
├── journal/YYYY-MM-DD.jsonl# 每轮对话的零 LLM 捕获（30 天滚动）
├── journal-status.jsonl    # 已提炼/已忽略的收件箱记录
├── views/memory.md         # 派生只读视图（可删、自动重建）
├── backups/<ts>_<reason>/  # 整份快照 + manifest.sha256
├── undo/<ts>/              # 最近 10 次整理/删除前的内容
├── meta.json               # schemaVersion / settings / 最近整理
└── .lock                   # 单写者锁
```

**迁移 v1**：首次启动若发现 `$DSH_HOME/hanako/` 且新目录为空，会**复制不移动**地导入
`pinned.md` / `memory.jsonl` / `experience.jsonl` / `mood.jsonl` / `persona.json`（转成 `persona.md`），
并先做一份 `pre-migrate-v1` 快照。旧目录保持原样，可随时回退。

## 注入与预算

| 内容 | 通道 | 预算 |
|---|---|---|
| SOUL | `systemPrompt.section` `lan:persona` | 12 KB 安全上限 |
| MOOD 契约 | `systemPrompt.section` `lan:mood-contract` | 12 KB 安全上限 |
| 记忆规则 | `systemPrompt.section` `lan:rules` | 固定短文本 |
| 常驻记忆 | `systemPrompt.context` `lan:pinned` | 4 KB（可配置） |
| 索引摘要（条数/待整理） | `systemPrompt.context` `lan:index` | 320 B |
| 上一轮状态池 | `systemPrompt.context` `lan:mood-last` | 1 KB |

收件箱正文**不进**注入，只给一个计数——这是防止"记忆越攒越贵"的关键。

## 捕获与整理

- 捕获：只收用户亲笔消息（`source.kind = user`）与模型可见文本；插件注入的上下文、
  团队消息、子代理消息都不收，避免自我喂养。每轮一条，精确 hash 去重，每日上限 300。
- 整理三条路径：
  1. **本机整理**（面板按钮 / `lan_organize apply-local`）：纯规则去重合并，秒级、可撤销；
  2. **整理包**（模型调 `lan_organize review-pack`）：≤4 KB 的待办清单，模型用前四个工具执行；
  3. **自动收敛**：journal 超阈值/超龄时本地压缩，只动收件箱不动记忆。
- 按人格契约里的「整理纪律」，模型会每约 10 轮/待整理 ≥20 条时主动整理，日常无需你操作。

## 安全边界

- 面板与 API 只接受 loopback（127.0.0.1/::1）来源；
- 写请求必须带 `x-lan-ui: 1` + `Content-Type: application/json`（跨站简单请求无法伪造），
  并可带 `ifMatch` 做并发保护（不一致返回 409）；
- 若带 `Origin`，必须与请求 Host 同源；
- 记忆内容是"不可信历史数据"：注入时不会当指令执行；不记录密钥/口令/证件号。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LAN_DATA_DIR` | `$DSH_HOME/lan-memory` | 数据目录 |
| `DSH_LAN_DEBUG` | 未设 | 设为 `1` 时打印更多日志 |

`meta.json.settings`（面板「维护」可改）：`captureEnabled`、`autoOrganize`、
`maxPinnedBytes`、`maxRecallBytes`、`maxIndexBytes`、`maxMoodBytes`、
`maxMemory`、`maxExperience`、`journalRetentionDays`、`journalMaxPerDay`、`organizeThreshold`。

## 排查

- 打开 `GET /lan-memory/api/health`：能看到工具/section/context/路由数量、捕获事件数、
  迁移结果、最近的错误（`errors` 数组）与是否只读。
- 设置页或面板看不到：先确认 DSH 版本满足 `engines.dsh`、Desktop 是否重启过；
  面板本身是独立网页，设置页入口失效时可直接访问 `/lan-memory/`。
- 数据目录被另一个进程占用时插件进入只读模式（`.lock`），关闭多开的 DSH 后重启即可。

## 开发

```powershell
node scripts/dev-server.mjs        # 假宿主，http://127.0.0.1:17800/lan-memory/
node test/store.test.mjs           # 单文件直跑（本机沙箱下 node --test 会因 spawn 受限）
node test/search.test.mjs
node test/organize.test.mjs
node test/capture.test.mjs
node test/http.test.mjs
node test/apply.test.mjs
```

## License

MIT
