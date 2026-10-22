# Changelog

## 2.8.2 — 2026-10-22

编译稳定性与数据卫生：
- 画像编译 token 上限从 4096 提到 8192，事实库输入从 80 条降到 50 条，减少 JSON 被截断。
- 模型输出被截断时，尽量从已完整的 `facts/today/week/longterm` 字段打捞，不再直接整段丢弃。
- 本地兜底不再把原始用户提问塞进 `today/week`；失败时保留旧段，只合并 facts。
- `health.panel` 固定为 `false`，并新增 `api` 标记；不再谎报面板还在。
- 64 项测试通过。

## 2.8.1 — 2026-10-22

文档与清理：
- README 重写：四层规则、摘要→事实→画像、每日边界、事实墓碑、六标签设置页、无独立面板。
- 删除 `ui/panel.html` 与面板加载代码；`/lan-memory/` 只返回 404，API 保持。
- 更新 `cordis.patch.yml`、`docs/design.md`、`docs/panel-contract.md` 的过时描述。
- dev server 根路径改为跳 `api/state`。

## 2.8.0 — 2026-10-22

管理界面收尾：
- 经验从“记忆”页拆出，独立“经验”标签；记忆页只留画像、自动事实、手动记忆、常驻。
- 手动记忆、常驻、经验支持直接编辑；不再只能删了重加。
- 旧面板路由 `/lan-memory/` 移除，`state.panelUrl` 置空；设置页是唯一管理入口。
- facts 增加删除墓碑：删除的自动事实不会被下一次编译按相同文本重新写回；手动新增可解除墓碑。
- 64 项测试通过。

## 2.7.0 — 2026-10-22

记忆分层边界：
- 明确四层：常驻（始终注入、最高优先级）、手动记忆（用户明确要求记住，始终注入）、自动事实（编译抽取、参与画像）、经验（方法/踩坑、不参与画像）。
- 手动记忆不再自动写成自动事实；`lan_recall` 的 memory / fact / experience 三层分开检索。
- 新增 `lan:manual` 上下文，手动记忆不必每次靠 `lan_recall` 才拿到。
- 记忆索引与设置页标签统一：概览统计增加“手动记忆”；记忆页拆为自动事实、手动记忆、常驻、经验四块，各自说明纳入规则。
- 自动编译仍然只写 facts + 画像，不碰 pinned/memory/experience。
- 63 项测试通过（补手动记忆不写 facts 的边界断言）。

## 2.6.0 — 2026-10-22

设置页一体化：
- 设置页改为标签页：概览 / 记忆 / 收件箱 / 人格 / 维护；不再提供打开独立面板的入口。
- 记忆页覆盖：画像编辑、自动事实增改删、手动记忆/常驻/经验的新增与删除。
- 收件箱页保留原文历史，可提升/忽略；人格页直接编辑 SOUL/MOOD；维护页有备份列表/恢复/导出。
- 导出 JSON 增加 facts、summaries、memoryProfile、compile 状态。
- 独立面板路由保留为兼容入口，但设置页不再链接它。

## 2.5.0 — 2026-10-22

记忆管理收口：
- 每日边界：跨天自动把旧 today 沉淀进 week，再清空 today；不再让“今天”跨天挂着。
- 自动事实可管理：设置页列出 facts，可新增、编辑、删除；新增 `POST /api/facts`；`lan_list` / `lan_forget` 支持 layer=fact。
- 编译模型可配置：设置页可填 `memoryProvider` / `memoryModel`，并明确提示自动编译会把 journal/摘要发给该 provider。
- facts 改动后会调度一次强制重编译，画像以事实库为准更新。
- 63 项测试通过（新增跨天沉淀测试）。

## 2.4.7 — 2026-10-22

滚动摘要层：
- 新增 `summaries.json`：每会话一份滚动摘要，上一份摘要 + 新增对话合并，3-6 句、≤300 字。
- 编译改为三段：摘要 → 从摘要抽原子事实 → 合并四段画像；和 Hanako 的层级一致。
- 摘要失败时自动退回原始 journal 抽取，不阻塞；摘要文本会剔除状态池标签。
- today/week 使用摘要作为最近动态，不再只靠原始流水。
- 62 项测试通过（编译测试覆盖摘要写入）。

## 2.4.6 — 2026-10-22

画像补齐今天/本周：
- 编译 prompt 增加「最近动态」输入（最近 8 轮 journal），让模型把 today/week 从实际对话里合并出来，而不是永远「暂无」。
- 事实抽取和画像合并仍分开；状态池文本继续被剔除。
- 62 项测试通过。

## 2.4.5 — 2026-10-22

