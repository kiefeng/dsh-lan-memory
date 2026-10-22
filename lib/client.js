/* dsh-lan-memory v2 — 浏览器半区（__ModuleLoader__ bundle）
 *
 * 只做一件事：在 DSH 设置页注册「澜记忆」入口。
 * 完整管理界面由 host 半区在 /lan-memory/ 提供，这里用 iframe 嵌入；
 * 如果 iframe 被拦（CSP/浏览器策略），按钮仍可新标签打开，功能不丢。
 *
 * 不碰会话 DOM、不发消息、不改宿主行为——v1 的会话卡片与 DOM 布局补丁已移除。
 */
console.log('[dsh-lan-memory] client boot v2')
window.__ModuleLoader__.load({
  id: 'dsh-lan-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var BASE = '/lan-memory'
    var PANEL_URL = BASE + '/'

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
        h('div', { style: { fontSize: 12, opacity: 0.6 } },
          '数据目录：' + String((data && data.dataDir) || '…')),
        h('div', { style: { fontSize: 12, opacity: 0.6 } },
          '捕获：' + (capture.enabled ? '开' : '关') + ' · 事件 ' + (capture.events || 0) + ' · 最近落盘 ' + (capture.lastFlush || '—')),
        iframe,
        h('div', { style: { fontSize: 12, opacity: 0.6 } },
          '面板打不开时用上面的「打开管理面板」按钮；改人格/记忆/备份都在面板里。'))
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
        console.warn('[dsh-lan-memory] slots service unavailable; settings entry skipped')
        return
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
      console.log('[dsh-lan-memory] client ready v2 (settings entry only, UI served at /lan-memory/)')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
