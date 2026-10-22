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

    /** 把本轮 <mood> 原文从正文里隐去；失败就保留原文（卡片仍显示）。 */
    function hideRawMood(cardEl) {
      if (typeof document === 'undefined' || !cardEl) return
      var root = cardEl.parentNode
      for (var depth = 0; depth < 10 && root; depth++) {
        if (root.textContent && root.textContent.indexOf('<mood>') !== -1 && root.contains(cardEl)) break
        root = root.parentNode
      }
      if (!root || root === cardEl) return
      var hiding = false
      var touched = []
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
      var node
      while ((node = walker.nextNode())) {
        if (cardEl.contains(node)) continue
        var text = node.nodeValue || ''
        var hasOpen = text.indexOf('<mood>') !== -1
        var hasClose = text.indexOf('</mood>') !== -1
        if (!hiding && !hasOpen) continue
        if (!hiding && hasOpen) hiding = true
        if (hiding) {
          // 同一文本节点里若 </mood> 后面还有正文，保留后缀，避免误伤
          var suffix = ''
          if (hasClose) suffix = text.slice(text.indexOf('</mood>') + 7)
          node.nodeValue = suffix
          if (node.parentElement && touched.indexOf(node.parentElement) === -1) touched.push(node.parentElement)
          if (hasClose) hiding = false
        }
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
          for (var d = 0; d < 10 && root; d++) {
            if (root.textContent && root.textContent.indexOf('<mood>') !== -1) break
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

    function statCard(label, value, hint) {
      return h('div', { key: label, style: cardStyle },
        h('div', { style: { fontSize: 20, fontWeight: 600, color: '#a78bfa' } }, String(value)),
        h('div', { style: { fontSize: 12, opacity: 0.85 } }, label),
        hint ? h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } }, hint) : null)
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

      function refresh() {
        apiState().then(function (d) {
          if (d && d.ok) { setData(d); setErr('') } else setErr((d && d.error) || '读取失败')
        }).catch(function (e) { setErr(String(e && e.message ? e.message : e)) })
      }
      useEffect(function () { refresh() }, [])

      function run(mode, path) {
        if (busy) return
        setBusy(mode)
        apiPost(path || '/api/organize', { mode: mode, ifMatch: data && data.etag })
          .then(function (r) { setBusy(''); if (r && r.ok) refresh(); else setErr((r && r.error) || '操作失败') })
          .catch(function (e) { setBusy(''); setErr(String(e && e.message ? e.message : e)) })
      }

      var counts = (data && data.counts) || {}
      var capture = (data && data.health && data.health.capture) || {}
      var iframe = h('iframe', {
        src: PANEL_URL,
        title: '澜记忆管理面板',
        style: { width: '100%', height: 560, border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, background: 'transparent' },
      })

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '澜记忆'),
          h('div', { style: { fontSize: 12, opacity: 0.6 } }, '本地文件 · 仅本机 · 零外部依赖'),
          h('div', { style: { flex: 1 } }),
          h('button', { style: btnStyle, onClick: refresh }, busy ? '处理中…' : '刷新')),
        err ? h('div', { style: { color: '#ff6b6b', fontSize: 12 } }, err) : null,
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          statCard('常驻', counts.pinned || 0, '始终注入'),
          statCard('检索记忆', counts.memory || 0, '按需召回'),
          statCard('经验', counts.experience || 0, '教训/方法'),
          statCard('待整理', counts.journalPending || 0, '收件箱')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { style: btnStyle, onClick: function () { window.open(PANEL_URL, '_blank', 'noopener') } }, '打开管理面板'),
          h('button', { style: btnStyle, disabled: !!busy, onClick: function () { run('apply-local') } }, busy === 'apply-local' ? '整理中…' : '本机整理'),
          h('button', { style: btnStyle, disabled: !!busy, onClick: function () { run('backup', '/api/backup') } }, busy === 'backup' ? '备份中…' : '立即备份')),
        h('div', { style: { fontSize: 12, opacity: 0.6 } }, '数据目录：' + String((data && data.dataDir) || '…')),
        h('div', { style: { fontSize: 12, opacity: 0.6 } },
          '捕获：' + (capture.enabled ? '开' : '关') + ' · 事件 ' + (capture.events || 0) + ' · 最近落盘 ' + (capture.lastFlush || '—')),
        h('div', { style: { fontSize: 12, opacity: 0.6 } }, '状态池卡片：每条回复下方显示本轮 Vibe/Sparks/Reflections/Will；原文自动隐去。'),
        iframe,
        h('div', { style: { fontSize: 12, opacity: 0.6 } }, '面板打不开时用上面的「打开管理面板」按钮；改人格/记忆/备份都在面板里。'))
    }

    var cardStyle = {
      flex: '1 1 120px',
      minWidth: 110,
      padding: '10px 12px',
      border: '1px solid rgba(128,128,128,.22)',
      borderRadius: 10,
      background: 'rgba(124,92,255,.06)',
    }
    var btnStyle = {
      padding: '5px 14px',
      borderRadius: 8,
      border: '1px solid rgba(124,92,255,.5)',
      background: 'rgba(124,92,255,.14)',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 12,
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