修复后几轮回复正文变空：
- `hideRawMood` 不再跨文本节点保持“隐藏中”状态；只在单个文本节点内删除完整的 `<mood>/<qing>` 块，标签被 markdown 拆开时只删标签本身。
- 不再因为找不到闭合标签而把后续正文一并清空；状态池原文可能偶尔残留，但正文不会消失。
- 这是纯客户端修复，刷新页面即可生效，不需要重启宿主。

## 2.4.4 — 2026-10-22

启动即整理：
- 插件加载后 8 秒触发一次自动编译（有待编译且达到阈值时），不必等用户先发一句话或切到 idle。
- 这修复“重启后待编译一直挂着、看起来自动整理没启动”的体验。
- 测试 62 项通过。

## 2.4.3 — 2026-10-22

状态池裸文本兼容：
- 模型只输出一句 `Vibe`（没有 `Vibe:` 标签）时，`/api/mood` 把它当作 vibe，避免卡片只剩标题。
- 历史 `<qing>` 轮次的 journal 回填现在能显示实际内容。
- 测试 62 项通过。

## 2.4.2 — 2026-10-22

自动编译适配真实模型：
- 兼容不同 adapter 的流式输出：同时读 `text-delta`、`block-end` 文本、`reasoning-delta`，避免 `deepseek-flash` 这类模型只在 reasoning/block 里给内容时被当成空返回。
- 抽取/编译输出预算提高到 4096 tokens；失败时错误里带最多 240 字模型返回原文，设置页可见。
- 模型返回非 JSON 时启用本地兜底：从用户消息里提炼带偏好标记的句子，生成 `today/week` 草案并标记 `fallback`；线索仍会推进，但画像可编辑。
- 模型完全失败且没有可兜底内容时，仍保留待编译和旧画像，不丢内容。
- 测试 61 项通过（新增兜底路径）。

## 2.4.1 — 2026-10-22

状态池与编译修正：
- 状态池标签兼容模型漂移：`<mood>` 与 `<qing>` 都识别；捕获、HTTP `/api/mood`、卡片隐藏逻辑统一支持。
- `/api/mood` 在 mood.jsonl 没有对应记录时，从同 session+turn 的 journal 补读一次，历史轮次也能显示卡片。
- 编译抽取时同样剔除 `<qing>` 别名，避免状态池文本进入事实。
- 编译模型调用增加 90 秒超时，避免后台编译卡死。
- 删除 memory 条目时同步删除同内容的 facts，避免画像把已删记忆复活。

## 2.4.0 — 2026-10-22

自动整理（不再审核收件箱）：
- 新增编译管线：journal → LLM 抽取原子事实 → `facts.jsonl` → 合并四段画像
  `facts.md` / `today.md` / `week.md` / `longterm.md` → `memory.md`。
- 自动触发：待编译达到阈值（默认 6）或空闲时执行；使用 DSH 现有模型（`ctx.llm`），
  不新增 API Key；失败保留线索并记录错误，成功后才标记 `compiled`。
- `memory.md` 作为 `lan:memory` 上下文注入；`lan_remember` 写入的事实也会进入事实库。
- 设置页新增「自动编译」开关、状态/模型/错误、待编译计数，以及可直接编辑保存的「记忆画像」。
- 新增 HTTP：`POST /api/compile`、`GET/PUT /api/memory-profile`；备份包含 facts/画像文件。
- `lan_organize` 的 `compile` 动作立即编译；`review-pack` 保留为兼容别名。
- 自动整理仍只动记忆文件，不改 `persona.md`；编辑/编译前自动备份。

## 2.3.1 — 2026-10-22

市场展示素材：

- 增加 `screenshots.json`（mood-card / settings-preview），dsh-market 等详情页会读取这组截图。
- README 顶部加入状态池卡片与设置页预览图，GitHub 详情页和市场爬取都能看到。
- 图片为静态预览，使用与插件相同的 CSS；数据目录示例用 `<user>` 占位，不含真实路径。
- 版本号只用于素材发布，功能不变。

## 2.3.0 — 2026-10-22

设置页重构：

- DSH 设置页「澜记忆」去掉 iframe 嵌套，改成原生卡片式页面：概览数字、常用操作、运行状态、自动化开关、最近记忆。
- 视觉跟随 DSH 主题变量（深浅色自适应），不再混入手写 iframe 样式；窄屏自动改两列。
- 状态区直接显示数据目录、捕获开关与上次落盘、待整理条数与过期规则、最近整理时间/摘要、最近错误。
- 自动化开关直接写 `meta.settings`（带 ifMatch 并发保护）；关闭捕获/自动整理即时生效。
- 最近记忆展示最新 3 条（标签 + 内容 + 日期），完整管理仍通过「打开管理面板」进入独立面板。

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
