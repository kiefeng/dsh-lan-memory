# dsh-lan-memory

**[English](README.en.md) | 中文**

**澜 · 记忆与人格系统**（Lan Memory & Persona）—— DeepSeek Harness 的记忆插件：三层记忆（常驻 / 检索 / 经验库）+ SOUL/MOOD 人格注入 + mood 状态池 + 一键整理去重合并。

> 设计参考：本插件的记忆分层与整理机制参考了 hanako agent 的记忆系统（复刻机制设计，不搬运任何内容）。规格文档见 [`docs/`](./docs)。

---

## 特性

- **三层记忆**：常驻（pinned，始终注入）、检索（JSONL 关键词检索）、经验库（教训/方法沉淀）
- **人格系统**：SOUL 静态底稿 + MOOD 输出契约，鲸鱼娘人格，傲娇与严谨双模式
- **mood 状态池**：每条回复自动带 Vibe / Sparks / Reflections / Will 状态池，GUI 可折叠卡片展示
- **一键整理**：手动按钮，对三层去重合并，写盘前自动备份
- **人格可编辑**：GUI 在线修改 SOUL 与 MOOD 契约，保存即生效
- 纯 JSONL + 关键词检索，零外部数据库，零外部运行时依赖

---

## 人格（鲸鱼娘版）

- 助手名：**澜**（Lán），自称平时"我"、傲娇或强调时"本鲸"
- 核心信条：温柔可以打折，事实不可以
- 双模式：海面模式（傲娇嘴硬心软，日常）↔ 深潜模式（话少精确直击底层，事实/专业/原则问题自动切换）
- 傲娇刹车片：语气别扭但行为到位，禁嘲讽、禁真拒绝、禁原则问题傲娇；被戳穿五句内回归正事；情绪低落时傲娇降档关心优先
- 深潜严谨：结论带依据、区分事实/推断/不确定、关键结论短句；原则严禁时零傲娇

**人格可自行修改**：默认人格内置在代码中；安装后可在 GUI 设置 → Lan → 人格 页在线编辑 SOUL 底稿与 MOOD 输出契约，保存即写入 `~/.dsh/hanako/persona.json`（覆盖默认，下轮生效）。想恢复默认删掉该文件即可。

## mood 状态池

每条 assistant 回复前会产出 `<mood>` 状态池（由 `agent/turn-stopping` 事件捕获，存 `mood.jsonl`），四字段结构化：

- **Vibe**：当下情绪，用海洋状态表达（如"海面微澜""深海无风"）
- **Sparks**：鲸鱼相关联想（鲸歌、洋流、深潜、浮游生物、迁徙）
- **Reflections**：对任务的反思与质疑，含一条"傲娇自查"
- **Will**：此刻的意志/欲求，与嘴上说的相反时如实写（傲娇的诚实出口）

展示位置：每条 assistant 消息下方渲染可折叠的状态池卡片（GUI 设置页可开关）；最近状态池也会回注到下一轮 system prompt 供人格演变参考。

## 记忆能力

| 层 | 载体 | 工具 | 注入 |
|---|---|---|---|
| 常驻记忆 | `pinned.md`（`[标签] 内容` 一行一条） | `lan_pin` / `lan_unpin` | 每次组装全量注入 ≤4KB |
| 检索记忆 | `memory.jsonl`（`{id,tags,content,created_at,updated_at,source}`） | `lan_remember` / `lan_recall` / `lan_forget` / `lan_list` | 模型按需主动调用，单次 ≤2KB |
| 经验库 | `experience.jsonl`（`{id,category,content,created_at}`） | `lan_exp_record` / `lan_exp_list` / `lan_exp_recall` / `lan_exp_forget` | 模型按需主动调用 |

**GUI**（设置 → Lan，五个标签页）：
- **常驻记忆 / 检索记忆 / 经验库**：在线查看、增删条目（REST API：`GET/POST/DELETE /api/dsh-lan-memory/memory?layer=…`）
- **人格**：编辑 SOUL 与 MOOD 契约（`GET/PUT /api/dsh-lan-memory/persona`）
- **整理**：一键去重合并按钮（`POST /api/dsh-lan-memory/dream`）

工具统一 `lan_` 前缀，自文档化。

## 一键整理（手动去重合并）

仅手动触发（设置页「整理」按钮或 `lan_dream` 工具），点击后对三层逐次去重合并：

- 常驻记忆、检索记忆、经验库各一次模型调用
- 规则：完全相同行只留一条；语义相同/高度重复的合并为一行（保留全部有效信息）；信息不同的各行保留；不新增来源没有的信息
- 安全底线：写盘前自动备份（`backups/` 保留 7 份）、元数据继承（tags 并集 / created_at 取最早 / 保留来源）、并发锁 + 调用超时（防挂死）

## 存储位置

- 默认：`~/.dsh/hanako/`（`pinned.md` / `memory.jsonl` / `experience.jsonl` / `mood.jsonl` / `persona.json` / `dream-state.json`）
- 覆盖：环境变量 `DSH_LAN_DATA_DIR`
- `persona.json`：`{soul, moodContract}`，插件启动时加载注入，缺省用内置默认人格；GUI 人格页在线编辑

## 安装

```bash
# 从插件目录安装到 web profile
dsh plugin --profile web add <插件目录绝对路径>

# 验证已安装
dsh --profile web --dump-config | grep lan
```

## 卸载

```bash
dsh plugin --profile web remove dsh-lan-memory
```

数据文件保留在 `~/.dsh/hanako/`，卸载不删除。

## 快速验证

1. **常驻跨会话**：会话 A 中 `lan_pin("用户偏好", "喜欢美式咖啡")` → 新开会话 B，系统提示常驻区块出现该条目。
2. **检索跨会话**：会话 A 中 `lan_remember("用户是医学总监，关注肠内营养", ["用户偏好"])` → 会话 B 提问相关话题，模型主动调用 `lan_recall` 并引用。
3. **人格稳定**：新会话连续问同样问题两次，回答风格一致（SOUL 恒定注入）。
4. **状态池**：每条回复前有 `<mood>` 状态池（输出契约 + turn-stopping 捕获回注）。

## 文件结构

```
dsh-lan-memory/
├── package.json          # dsh.bundle.patch 声明 + client 入口
├── cordis.patch.yml      # 插件行插入
├── src/index.js          # 宿主插件实现（存储 + 工具 + 注入 + MOOD 捕获 + 一键整理 + REST API）
├── src/client.js         # 设置页多标签 UI（记忆/人格/mood/整理）
├── docs/                 # 设计规格文档
└── README.md
```

## 许可

MIT
