# 管理面板对接契约（ui/panel.html）

> **已废弃（v2.8.0）**：独立面板与 `/lan-memory/` 路由已移除，管理统一走 DSH 设置页的标签页。
> 本文只保留作历史参考；REST API 仍然有效。

面板由 host 插件在 `GET /lan-memory/` 直接返回，同源，无外部依赖、无构建。
所有请求都相对当前 origin，使用绝对路径 `/lan-memory/api/...`。

## 通用约定

- 写请求必须是 `Content-Type: application/json`，并带 header `x-lan-ui: 1`，否则 403。
- 写请求在 body 里带 `ifMatch: <etag>`（来自最近一次 GET /api/state 或上次写响应）。返回 409 时用响应里的新 `etag` 刷新界面并提示"数据已被其他窗口修改，已刷新"。
- 失败响应统一 `{ ok:false, error:"..." }`，HTTP 400/403/404/409/405/500。
- 所有时间：`ts` 是毫秒数，`created_at/updated_at` 是 ISO 字符串（面板本地化显示）。
- 不要引入 CDN、外链字体、外部图片；单文件内联 CSS/JS，可用 emoji 作图标。

## GET /lan-memory/api/state

```json
{
  "ok": true,
  "etag": "9f2c...",
  "dataDir": "C:\\Users\\<user>\\.dsh\\lan-memory",
  "meta": {
    "schemaVersion": 2,
    "createdAt": "2026-10-22T...",
    "lastOrganize": { "at": "2026-10-22T...", "summary": "合并 3 条，改写 1 条" },
    "lastMigrate": null,
    "settings": { "captureEnabled": true, "autoOrganize": true }
  },
  "counts": { "pinned": 0, "memory": 0, "experience": 0, "journalPending": 0, "journalToday": 0, "moods": 0 },
  "health": {
    "tools": 6, "sections": 2, "contexts": 3, "routes": 7,
    "capture": { "enabled": true, "events": 123, "bufferedSessions": 0, "lastFlush": "2026-10-22T..." },
    "lastError": null
  },
  "persona": { "soul": "……", "moodContract": "……" },
  "pinned": [ { "id": "p0", "tag": "用户偏好", "content": "……", "updatedAt": 1690000000000 } ],
  "memory": [ { "id": "m_xxx", "tags": ["项目"], "content": "……", "created_at": "ISO", "updated_at": "ISO", "source": "lan" } ],
  "experience": [ { "id": "e_xxx", "category": "tool usage", "content": "……", "created_at": "ISO" } ],
  "moods": [ { "ts": 1690000000000, "text": "Vibe: 海面微澜\nSparks: …" } ],
  "journal": {
    "pending": 3,
    "items": [
      { "id": "hash123", "ts": 1690000000000, "session": "session-…", "turn": 3,
        "user": "……", "assistant": "……", "tools": ["read"], "pending": true }
    ]
  }
}
```

- `journal.items` 最多 50 条，按时间倒序；`pending:false` 表示已提炼/已忽略，仅用于回看。
- `persona.soul` / `persona.moodContract` 从 persona.md 解析；面板编辑这两个字段即可（保存时整段写回）。

## POST /lan-memory/api/memory

```json
{ "layer": "pinned|memory|experience", "action": "add|update|delete",
  "id": "m_xxx", "index": 0,
  "entry": { "tag": "…", "content": "…", "tags": ["…"], "category": "…" },
  "ifMatch": "9f2c..." }
```

- pinned：`entry` 用 `{tag, content}`；`delete`/`update` 用 `index`（0-based，来自 state.pinned 的顺序）。
- memory：`entry` 用 `{content, tags}`；`delete`/`update` 用 `id`。
- experience：`entry` 用 `{category, content}`；`delete`/`update` 用 `id`。
- 成功：`{ ok:true, etag:"new" }`。

## PUT /lan-memory/api/persona

```json
{ "soul": "……", "moodContract": "……", "ifMatch": "9f2c..." }
```
成功：`{ ok:true, etag:"new" }`。

## POST /lan-memory/api/organize

```json
{ "mode": "preview|apply-local|review-pack|undo", "ifMatch": "9f2c..." }
```

