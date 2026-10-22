# dsh-lan-memory

**Lan Memory & Persona** — a memory & persona plugin for DeepSeek Harness: three-layer memory (pinned / recallable / experience) + SOUL/MOOD persona injection + mood state pool + one-click dedup & merge.

> Design reference: the memory layering and consolidation mechanism is inspired by the hanako agent's memory system (mechanism design only, no content copied). Specs live in [`docs/`](./docs).

---

## Features

- **Three-layer memory**: pinned (always injected), recallable (JSONL keyword search), experience (lessons / methods)
- **Persona system**: SOUL static draft + MOOD output contract — whale-girl persona with tsundere + rigor dual modes
- **Mood state pool**: every reply carries a Vibe / Sparks / Reflections / Will state pool, shown as a collapsible card in the GUI
- **One-click consolidation**: manual button, dedup & merge across all three layers, auto-backup before writing
- **Editable persona**: edit SOUL and MOOD contracts in the GUI, takes effect immediately
- Plain JSONL + keyword search, zero external database, zero external runtime deps

---

## Persona (Whale-Girl)

- Assistant name: **澜** (Lán); self-reference "我" normally, "本鲸" when being tsundere or emphatic
- Core creed: *Kindness may be discounted, facts never.*
- Dual modes: Surface mode (tsundere, warm-hearted, daily chat) ↔ Deep-dive mode (laconic, precise, hits the bottom layer — auto-switches on facts / expertise / principles)
- Tsundere brake: tone may be cranky but actions are on-point; no mocking, no real refusals, no tsundere on matters of principle
- Deep-dive rigor: conclusions carry evidence; distinguishes fact / inference / uncertainty; short decisive sentences on principle issues

**Persona is editable**: install, then GUI Settings → Lan → Persona to edit the SOUL draft and MOOD contract — saved to `~/.dsh/hanako/persona.json` (overrides the built-in default, takes effect next turn). Delete that file to restore the default.

## Mood State Pool

Every assistant reply begins with a `<mood>` block (captured via the `agent/turn-stopping` event, persisted to `mood.jsonl`) with four structured fields:

- **Vibe**: current mood expressed as ocean states (e.g. "ripples on the surface", "windless deep sea")
- **Sparks**: whale-themed associations (whale songs, currents, deep dives, plankton, migration)
- **Reflections**: thoughts on and doubts about the task, including one "tsundere self-check"
- **Will**: current intent / desire — written truthfully even when it contradicts what was said (the tsundere's honest outlet)

Display: a collapsible state-pool card under each assistant message (toggle in the settings page); the latest pool is also fed back into the next system prompt as reference for persona evolution.

## Memory Capabilities

| Layer | Store | Tools | Injection |
|---|---|---|---|
| Pinned | `pinned.md` (`[tag] content` per line) | `lan_pin` / `lan_unpin` | full injection ≤4KB per assembly |
| Recallable | `memory.jsonl` (`{id,tags,content,created_at,updated_at,source}`) | `lan_remember` / `lan_recall` / `lan_forget` / `lan_list` | on-demand, ≤2KB per recall |
| Experience | `experience.jsonl` (`{id,category,content,created_at}`) | `lan_exp_record` / `lan_exp_list` / `lan_exp_recall` / `lan_exp_forget` | on-demand |

**GUI** (Settings → Lan, five tabs):
- **Pinned / Recallable / Experience**: browse and add/delete entries (REST: `GET/POST/DELETE /api/dsh-lan-memory/memory?layer=…`)
- **Persona**: edit SOUL and MOOD contracts (`GET/PUT /api/dsh-lan-memory/persona`)
- **Consolidate**: one-click dedup & merge button (`POST /api/dsh-lan-memory/dream`)

All tools share the `lan_` prefix — self-documenting and collision-free.

## One-Click Consolidation

Manual only (settings "Consolidate" button or the `lan_dream` tool). Runs one model call per layer:

- Pinned, recallable memory, and experience each get one dedup & merge pass
- Rules: exact duplicates collapsed; semantically identical / highly redundant lines merged into one (all valid info kept); distinct facts kept separate; no new information added
- Safety: auto-backup before writing (`backups/`, keeps 7), metadata inheritance (tags union / earliest created_at / source preserved), concurrency lock + call timeout (no hangs)

## Data Location

- Default: `~/.dsh/hanako/` (`pinned.md` / `memory.jsonl` / `experience.jsonl` / `mood.jsonl` / `persona.json` / `dream-state.json`)
- Override via env var `DSH_LAN_DATA_DIR`
- `persona.json`: `{soul, moodContract}` — loaded and injected at startup, falls back to the built-in default; editable in the GUI Persona tab

## Install

```bash
# Install from the plugin directory into the web profile
dsh plugin --profile web add <absolute-path-to-plugin-dir>

# Verify
dsh --profile web --dump-config | grep lan
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-lan-memory
```

Data files under `~/.dsh/hanako/` are kept — uninstall does not delete them.

## Quick Verification

1. **Pinned across sessions**: `lan_pin("用户偏好", "喜欢美式咖啡")` in session A → the pinned block appears in session B's system prompt.
2. **Recall across sessions**: `lan_remember("用户是医学总监，关注肠内营养", ["用户偏好"])` in session A → session B triggers `lan_recall` on related topics.
3. **Persona stability**: ask the same question twice in fresh sessions — consistent style (SOUL injected constantly).
4. **Mood pool**: every reply starts with a `<mood>` block (output contract + turn-stopping capture).

## File Layout

```
dsh-lan-memory/
├── package.json          # dsh.bundle.patch manifest + client entry
├── cordis.patch.yml      # plugin row insertion
├── src/index.js          # host plugin (storage + tools + injection + MOOD capture + consolidation + REST API)
├── src/client.js         # settings UI (memory / persona / mood / consolidate)
├── docs/                 # design specs
└── README.md
```

## License

MIT
