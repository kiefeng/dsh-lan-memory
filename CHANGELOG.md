# Changelog

## 2.2.0 — 2026-10-22

发现性与市场就绪：

- README 顶部增加英文介绍（overview / features / install / agent catalog hints），中文说明移到 `## 中文`。
- `package.json` 增加英文主描述、`keywords`、`repository` / `homepage` / `bugs`，便于 npm 与插件市场索引。
- GitHub 仓库 About、topics 同步为英文 + 记忆/人格关键词。
- 补记 2.1.1 已包含的收件箱与写入护栏：待整理 14 天 / 60 条上限、review-pack 标记 reviewed、
  线索机械精简、`lan_remember` 300/800 字上限与整段对话拒绝。
- 声明 `dsh.bundle` 与 `cordis.patch.yml` 齐全，满足 awesome-dsh-plugin 收录条件。

## 2.1.1 — 2026-10-22

### 人格与文风（保持原人设，只补表达约束）

- SOUL 新增 `### 反 AI 腔`：先答后释、能一句不写一段、日常不改清单/不总结、禁用“首先/其次/最后、总的来说、值得注意的是、不仅…而且、从…角度、希望对你有帮助、让我们”、不凑三点/不排比/不升华。
- SOUL 语言指纹新增口癖限频（同一句式 3–5 轮最多一次，技术结论零口癖）与 3 组「差 → 好」短样例。
- 身份、双模式、傲娇刹车片、严谨与严禁原样保留。
- MOOD 改为**按需生成**：纯技术任务可整轮省略；Vibe 一句，其余每栏 0–2 条，总长 ≤120 字；不强制“傲娇自查”；正文第一句直接进入内容。
- 当前 `persona.md` 已通过 host API 在线更新（旧文件备份 `.bak-*`），无需重装即可生效；mood 卡片等代码层变更仍需重启。

## 2.1.0 — 2026-10-22

### 新增

- **状态池卡片**：`conversation.chat.turnTail` 槽位渲染本轮 `<mood>` 为澜主题卡片
  （🐋 标题、Vibe 药丸、灵感/反思/意志三栏、可折叠），原始 `<mood>` 文本就地隐藏；
  卡片数据来自 host 的 `GET /lan-memory/api/mood?session=&turn=`，按 session+turn 精确匹配，
  不会串轮次。隐藏失败时保留原文，卡片照常显示。
- mood 记录新增 `session` / `turn` / `seq` 元数据，支持按轮查询；`mood.jsonl` 兼容旧记录。

### 说明

- DSH 当前 Markdown 不执行自定义 HTML/组件（`html` 节点按纯文本渲染），因此采用
  「turnTail 官方槽位 + 文本节点级隐藏」，而不是往正文里塞 HTML。
- 卡片显示在每条回复下方（Turn 尾部）；这是官方槽位里最稳的位置，不再做 v1 的消息顶部搬移。

## 2.0.1 — 2026-10-22

实机安装后的修复：

- **修复捕获不落盘**：`session/event` 在真实宿主里没有把 `turn/end` 送到插件，导致 journal 一直为空。现在在 `agent/turn-stopping` / `agent/status(idle)` / `agent/disposed` 三个官方时机按 session 兜底落盘；buffer 落盘即删，重复触发不会重复写。
- 捕获健康新增 `types`（收到的事件类型计数）与 `userSources`（用户消息来源计数），便于下次诊断事件形状漂移。
- 从 `assistant/message` / `tool/call` 补齐 turn 号（`turn/start` 不可靠时仍能记录正确轮次）。
- 兼容性说明：插件依赖 `webServer`，只适用于 desktop/web 这类有 Web GUI 的组合；headless/tui 不会加载（这是宿主 inject 语义决定的，不是 bug）。
- 设置页入口已在真实 GUI 验证：`settings.section` 出现 `id=lan-memory order=35` 且 active。

## 2.0.0 — 2026-10-22

面向 DSH Desktop 0.2.1-rc.2 的重写。不兼容 v1 的工具名与数据目录（旧数据自动迁移）。

### 新增

- 零 LLM 捕获：`session/event` → `journal/YYYY-MM-DD.jsonl`（每轮一条，机械去噪、幂等、30 天滚动）
- 收件箱：待整理计数只进注入摘要，正文不进提示词；面板可提炼/忽略
- BM25 检索（CJK bigram + 英文词），字节预算按 UTF-8 实算
- 本地管理面板 `/lan-memory/`（概览/记忆/收件箱/人格/维护），设置页有「澜记忆」入口
- 确定性整理 + 可撤销（`undo/`），整理前整份快照 + manifest.sha256
- 写盘护栏：原子写、上一版 `.bak`、回读校验、单写者锁、只读降级
- 健康检查：`/lan-memory/api/health` 暴露各注册点绑定状态与捕获统计
- v1 数据迁移：`hanako/` → `lan-memory/`，复制不移动

### 变更

- 工具从 12 个精简为 6 个：`lan_remember` / `lan_recall` / `lan_list` / `lan_forget` / `lan_organize` / `lan_status`
- 数据目录改为 `$DSH_HOME/lan-memory`（可用 `DSH_LAN_DATA_DIR` 覆盖）
- 注入改为 section（常量）+ context（读盘）双通道，全部 `interpolate:false`
- 人格从 `persona.json` 改为可整段手改的 `persona.md`
- 一键整理不再硬编码 provider/model，也不再后台调用 LLM：改为"本地规则 + 当前回合整理包"

### 移除

- 对 `@deepseek-ai/dsh-llm` 的隐式依赖（v1 因此干净安装会加载失败）
- `~/.dsh` 硬编码、`.trash-*` 假删除、死代码 `dedupeExact`、静默吞错的 `readText`
- `conversation.chat.turnTail` mood 卡片与 `MutationObserver` DOM hack（v1 的 mood 捕获在 0.2.x 已静默失效）
- 硬编码 `provider: 'opencode'`、`maxTokens: 65536`、3 阶段 × 5 重试的 Dream 管线

### 兼容性

- 声明 `engines.dsh: ^0.2.1-rc.2`；不 import 任何 DSH 包，工具用裸 ToolDefinition 注册
- client 半区只注册 `settings.section`；面板为独立的同源网页，不依赖 client 内部 seam
