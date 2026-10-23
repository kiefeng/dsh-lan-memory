/* dsh-lan-memory v2 — 浏览器半区（__ModuleLoader__ bundle）
 *
 * 两个扩展面：
 *   1. settings.section「澜记忆」：六个标签页的全部管理与设置
 *   2. conversation.chat.turnTail：把本轮 <mood> 状态池渲染成澜主题卡片
 *
 * 状态池数据不走 DOM 猜测：host 在 /lan-memory/api/mood 按 session + turn
 * 返回结构化字段；卡片只在拿到「本轮」记录时出现。
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
        '.lan-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(128,128,128,.16);padding:0 2px;overflow-x:auto}',
        '.lan-tab{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b5);background:transparent;border:none;border-bottom:2px solid transparent;padding:7px 10px;cursor:pointer;white-space:nowrap}',
        '.lan-tab[data-on="1"]{color:#a78bfa;border-bottom-color:#7c5cff}',
        '.lan-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}',
        '.lan-card-title{font-weight:600;font-size:13px}',
        '.lan-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}',
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
        '.lan-input{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#e8e8ec);background:rgba(0,0,0,.14);border:1px solid rgba(128,128,128,.25);border-radius:7px;padding:5px 8px;min-width:0}',
        '.lan-input:focus{outline:none;border-color:rgba(124,92,255,.65)}',
        '.lan-fact-row{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:1px solid rgba(128,128,128,.13)}',
        '.lan-fact-row:first-of-type{border-top:none;padding-top:0}',
        '.lan-fact-text{flex:1;min-width:0;font-size:12px;line-height:1.55;word-break:break-word}',
        '.lan-fact-actions{flex:none;display:flex;gap:6px}',
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

    function SettingsPageV2() {
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errState = useState('')
      var err = errState[0]
      var setErr = errState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var tabState = useState('overview')
      var tab = tabState[0]
      var setTab = tabState[1]
      var draftState = useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var soulState = useState('')
      var soul = soulState[0]
      var setSoul = soulState[1]
      var moodDraftState = useState('')
      var moodDraft = moodDraftState[0]
      var setMoodDraft = moodDraftState[1]
      var providerState = useState('')
      var provider = providerState[0]
      var setProvider = providerState[1]
      var modelState = useState('')
      var model = modelState[0]
      var setModel = modelState[1]
      var thresholdState = useState('6')
      var threshold = thresholdState[0]
      var setThreshold = thresholdState[1]
      var idleState = useState('30')
      var idle = idleState[0]
      var setIdle = idleState[1]
      var newFactState = useState('')
      var newFact = newFactState[0]
      var setNewFact = newFactState[1]
      var factClustersState = useState([])
      var factClusters = factClustersState[0]
      var setFactClusters = factClustersState[1]
      var editIdState = useState('')
      var editId = editIdState[0]
      var setEditId = editIdState[1]
      var editTextState = useState('')
      var editText = editTextState[0]
      var setEditText = editTextState[1]
      var memDraftState = useState('')
      var memDraft = memDraftState[0]
      var setMemDraft = memDraftState[1]
      var pinnedDraftState = useState('')
      var pinnedDraft = pinnedDraftState[0]
      var setPinnedDraft = pinnedDraftState[1]
      var expDraftState = useState('')
      var expDraft = expDraftState[0]
      var setExpDraft = expDraftState[1]
      var rowEditLayerState = useState('')
      var rowEditLayer = rowEditLayerState[0]
      var setRowEditLayer = rowEditLayerState[1]
      var rowEditIdState = useState('')
      var rowEditId = rowEditIdState[0]
      var setRowEditId = rowEditIdState[1]
      var rowEditTextState = useState('')
      var rowEditText = rowEditTextState[0]
      var setRowEditText = rowEditTextState[1]
      var backupsState = useState([])
      var backups = backupsState[0]
      var setBackups = backupsState[1]

      function loadBackups() {
        window.fetch(BASE + '/api/backups', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json() })
          .then(function (d) { if (d && d.ok) setBackups(d.items || []) })
          .catch(function () { /* 忽略 */ })
      }

      function refresh() {
        return apiState().then(function (d) {
          if (!d || !d.ok) { setErr((d && d.error) || '读取失败'); return }
          setData(d)
          setDraft(d.memoryProfile || '')
          setSoul((d.persona && d.persona.soul) || '')
          setMoodDraft((d.persona && d.persona.moodContract) || '')
          var s = (d.meta && d.meta.settings) || {}
          setProvider(s.memoryProvider || '')
          setModel(s.memoryModel || '')
          setThreshold(String(s.autoCompileThreshold || 6))
          setIdle(String(s.compileIdleMinutes || 30))
          setErr('')
          loadBackups()
        }).catch(function (e) { setErr(String(e && e.message ? e.message : e)) })
      }
      useEffect(function () { ensureSettingsStyles(); refresh() }, [])

      function post(path, body) {
        return apiPost(path, Object.assign({}, body, { ifMatch: data && data.etag }))
      }

      function run(mode, path) {
        if (busy) return
        setBusy(mode)
        post(path || '/api/organize', { mode: mode })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '操作失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function toggle(key, value) {
        if (busy) return
        setBusy('toggle:' + key)
        var s = {}; s[key] = value
        post('/api/settings', { settings: s })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '设置保存失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function saveProfile() {
        if (busy) return
        setBusy('save-profile')
        apiPut('/api/memory-profile', { content: draft, ifMatch: data && data.etag })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '保存失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function savePersona() {
        if (busy) return
        setBusy('save-persona')
        apiPut('/api/persona', { soul: soul, moodContract: moodDraft, ifMatch: data && data.etag })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '人格保存失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function saveModels() {
        if (busy) return
        setBusy('save-models')
        post('/api/settings', { settings: { memoryProvider: provider.trim(), memoryModel: model.trim() } })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '模型保存失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function saveSchedule() {
        if (busy) return
        setBusy('save-schedule')
        post('/api/settings', {
          settings: {
            autoCompileThreshold: Math.max(1, Number(threshold) || 6),
            compileIdleMinutes: Math.max(1, Number(idle) || 30),
          },
        })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '调度保存失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function addFact() {
        if (busy || !newFact.trim()) return
        setBusy('add-fact')
        post('/api/facts', { action: 'add', fact: newFact.trim() })
          .then(function (r) { setBusy(''); if (r && r.ok) { setNewFact(''); refresh() } else setErr((r && r.error) || '添加失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function saveEdit() {
        if (busy || !editId || !editText.trim()) return
        setBusy('edit-fact')
        post('/api/facts', { action: 'update', id: editId, fact: editText.trim() })
          .then(function (r) { setBusy(''); if (r && r.ok) { setEditId(''); refresh() } else setErr((r && r.error) || '修改失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function deleteFact(id) {
        if (busy) return
        setBusy('del-fact')
        post('/api/facts', { action: 'delete', id: id })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '删除失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function previewFactMerge() {
        if (busy) return
        setBusy('merge-preview')
        post('/api/facts', { action: 'merge-preview' })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) setFactClusters(Array.isArray(r.clusters) ? r.clusters : [])
            else setErr((r && r.error) || '合并预览失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function applyFactMerge(cluster) {
        if (busy || !cluster) return
        setBusy('merge-facts')
        post('/api/facts', { action: 'merge-apply', clusters: [cluster] })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) { setFactClusters([]); refresh() } else setErr((r && r.error) || '合并失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function candidateAction(action, id) {
        if (busy || !id) return
        setBusy('candidate-' + action)
        post('/api/experience-candidates', { action: action, id: id })
          .then(function (r) {
            setBusy('')
            if (r && r.ok) refresh()
            else setErr((r && r.error) || '经验候选操作失败')
          })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function addManual(layer, text, extra) {
        if (busy || !String(text || '').trim()) return
        setBusy('add-manual')
        post('/api/memory', { layer: layer, action: 'add', entry: Object.assign({ content: String(text).trim() }, extra || {}) })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '添加失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function deleteManual(layer, id, index) {
        if (busy) return
        setBusy('del-manual')
        post('/api/memory', { layer: layer, action: 'delete', id: id, index: index })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '删除失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function startRowEdit(layer, id, text) {
        setRowEditLayer(layer)
        setRowEditId(String(id))
        setRowEditText(String(text || ''))
      }

      function cancelRowEdit() {
        setRowEditLayer('')
        setRowEditId('')
        setRowEditText('')
      }

      function saveRowEdit() {
        if (busy || !rowEditLayer || !rowEditText.trim()) return
        setBusy('edit-row')
        var body = { layer: rowEditLayer, action: 'update', id: rowEditId, entry: { content: rowEditText.trim() } }
        if (rowEditLayer === 'experience') body.entry.category = '手动'
        if (rowEditLayer === 'pinned') { body.index = Number(rowEditId); body.id = undefined }
        post('/api/memory', body)
          .then(function (r) { setBusy(''); if (r && r.ok) { cancelRowEdit(); refresh() } else setErr((r && r.error) || '修改失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function journalAction(id, action) {        if (busy) return
        setBusy('journal')
        post('/api/journal', { id: id, action: action })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '操作失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      function restoreBackup(name) {
        if (busy) return
        if (window.confirm && !window.confirm('恢复备份会覆盖当前记忆，确定？')) return
        setBusy('restore')
        post('/api/restore', { backup: name })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '恢复失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      var counts = (data && data.counts) || {}
      var meta = (data && data.meta) || {}
      var settings = meta.settings || {}
      var health = (data && data.health) || {}
      var capture = health.capture || {}
      var compile = (data && data.compile) || {}
      var pending = counts.journalPending || 0
      var facts = ((data && data.facts) || []).slice(-20).reverse()
      var candidates = (data && data.experienceCandidates) || []
      var manual = ((data && data.memory) || []).slice(-8).reverse()
      var pinned = ((data && data.pinned) || []).slice(-8).reverse()
      var experience = ((data && data.experience) || []).slice(-8).reverse()
      var journal = ((data && data.journal && data.journal.items) || []).slice(0, 20)
      var tabs = [['overview', '概览'], ['memory', '记忆'], ['experience', '经验'], ['inbox', '收件箱'], ['persona', '人格'], ['maintenance', '维护']]

      function stats() {
        return h('div', { className: 'lan-stats' },
          Stat('常驻', counts.pinned || 0, '始终注入'),
          Stat('手动记忆', counts.memory || 0, '明确记住'),
          Stat('自动事实', counts.facts || 0, '参与画像'),
          Stat('经验', counts.experience || 0, '方法/踩坑'),
          Stat('待编译', pending, pending ? '自动处理' : '干净'))
      }

      function switchRow(title, desc, key, value) {
        return h('div', { className: 'lan-switch-row' },
          h('div', { className: 'lan-switch-copy' }, h('b', null, title), h('span', null, desc)),
          h(Switch, { checked: value !== false, disabled: !!busy, onChange: function (v) { toggle(key, v) } }))
      }

      function factRows() {
        if (!facts.length) return h('div', { className: 'lan-empty' }, '还没有自动事实；编译成功后会出现在这里。')
        return facts.map(function (f) {
          if (editId === f.id) {
            return h('div', { className: 'lan-fact-row', key: f.id },
              h('input', { className: 'lan-input', style: { flex: 1 }, value: editText, onChange: function (e) { setEditText(e.target.value) } }),
              h('span', { className: 'lan-fact-actions' },
                h('button', { type: 'button', className: 'lan-btn primary', onClick: saveEdit, disabled: !!busy }, '保存'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { setEditId(''); setEditText('') } }, '取消')))
          }
          return h('div', { className: 'lan-fact-row', key: f.id },
            h('div', { className: 'lan-fact-text' }, f.fact),
            h('span', { className: 'lan-fact-actions' },
              (f.tags || []).length ? h('span', { className: 'lan-tag' }, f.tags.slice(0, 2).join(' · ')) : null,
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { setEditId(f.id); setEditText(f.fact) } }, '编辑'),
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { deleteFact(f.id) } }, '删除')))
        })
      }

      function mergeRows() {
        if (!factClusters.length) return null
        return h('div', { style: { marginTop: 10 } },
          h('div', { className: 'lan-hint' }, '发现 ' + factClusters.length + ' 组相似事实；先预览，确认后再合并。合并会保留最长的一条，其余写墓碑。'),
          factClusters.slice(0, 10).map(function (c) {
            return h('div', { className: 'lan-memory-row', key: (c.ids || []).join('-') },
              h('div', { className: 'lan-memory-text' }, c.preview),
              h('span', { className: 'lan-fact-actions' },
                h('span', { className: 'lan-tag' }, c.ids.length + ' 条'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { applyFactMerge(c) }, disabled: !!busy }, '合并')))
          }),
          h('button', { type: 'button', className: 'lan-btn', onClick: function () { setFactClusters([]) } }, '收起'))
      }

      function candidateRows() {
        if (!candidates.length) return null
        return h('div', { style: { marginTop: 10, marginBottom: 4 } },
          h('div', { className: 'lan-hint' }, '编译产出的经验候选；接受后才进入经验库。'),
          candidates.map(function (c) {
            return h('div', { className: 'lan-memory-row', key: c.id },
              h('div', { className: 'lan-memory-text' }, '[' + (c.category || '经验') + '] ' + c.content),
              h('span', { className: 'lan-fact-actions' },
                h('span', { className: 'lan-tag' }, '候选'),
                h('button', { type: 'button', className: 'lan-btn primary', onClick: function () { candidateAction('accept', c.id) }, disabled: !!busy }, '接受'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { candidateAction('dismiss', c.id) }, disabled: !!busy }, '忽略')))
          }))
      }

      return h('div', { className: 'lan-settings' },
        h('div', { className: 'lan-hero' },
          h('div', { className: 'lan-hero-avatar' }, '🐋'),
          h('div', null,
            h('h1', { className: 'lan-hero-title' }, '澜记忆'),
            h('div', { className: 'lan-hero-sub' }, '本地文件驱动的记忆与人格层；所有管理都在这一页。')),
          h('span', { className: 'lan-status', 'data-on': data ? '1' : '0' }, data ? '运行中' : '读取中')),
        err ? h('div', { className: 'lan-error' }, err) : null,

        h('div', { className: 'lan-tabs' }, tabs.map(function (item) {
          return h('button', { key: item[0], type: 'button', className: 'lan-tab', 'data-on': tab === item[0] ? '1' : '0', onClick: function () { setTab(item[0]) } }, item[1])
        })),

        tab === 'overview' ? h(React.Fragment, null,
          stats(),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '常用操作')),
            h('div', { className: 'lan-actions' },
              h('button', { type: 'button', className: 'lan-btn primary', onClick: function () { run('compile') }, disabled: !!busy }, busy === 'compile' ? '编译中…' : '立即编译'),
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { run('backup', '/api/backup') }, disabled: !!busy }, '立即备份'),
              h('button', { type: 'button', className: 'lan-btn', onClick: refresh, disabled: !!busy }, '刷新')),
            h('p', { className: 'lan-hint' }, '自动编译失败会保留待编译和旧画像；编辑与删除会先备份。')),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '运行状态')),
            Row('数据目录', h('code', null, String((data && data.dataDir) || '…'))),
            Row('会话捕获', (capture.enabled ? '已开启' : '已关闭') + (capture.lastFlush ? ' · ' + formatWhen(capture.lastFlush) : '')),
            Row('自动编译', (compile.auto === false ? '已关闭' : '已开启') + ' · ' + (compile.state || 'idle') + (compile.model ? ' · ' + compile.model : '')),
            Row('待编译', pending ? pending + ' 条' : '没有待编译线索'),
            Row('最近编译', compile.lastRunAt ? formatWhen(compile.lastRunAt) + ' · ' + (compile.facts || 0) + ' 条事实' : '还没有编译过'),
            compile.lastError ? h('p', { className: 'lan-error' }, '最近编译错误：' + compile.lastError) : null),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '自动化')),
            switchRow('会话捕获', '每轮写一条本机 journal；关闭后不再积累线索。', 'captureEnabled', settings.captureEnabled),
            switchRow('自动编译', '待编译达到 ' + (settings.autoCompileThreshold || 6) + ' 条或空闲时自动编译。', 'autoCompile', settings.autoCompile))) : null,

        tab === 'memory' ? h(React.Fragment, null,
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' },
              h('div', { className: 'lan-card-title' }, '记忆画像（可直接编辑）'),
              h('button', { type: 'button', className: 'lan-btn primary', onClick: saveProfile, disabled: !!busy }, '保存画像')),
            h('textarea', { className: 'lan-editor', value: draft, spellCheck: false, onChange: function (e) { setDraft(e.target.value) } }),
            h('p', { className: 'lan-hint' }, '下一次编译会以这份画像为当前输入；保存前自动备份。')),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '自动事实（自动抽取，参与画像）'),
              h('div', { className: 'lan-actions' },
                h('button', { className: 'lan-btn', type: 'button', onClick: previewFactMerge, disabled: !!busy }, busy === 'merge-preview' ? '查找中…' : '合并相似事实'),
                h('button', { className: 'lan-btn', type: 'button', onClick: refresh }, '刷新'))),
            h('p', { className: 'lan-hint' }, '自动编译从摘要里抽取；适合偏好、长期决定。不要把它当手动记忆。'),
            factRows(),
            mergeRows(),
            h('div', { className: 'lan-actions', style: { marginTop: 10 } },
              h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: '新增自动事实', value: newFact, onChange: function (e) { setNewFact(e.target.value) } }),
              h('button', { type: 'button', className: 'lan-btn primary', onClick: addFact, disabled: !!busy || !newFact.trim() }, '添加')),
            h('p', { className: 'lan-hint' }, '事实改动会触发一次强制重编译。')),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '手动记忆（明确记住，始终注入）')),
            h('p', { className: 'lan-hint' }, '用户明确说“记住”或反复强调的事实/决定；自动编译不会写这里。'),
            h('div', { className: 'lan-actions' },
              h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: '新增手动记忆', value: memDraft, onChange: function (e) { setMemDraft(e.target.value) } }),
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { addManual('memory', memDraft); setMemDraft('') }, disabled: !!busy }, '添加')),
            manual.map(function (m) {
              if (rowEditLayer === 'memory' && rowEditId === m.id) {
                return h('div', { className: 'lan-memory-row', key: m.id },
                  h('input', { className: 'lan-input', style: { flex: 1 }, value: rowEditText, onChange: function (e) { setRowEditText(e.target.value) } }),
                  h('span', { className: 'lan-fact-actions' },
                    h('button', { type: 'button', className: 'lan-btn primary', onClick: saveRowEdit, disabled: !!busy }, '保存'),
                    h('button', { type: 'button', className: 'lan-btn', onClick: cancelRowEdit }, '取消')))
              }
              return h('div', { className: 'lan-memory-row', key: m.id }, h('div', { className: 'lan-memory-text' }, m.content), h('span', { className: 'lan-fact-actions' },
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { startRowEdit('memory', m.id, m.content) } }, '编辑'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { deleteManual('memory', m.id) } }, '删除')))
            })),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '常驻（始终注入，最高优先级）')),
            h('p', { className: 'lan-hint' }, '只放身份、硬约束、长期不变的偏好；越少越好。'),
            h('div', { className: 'lan-actions' },
              h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: '新增常驻记忆', value: pinnedDraft, onChange: function (e) { setPinnedDraft(e.target.value) } }),
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { addManual('pinned', pinnedDraft, { tag: '通用' }); setPinnedDraft('') }, disabled: !!busy }, '添加常驻')),
            pinned.map(function (p, i) {
              if (rowEditLayer === 'pinned' && rowEditId === String(p.index)) {
                return h('div', { className: 'lan-memory-row', key: 'p' + i },
                  h('input', { className: 'lan-input', style: { flex: 1 }, value: rowEditText, onChange: function (ev) { setRowEditText(ev.target.value) } }),
                  h('span', { className: 'lan-fact-actions' },
                    h('button', { type: 'button', className: 'lan-btn primary', onClick: saveRowEdit, disabled: !!busy }, '保存'),
                    h('button', { type: 'button', className: 'lan-btn', onClick: cancelRowEdit }, '取消')))
              }
              return h('div', { className: 'lan-memory-row', key: 'p' + i }, h('div', { className: 'lan-memory-text' }, '[' + (p.tag || '通用') + '] ' + p.content), h('span', { className: 'lan-fact-actions' },
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { startRowEdit('pinned', p.index, p.content) } }, '编辑'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { deleteManual('pinned', '', p.index) } }, '删除')))
            })),
        ) : null,

        tab === 'experience' ? h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '经验（方法/踩坑，不参与画像）')),
          h('p', { className: 'lan-hint' }, '助手可复用的做法和错误教训；不是用户记忆，不会进 memory.md。'),
          candidateRows(),
          h('div', { className: 'lan-actions' },
            h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: '新增经验', value: expDraft, onChange: function (e) { setExpDraft(e.target.value) } }),
            h('button', { type: 'button', className: 'lan-btn', onClick: function () { addManual('experience', expDraft, { category: '手动' }); setExpDraft('') }, disabled: !!busy }, '添加经验')),
          experience.map(function (e) {
            if (rowEditLayer === 'experience' && rowEditId === e.id) {
              return h('div', { className: 'lan-memory-row', key: e.id },
                h('input', { className: 'lan-input', style: { flex: 1 }, value: rowEditText, onChange: function (ev) { setRowEditText(ev.target.value) } }),
                h('span', { className: 'lan-fact-actions' },
                  h('button', { type: 'button', className: 'lan-btn primary', onClick: saveRowEdit, disabled: !!busy }, '保存'),
                  h('button', { type: 'button', className: 'lan-btn', onClick: cancelRowEdit }, '取消')))
            }
            return h('div', { className: 'lan-memory-row', key: e.id }, h('div', { className: 'lan-memory-text' }, '[' + (e.category || '经验') + '] ' + e.content), h('span', { className: 'lan-fact-actions' },
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { startRowEdit('experience', e.id, e.content) } }, '编辑'),
              h('button', { type: 'button', className: 'lan-btn', onClick: function () { deleteManual('experience', e.id) } }, '删除')))
          })) : null,

        tab === 'inbox' ? h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '收件箱（自动编译，保留原文）'), h('button', { type: 'button', className: 'lan-btn', onClick: refresh }, '刷新')),
          h('p', { className: 'lan-hint' }, '正常不需要手动整理；这里只是历史留档，可提升为手动记忆或忽略。'),
          journal.map(function (j) {
            return h('div', { className: 'lan-memory-row', key: j.id },
              h('div', { className: 'lan-memory-text' }, h('div', null, String(j.user || '').slice(0, 140)), h('div', { style: { opacity: 0.6 } }, String(j.assistant || '').replace(/<[^>]+>/g, ' ').slice(0, 140))),
              h('span', { className: 'lan-fact-actions' },
                h('span', { className: 'lan-tag' }, j.pending ? '待编译' : '已处理'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { journalAction(j.id, 'promote') } }, '提升'),
                h('button', { type: 'button', className: 'lan-btn', onClick: function () { journalAction(j.id, 'dismiss') } }, '忽略')))
          })) : null,

        tab === 'persona' ? h('section', { className: 'lan-card' },
          h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '人格（SOUL + MOOD）'), h('button', { type: 'button', className: 'lan-btn primary', onClick: savePersona, disabled: !!busy }, '保存人格')),
          h('div', { className: 'lan-hint' }, 'SOUL'),
          h('textarea', { className: 'lan-editor', value: soul, spellCheck: false, onChange: function (e) { setSoul(e.target.value) } }),
          h('div', { className: 'lan-hint', style: { marginTop: 10 } }, 'MOOD 契约'),
          h('textarea', { className: 'lan-editor', value: moodDraft, spellCheck: false, onChange: function (e) { setMoodDraft(e.target.value) } })) : null,

        tab === 'maintenance' ? h(React.Fragment, null,
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '编译模型与隐私')),
            h('div', { className: 'lan-actions' },
              h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: 'provider（留空用默认）', value: provider, onChange: function (e) { setProvider(e.target.value) } }),
              h('input', { className: 'lan-input', style: { flex: 1 }, placeholder: 'model（留空用默认）', value: model, onChange: function (e) { setModel(e.target.value) } }),
              h('button', { type: 'button', className: 'lan-btn', onClick: saveModels, disabled: !!busy }, '保存模型')),
            h('p', { className: 'lan-hint' }, '自动编译会把 journal / 摘要发送给该 provider；捕获本身仍只写本机。')),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '编译调度')),
            h('div', { className: 'lan-actions' },
              h('input', { className: 'lan-input', style: { flex: 1 }, type: 'number', min: 1, value: threshold, onChange: function (e) { setThreshold(e.target.value) }, title: '待编译条数阈值' }),
              h('span', { className: 'lan-hint', style: { margin: '8px 0' } }, '条待编译'),
              h('input', { className: 'lan-input', style: { flex: 1 }, type: 'number', min: 1, value: idle, onChange: function (e) { setIdle(e.target.value) }, title: '空闲分钟数' }),
              h('span', { className: 'lan-hint', style: { margin: '8px 0' } }, '分钟无对话后'),
              h('button', { type: 'button', className: 'lan-btn', onClick: saveSchedule, disabled: !!busy }, '保存调度')),
            h('p', { className: 'lan-hint' }, '达到任一条件时后台编译；编译失败会保留线索并在下次重试。')),
          h('section', { className: 'lan-card' },
            h('div', { className: 'lan-card-head' }, h('div', { className: 'lan-card-title' }, '备份与导出'), h('button', { type: 'button', className: 'lan-btn', onClick: function () { run('backup', '/api/backup') } }, '立即备份')),
            h('button', { type: 'button', className: 'lan-btn', onClick: function () { window.open(BASE + '/api/export', '_blank', 'noopener') } }, '导出 JSON'),
            h('button', { type: 'button', className: 'lan-btn', onClick: function () { run('undo') }, disabled: !!busy }, '撤销上次整理'),
            backups.length ? backups.slice(0, 10).map(function (b) {
              var name = typeof b === 'string' ? b : (b.name || b.dir || '')
              return h('div', { className: 'lan-memory-row', key: name }, h('div', { className: 'lan-memory-text' }, name), h('button', { type: 'button', className: 'lan-btn', onClick: function () { restoreBackup(name) } }, '恢复'))
            }) : h('div', { className: 'lan-empty' }, '还没有备份。'))) : null,

        h('p', { className: 'lan-footer' }, '记忆、事实、收件箱、人格、备份都在本页。'))
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
          }, SettingsPageV2)
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
