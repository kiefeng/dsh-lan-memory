# Changelog

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
