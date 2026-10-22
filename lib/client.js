/* dsh-lan-memory v2 — 浏览器半区（__ModuleLoader__ bundle）
 *
 * 两个扩展面：
 *   1. settings.section「澜记忆」：状态 + 打开管理面板 + 本机整理 / 备份
 *   2. conversation.chat.turnTail：把本轮 <mood> 状态池渲染成澜主题卡片
 *
 * 状态池数据不走 DOM 猜测：host 在 /lan-memory/api/mood 按 session + turn
 * 返回结构化字段；卡片只在拿到「本轮」记录时出现。
 * 原始 <mood> 文本会被就地隐藏（text-node 级、失败即保留原文），
 * 这是 DSH 当前 Markdown 不支持自定义 HTML/组件下的最小代价方案。
 */
console.log('[dsh-lan-memory] client boot v2.1')
window.__ModuleLoader__.load({
  id: 'dsh-lan-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var BASE = '/lan-memory'
    var PANEL_URL = BASE + '/'
    var STYLE_ID = 'dsh-lan-memory-mood-styles'

    function apiState() {
      return window.fetch(BASE + '/api/state', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
    }
    function apiPost(path, body) {
      return window.fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lan-ui': '1' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }
    function apiPut(path, body) {
      return window.fetch(BASE + path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-lan-ui': '1' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    function ensureMoodStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.lan-mood{position:relative;border:1px solid rgba(124,92,255,.34);border-radius:14px;padding:12px 16px 10px;margin:10px 0 12px;',
        'background:linear-gradient(135deg,rgba(16,28,52,.96),rgba(38,24,70,.92));',
        'box-shadow:0 8px 28px rgba(8,12,28,.22),inset 0 1px 0 rgba(255,255,255,.05);',
        'color:var(--dsw-alias-label-primary,#e8e8ec);font-size:13px;line-height:1.55;overflow:hidden;max-width:100%}',
        '.lan-mood:before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 90% at 12% 0%,rgba(124,92,255,.18),transparent 55%)}',
        '.lan-mood-head{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;position:relative}',
        '.lan-mood-whale{font-size:16px;filter:drop-shadow(0 0 6px rgba(124,92,255,.45))}',
        '.lan-mood-title{font-weight:600;letter-spacing:.02em;color:#c9b8ff}',
        '.lan-mood-vibe{margin-left:auto;font-size:12px;padding:2px 10px;border-radius:999px;background:rgba(124,92,255,.18);',
        'border:1px solid rgba(124,92,255,.28);color:#d5c8ff;white-space:nowrap;max-width:62%;overflow:hidden;text-overflow:ellipsis}',
        '.lan-mood-caret{font-size:10px;opacity:.55;margin-left:6px}',
        '.lan-mood-body{display:grid;grid-template-columns:58px minmax(0,1fr);gap:7px 10px;margin-top:10px;position:relative}',
        '.lan-mood-k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8798b8;padding-top:2px}',
        '.lan-mood-v{min-width:0;word-break:break-word}',
        '.lan-mood-v ul{margin:0;padding-left:15px}.lan-mood-v li{margin:1px 0}',
        '.lan-mood-foot{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:10px;color:#7f8fb0;position:relative}',
        '.lan-mood-collapsed .lan-mood-body,.lan-mood-collapsed .lan-mood-foot{display:none}',
        '@media (prefers-color-scheme:light){.lan-mood{background:linear-gradient(135deg,rgba(238,242,255,.98),rgba(245,238,255,.96));',
        'color:#1c2333;border-color:rgba(99,76,220,.28);box-shadow:0 8px 24px rgba(60,60,120,.10)}',
        '.lan-mood-title{color:#5b46c9}.lan-mood-k{color:#6b7896}.lan-mood-foot{color:#6b7896}',
        '.lan-mood-vibe{background:rgba(99,76,220,.10);color:#4c3aa8}}',
      ].join('')
      document.head.appendChild(style)
    }

    function field(label, value) {
      if (!value || (Array.isArray(value) && !value.length)) return null
      var content = Array.isArray(value)
        ? h('ul', null, value.map(function (v, i) { return h('li', { key: i }, String(v)) }))
        : String(value)
      return h(React.Fragment, { key: label },
        h('div', { className: 'lan-mood-k' }, label),
        h('div', { className: 'lan-mood-v' }, content))
    }

    function turnNumber(turn) {
      if (turn === null || turn === undefined) return null
      if (typeof turn === 'number') return turn
      if (typeof turn.turn === 'number') return turn.turn
      if (typeof turn.number === 'number') return turn.number
      return null
    }

    /** 把本轮 <mood>/<qing> 原文从正文里隐去；只删标签块，不跨节点吞正文。 */
    function hideRawMood(cardEl) {
      if (typeof document === 'undefined' || !cardEl) return
      var blockRe = /<(mood|qing)\b[^>]*>[\s\S]*?<\/\1>/gi
      var tagRe = /<\/?(?:mood|qing)\b[^>]*>/gi
      var root = cardEl.parentNode
      for (var depth = 0; depth < 10 && root; depth++) {
        if (root.textContent && /<(mood|qing)\b/i.test(root.textContent) && root.contains(cardEl)) break
        root = root.parentNode
      }
      if (!root || root === cardEl) return
      var touched = []
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      var node
      while ((node = walker.nextNode())) {
        if (cardEl.contains(node)) continue
        var text = node.nodeValue || ''
        if (!/<(mood|qing)\b/i.test(text) && !/<\/(mood|qing)>/i.test(text)) continue
        // 完整块直接删；标签被 markdown 拆到不同文本节点时只删标签本身，
        // 绝不跨节点把后面的正文一起吞掉（之前整段消息变空就是这里）。
        var next = text.replace(blockRe, '').replace(tagRe, '')
        if (next === text) continue
        node.nodeValue = next
        if (node.parentElement && touched.indexOf(node.parentElement) === -1) touched.push(node.parentElement)
      }
      for (var i = 0; i < touched.length; i++) {
        var el = touched[i]
        if (el === cardEl || cardEl.contains(el)) continue
        if (!(el.textContent || '').trim()) el.style.display = 'none'
      }
    }

    function MoodCard(props) {
      var sessionId = props.sessionId
      var turnNo = turnNumber(props.turn)
      var moodState = useState(null)
      var mood = moodState[0]
      var setMood = moodState[1]
      var openState = useState(true)
      var open = openState[0]
      var setOpen = openState[1]
      var cardRef = useRef(null)
      var appliedRef = useRef(false)

      useEffect(function () {
        ensureMoodStyles()
        if (!sessionId) return
        var url = BASE + '/api/mood?session=' + encodeURIComponent(sessionId) +
          (turnNo === null ? '' : '&turn=' + encodeURIComponent(turnNo))
        var alive = true
        window.fetch(url, { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (!alive || !d || !d.ok || !d.mood) return
            var m = d.mood
            // 只认本轮：session 与 turn 都对得上才渲染，避免旧状态串轮次
            if (m.session && sessionId && m.session !== sessionId) return
            if (turnNo !== null && (m.turn === null || m.turn === undefined || Number(m.turn) !== Number(turnNo))) return
            setMood(m)
          })
          .catch(function () { /* 静默：没有卡片不影响正文 */ })
        return function () { alive = false }
      }, [sessionId, turnNo])

      useEffect(function () {
        if (!mood || !cardRef.current) return
        var card = cardRef.current
        var run = function () {
          try { hideRawMood(card) } catch (e) { /* 失败保留原文 */ }
        }
        run()
        var timer = setTimeout(run, 120)
        var observer = null
        try {
          var root = card.parentNode
          var moodTag = /<(mood|qing)\b[^>]*>/i
          for (var d = 0; d < 10 && root; d++) {
            if (root.textContent && moodTag.test(root.textContent)) break
            root = root.parentNode
          }
          if (root && typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(function () {
              if (appliedRef.current) return
              appliedRef.current = true
              try { run() } finally { appliedRef.current = false }
            })
            observer.observe(root, { childList: true, subtree: true, characterData: true })
          }
        } catch (e) { /* 忽略 */ }
        return function () {
          clearTimeout(timer)
          if (observer) observer.disconnect()
        }
      }, [mood])

      if (!mood) return null
      var vibe = mood.vibe || '深海无风'
      return h('div', { className: 'lan-mood' + (open ? '' : ' lan-mood-collapsed'), ref: cardRef },
        h('div', {
          className: 'lan-mood-head', role: 'button', tabIndex: 0,
          onClick: function () { setOpen(!open) },
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } },
        },
        h('span', { className: 'lan-mood-whale' }, '🐋'),
        h('span', { className: 'lan-mood-title' }, '澜 · 状态池'),
        h('span', { className: 'lan-mood-vibe', title: vibe }, vibe),
        h('span', { className: 'lan-mood-caret' }, open ? '▾' : '▸')),
        h('div', { className: 'lan-mood-body' },
          field('灵感', mood.sparks),
          field('反思', mood.reflections),
          field('意志', mood.will)),
        h('div', { className: 'lan-mood-foot' },
          h('span', null, mood.turn !== null && mood.turn !== undefined ? '第 ' + mood.turn + ' 轮' : '本轮'),
          h('span', null, '本地状态 · 不进记忆库')))
    }

    function ensureSettingsStyles() {
      if (typeof document === 'undefined' || document.getElementById('dsh-lan-memory-settings-styles')) return
      var style = document.createElement('style')
      style.id = 'dsh-lan-memory-settings-styles'
      style.textContent = [
        '.lan-settings{display:flex;flex-direction:column;gap:14px;max-width:780px;font-size:13px;color:var(--dsw-alias-label-primary,#e8e8ec)}',
        '.lan-hero{display:flex;align-items:center;gap:12px;padding:2px}',
        '.lan-hero-avatar{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,rgba(124,92,255,.28),rgba(56,122,204,.22));flex:none}',
        '.lan-hero-title{font-size:18px;font-weight:600;margin:0;letter-spacing:.01em}',
        '.lan-hero-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b5);margin-top:2px}',
        '.lan-status{margin-left:auto;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.28);color:var(--dsw-alias-label-secondary,#9aa4b5);white-space:nowrap}',
        '.lan-status[data-on="1"]{color:#57b37c;border-color:rgba(87,179,124,.45);background:rgba(87,179,124,.10)}',
        '.lan-card{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.22));border-radius:12px;background:rgba(128,128,128,.045);padding:14px 16px}',
        '.lan-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
        '.lan-card-title{font-weight:600;font-size:13px}',
        '.lan-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
        '.lan-stat{padding:9px 11px;border-radius:9px;background:rgba(124,92,255,.07);border:1px solid rgba(124,92,255,.14);min-width:0}',
        '.lan-stat b{display:block;font-size:20px;font-weight:600;color:#a78bfa;line-height:1.2}',
        '.lan-stat span{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b5);margin-top:2px}',
        '.lan-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '.lan-btn{font:inherit;font-size:12px;padding:6px 13px;border-radius:8px;border:1px solid rgba(124,92,255,.42);background:rgba(124,92,255,.10);color:var(--dsw-alias-label-primary,#e8e8ec);cursor:pointer}',
        '.lan-btn:hover:not(:disabled){background:rgba(124,92,255,.18)}',
        '.lan-btn.primary{background:#7c5cff;border-color:#7c5cff;color:#fff}',
        '.lan-btn.primary:hover:not(:disabled){background:#6a4bee}',
        '.lan-btn:disabled{opacity:.55;cursor:default}',
        '.lan-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:7px 0}',
        '.lan-row + .lan-row{border-top:1px solid rgba(128,128,128,.13);margin-top:7px;padding-top:7px}',
        '.lan-row-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b5);flex:none}',
        '.lan-row-value{font-size:12px;text-align:right;min-width:0;word-break:break-all}',
        '.lan-row-value code{font-size:11px;padding:1px 6px;border-radius:5px;background:rgba(128,128,128,.14)}',
        '.lan-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b95a7);margin:9px 0 0}',
        '.lan-switch-row{display:flex;align-items:flex-start;gap:18px;padding:11px 0}',
        '.lan-switch-row + .lan-switch-row{border-top:1px solid rgba(128,128,128,.13);margin-top:11px;padding-top:11px}',
        '.lan-switch-copy{min-width:0}',
        '.lan-switch-copy b{display:block;font-size:13px;font-weight:500}',
        '.lan-switch-copy span{display:block;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#9aa4b5);margin-top:2px}',
        '.lan-switch{margin-left:auto;flex:none;width:38px;height:22px;border-radius:999px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.18);position:relative;cursor:pointer;transition:background .15s,border-color .15s}',
        '.lan-switch:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
        '.lan-switch[data-on="1"]{background:#7c5cff;border-color:#7c5cff}',
        '.lan-switch[data-on="1"]:after{left:18px}',
        '.lan-switch:disabled{opacity:.5;cursor:default}',
        '.lan-memory-row{display:flex;align-items:flex-start;gap:8px;padding:8px 0}',
        '.lan-memory-row + .lan-memory-row{border-top:1px solid rgba(128,128,128,.13);margin-top:8px;padding-top:8px}',
        '.lan-tag{flex:none;font-size:10px;padding:1px 7px;border-radius:999px;background:rgba(124,92,255,.14);color:#b9a7ff;white-space:nowrap}',
        '.lan-memory-text{min-width:0;font-size:12px;line-height:1.55;word-break:break-word}',
        '.lan-memory-date{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b95a7);margin-left:auto}',
        '.lan-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b95a7);padding:6px 0}',
        '.lan-footer{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b95a7);padding:0 2px 6px;line-height:1.6}',
        '.lan-editor{width:100%;min-height:170px;resize:vertical;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary,#e8e8ec);background:rgba(0,0,0,.14);border:1px solid rgba(128,128,128,.25);border-radius:9px;padding:10px 12px;box-sizing:border-box}',
        '.lan-editor:focus{outline:none;border-color:rgba(124,92,255,.65)}',
        '.lan-error{font-size:12px;color:#ff6b6b;padding:8px 10px;border:1px solid rgba(255,107,107,.35);border-radius:8px;background:rgba(255,107,107,.08)}',
        '@media (max-width:600px){.lan-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.lan-row{flex-direction:column;gap:2px}.lan-row-value{text-align:left}}',
        '@media (prefers-color-scheme:light){.lan-card{background:rgba(99,76,220,.035)}.lan-stat{background:rgba(99,76,220,.06)}.lan-tag{color:#5b46c9}.lan-switch:after{background:#fff}}',
      ].join('')
      document.head.appendChild(style)
    }

    function StatusBadge(props) {
      if (!props.data) return h('span', { className: 'lan-status' }, '读取中')
      var bad = props.data.health && props.data.health.readOnly
      return h('span', { className: 'lan-status', 'data-on': bad ? '0' : '1' }, bad ? '只读' : '运行中')
    }

    function Stat(label, value, hint) {
      return h('div', { key: label, className: 'lan-stat' },
        h('b', null, String(value)),
        h('span', null, label + (hint ? ' · ' + hint : '')))
    }

    function Row(label, value) {
      return h('div', { className: 'lan-row', key: label },
        h('div', { className: 'lan-row-label' }, label),
        h('div', { className: 'lan-row-value' }, value))
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'lan-switch',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'data-on': props.checked ? '1' : '0',
        disabled: props.disabled,
        onClick: function () { if (!props.disabled) props.onChange(!props.checked) },
      })
    }

    function formatWhen(iso) {
      if (!iso) return '—'
      try { return new Date(iso).toLocaleString() } catch (e) { return '—' }
    }

    function SettingsPage() {
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errState = useState('')
      var err = errState[0]
      var setErr = errState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var ready = useState(false)
      var setReady = ready[1]
      var draftState = useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]

      function refresh() {
        return apiState().then(function (d) {
          if (d && d.ok) { setData(d); setDraft(d.memoryProfile || ''); setErr(''); setReady(true) } else setErr((d && d.error) || '读取失败')
        }).catch(function (e) { setErr(String(e && e.message ? e.message : e)) })
      }
      useEffect(function () { ensureSettingsStyles(); refresh() }, [])

      function run(mode, path) {
        if (busy) return
        setBusy(mode)
        apiPost(path || '/api/organize', { mode: mode, ifMatch: data && data.etag })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) refresh()
            else setErr((r && r.error) || '操作失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function toggle(key, value) {
        if (busy || !data) return
        setBusy('toggle:' + key)
        var settings = {}
        settings[key] = value
        apiPost('/api/settings', { settings: settings, ifMatch: data.etag })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) refresh()
            else setErr((r && r.error) || '设置保存失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function saveProfile() {
        if (busy || !data) return
        setBusy('save-profile')
        apiPut('/api/memory-profile', { content: draft, ifMatch: data.etag })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) { setErr(''); refresh() }
            else setErr((r && r.error) || '保存失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      var counts = (data && data.counts) || {}
      var meta = (data && data.meta) || {}
      var settings = meta.settings || {}
      var health = (data && data.health) || {}
      var capture = health.capture || {}
      var lastOrganize = meta.lastOrganize
      var recent = ((data && data.memory) || []).slice(-3).reverse()
      var pending = counts.journalPending || 0
      var panelUrl = (data && data.panelUrl) || PANEL_URL
      var compile = (data && data.compile) || {}

      return h('div', { className: 'lan-settings' },
        h('div', { className: 'lan-hero' },
          h('div', { className: 'lan-hero-avatar' }, '🐋'),
          h('div', null,
            h('h1', { className: 'lan-hero-title' }, '澜记忆'),
            h('div', { className: 'lan-hero-sub' }, '本地文件驱动的记忆与人格层；数据只在本机，可读、可改、可备份。')),
          h(StatusBadge, { data: data })),
        err ? h('div', { className: 'lan-error' }, err) : null,

        h('div', { className: 'lan-stats' },
          Stat('常驻', counts.pinned || 0, '始终注入'),
          Stat('自动事实', counts.facts || 0, '编译来源'),
          Stat('经验', counts.experience || 0),
          Stat('待编译', pending, pending ? '自动处理' : '干净')),

        h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '常用操作')),
          h('div', { className: 'lan-actions' },
            h('button', { type: 'button', className: 'lan-btn primary', onClick: function () { window.open(panelUrl, '_blank', 'noopener') } }, '打开管理面板'),
            h('button', { type: 'button', className: 'lan-btn', disabled: !!busy || !ready, onClick: function () { run('compile') } }, busy === 'compile' ? '编译中…' : '立即编译'),
            h('button', { type: 'button', className: 'lan-btn', disabled: !!busy || !ready, onClick: function () { run('backup', '/api/backup') } }, busy === 'backup' ? '备份中…' : '立即备份'),
            h('button', { type: 'button', className: 'lan-btn', onClick: refresh, disabled: !!busy }, '刷新状态')),
          h('p', { className: 'lan-hint' }, '自动编译会抽取原子事实并更新画像；失败时保留线索，不会丢。整理与删除前自动备份，可在面板里撤销。')),

        h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '运行状态')),
          Row('数据目录', h('code', null, String((data && data.dataDir) || '…'))),
          Row('管理面板', h('code', null, panelUrl)),
          Row('会话捕获', (capture.enabled ? '已开启' : '已关闭') + (capture.lastFlush ? ' · 上次落盘 ' + formatWhen(capture.lastFlush) : ' · 尚未落盘')),
          Row('自动编译', (compile.auto === false ? '已关闭' : '已开启') + ' · ' + (compile.state || 'idle') + (compile.model ? ' · ' + compile.model : ' · 未选模型')),
          Row('待编译', pending ? pending + ' 条 · 达到 ' + (compile.threshold || 6) + ' 条或空闲时自动处理' : '没有待编译线索'),
          Row('最近编译', compile.lastRunAt ? formatWhen(compile.lastRunAt) + ' · ' + (compile.facts || 0) + ' 条事实' : '还没有编译过'),
          compile.lastError ? h('p', { className: 'lan-error', style: { marginTop: 10 } }, '最近编译错误：' + compile.lastError) : null,
          health.errors && health.errors.length ? h('p', { className: 'lan-error', style: { marginTop: 10 } }, '最近错误：' + health.errors.slice(-2).join('；')) : null),

        h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '自动化')),
          h('div', { className: 'lan-switch-row' },
            h('div', { className: 'lan-switch-copy' },
              h('b', null, '会话捕获'),
              h('span', null, '每轮落一条本地 journal，不调模型。关闭后不再积累新线索，已有记忆不受影响。')),
            h(Switch, { checked: settings.captureEnabled !== false, disabled: !!busy || !ready, onChange: function (v) { toggle('captureEnabled', v) } })),
          h('div', { className: 'lan-switch-row' },
            h('div', { className: 'lan-switch-copy' },
              h('b', null, '自动编译'),
              h('span', null, '待编译达到 ' + (settings.autoCompileThreshold || 6) + ' 条或空闲时，插件自动抽取事实并重写四段画像；不需要你审核收件箱。')),
            h(Switch, { checked: settings.autoCompile !== false, disabled: !!busy || !ready, onChange: function (v) { toggle('autoCompile', v) } }))),

        h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' },
            h('div', { className: 'lan-card-title' }, '最近记忆'),
            h('button', { type: 'button', className: 'lan-btn', onClick: function () { window.open(panelUrl + '#memory', '_blank', 'noopener') } }, '全部记忆')),
          recent.length
            ? recent.map(function (m) {
              var tags = (m.tags || []).slice(0, 2)
              return h('div', { className: 'lan-memory-row', key: m.id },
                tags.length ? h('span', { className: 'lan-tag' }, tags.join(' · ')) : null,
                h('div', { className: 'lan-memory-text' }, m.content),
                h('span', { className: 'lan-memory-date' }, String(m.updated_at || m.created_at || '').slice(0, 10)))
            })
            : h('div', { className: 'lan-empty' }, '还没有长期记忆。对助手说「记住 …」就会出现在这里。')),

        h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' },
            h('div', { className: 'lan-card-title' }, '记忆画像（可直接编辑）'),
            h('button', { type: 'button', className: 'lan-btn primary', disabled: !!busy || !ready || !draft, onClick: saveProfile }, busy === 'save-profile' ? '保存中…' : '保存画像')),
          h('textarea', {
            className: 'lan-editor',
            value: draft,
            spellCheck: false,
            placeholder: '自动编译后的四段画像会出现在这里；直接改完保存即可，下一次编译会以它为当前画像输入。',
            onChange: function (e) { setDraft(e.target.value) },
          }),
          h('p', { className: 'lan-hint' }, '编辑保存前会自动备份；自动编译不会碰人格文件。' )),

        h('p', { className: 'lan-footer' }, '人格、收件箱、备份恢复都在完整面板里；本页只放最常用的状态、开关和画像编辑。'))
    }

    function apply(ctx) {
      var slots = ctx && ctx.slots
      if (!slots || !slots.inject) {
        console.warn('[dsh-lan-memory] slots service unavailable; UI entries skipped')
        return
      }
      try { ensureMoodStyles() } catch (e) { /* 忽略 */ }
      try {
        slots.inject('conversation.chat.turnTail', function () {
          return slots.register({
            name: 'conversation.chat.turnTail',
            id: 'lan-mood',
            order: 5,
          }, MoodCard)
        })
      } catch (e) {
        console.warn('[dsh-lan-memory] mood card register failed', e)
      }
      try {
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'lan-memory',
            order: 35,
            label: function () { return '澜记忆' },
          }, SettingsPage)
        })
      } catch (e) {
        console.warn('[dsh-lan-memory] settings.section register failed', e)
      }
      console.log('[dsh-lan-memory] client ready v2.1: mood card + settings entry')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