- `preview` 不写盘；`apply-local` 执行确定性整理（去重/合并/超龄），写 undo。
- `review-pack` 返回给模型用的一段 Markdown（面板里展示、可复制，不自动执行）。
- `undo` 撤销最近一次整理。
- 响应：

```json
{
  "ok": true,
  "etag": "new",
  "report": {
    "countsBefore": { "pinned": 1, "memory": 12, "experience": 3 },
    "countsAfter": { "pinned": 1, "memory": 9, "experience": 3 },
    "actions": [
      { "kind": "merge|rewrite|delete|tag|none", "layer": "memory",
        "ids": ["m_a", "m_b"], "preview": "两条重复，合并为…", "reason": "exact-duplicate" }
    ],
    "undoId": "2026-10-22T...",
    "pack": "（仅 review-pack 模式）…"
  }
}
```

## 收件箱

POST `/lan-memory/api/journal`

```json
{ "action": "promote|dismiss|dismissAll", "id": "hash123",
  "layer": "memory", "tags": ["…"], "content": "可选的改写后内容", "ifMatch": "9f2c..." }
```

- `promote`：把该条提炼为记忆（默认写入 `memory` 层；可指定 `pinned`），并把该条标记为已处理。
- `dismiss`：标记忽略；`dismissAll` 忽略全部待整理。
- 成功：`{ ok:true, etag:"new" }`。

## 维护

- POST `/lan-memory/api/backup` → `{ ok:true, dir:"…", etag:"new" }`
- GET `/lan-memory/api/backups` → `{ ok:true, items:[{ dir:"…", createdAt:"ISO", files:["memory.jsonl"], size:1234 }] }`
- POST `/lan-memory/api/restore` `{ backup:"…", ifMatch:"…" }` → `{ ok:true, etag:"new" }`（面板必须二次确认）
- POST `/lan-memory/api/settings` `{ settings:{ captureEnabled:true, autoOrganize:true }, ifMatch:"…" }`
- POST `/lan-memory/api/migrate` → `{ ok:true, report:{ found:true, copied:[…] } }`
- GET `/lan-memory/api/export` → 下载 JSON（面板用 `window.open` 或 `<a download>` 即可）
- GET `/lan-memory/api/health` → 与 state.health 相同（无 state 大对象）

## 面板要求

1. 五个 tab：**概览 / 记忆 / 收件箱 / 人格 / 维护**。
2. 概览：数据目录、各层计数、待整理数、捕获健康状态、最近整理、最近 mood 轨迹（时间线样式，最多 20 条）。
3. 记忆：三层子 tab（pinned/memory/experience）；搜索框过滤（前端过滤即可）；每条可编辑（内联展开表单）、删除（二次确认）；新增；memory 显示 tags；pinned 显示 tag。
4. 收件箱：待整理列表，每条显示时间/会话/用户话/助手结论/工具；操作「提炼为记忆」「忽略」；顶部「全部忽略」；一条说明"收件箱不进系统提示，只计数字"。
5. 人格：两个大 textarea（SOUL / MOOD 契约），保存按钮；提示"整理永不修改人格，改坏可从备份恢复"。
6. 维护：备份、备份列表（可恢复，二次确认）、导出 JSON、迁移旧数据、设置开关（捕获 / 自动整理）、health JSON 折叠查看、数据目录。
7. 所有按钮有 loading/disabled 态；错误用顶部 toast；成功也 toast；409 自动刷新 state。
8. 视觉：深色优先、跟随 `prefers-color-scheme`；主色紫 `#7c5cff`；卡片圆角 10px；正文 13px；最小可用宽度 360px；不要横向滚动。
9. 只用原生 `fetch` / `document`；不要 React、不要外部库；单文件 `ui/panel.html`（CSS 在 `<style>`，JS 在 `<script>`）。
10. 页面标题「澜 · 记忆面板」，顶部显示来源（"本地 · 仅本机"）和待整理徽标。

## 自测

- 在浏览器直接打开文件时 `fetch` 会失败，属正常；用 `node scripts/mock-panel-api.mjs`（若存在）或临时静态服务验证。
- 至少手工验证：切 tab、增删改一条 memory、预览整理、保存人格、toast、409 处理（可临时改 ifMatch）。
