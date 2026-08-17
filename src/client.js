/* dsh-lan-memory — browser half (__ModuleLoader__ bundle) v1.2
 * Registers two additive surfaces:
 *   1. settings.section — Lan 设置页：记忆浏览/编辑（pinned/memory/experience 三层）
 *      + 人格编辑（SOUL/MOOD 文本域）+ Dream 手动触发与结果展示
 *   2. conversation.chat.turnTail — assistant 消息下方 mood 状态池卡片
 * Data flows over /api/dsh-lan-memory/{status,mood,memory,persona,dream} (loopback-only host routes).
 */
console.log('[dsh-lan-memory] client boot v1.2')
window.__ModuleLoader__.load({
  id: 'dsh-lan-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    // ───────────────────────── 样式 ─────────────────────────
    var STYLE_ID = 'dsh-lan-memory-styles'
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = [
        '.lan-mood-card{display:flex;flex-direction:column;gap:8px;margin:6px 0 2px;padding:10px 12px;border:1px solid var(--dsh-color-border,rgba(128,128,128,.25));border-radius:10px;background:var(--dsh-color-background,rgba(128,128,128,.06));font-size:13px;line-height:1.6}',
        '.lan-mood-head{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--dsh-color-text,inherit);cursor:pointer;user-select:none}',
        '.lan-mood-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(139,92,246,.18);color:#a78bfa}',
        '.lan-mood-body{display:flex;flex-direction:column;gap:6px}',
        '.lan-mood-row{display:flex;gap:8px}',
        '.lan-mood-label{flex:0 0 84px;font-weight:600;color:var(--dsh-color-text-secondary,rgba(128,128,128,.9))}',
        '.lan-mood-vibe{font-size:14px;font-weight:600;color:#a78bfa}',
        '.lan-mood-list{margin:0;padding-left:16px}.lan-mood-list li{margin:2px 0}',
        '.lan-settings-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px;max-width:640px;font-size:13px}',
        '.lan-settings-block{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsh-color-border,rgba(128,128,128,.25));border-radius:10px;background:var(--dsh-color-background,rgba(128,128,128,.05))}',
        '.lan-settings-title{font-weight:600;font-size:14px}',
        '.lan-settings-meta{color:var(--dsh-color-text-secondary,rgba(128,128,128,.85))}',
        '.lan-settings-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
        '.lan-settings-note{color:var(--dsh-color-text-secondary,rgba(128,128,128,.7));font-size:12px}',
        '.lan-tabs{display:flex;gap:6px;flex-wrap:wrap}',
        '.lan-tab{padding:4px 12px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:transparent;color:var(--dsh-color-text,inherit);cursor:pointer;font-size:12px}',
        '.lan-tab[data-active="true"]{background:rgba(124,92,255,.18);border-color:#7c5cff;color:#a78bfa}',
        '.lan-item{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid rgba(128,128,128,.15);border-radius:8px;background:rgba(128,128,128,.04)}',
        '.lan-item-main{flex:1;min-width:0}',
        '.lan-item-tag{display:inline-block;padding:0 8px;border-radius:999px;background:rgba(124,92,255,.15);color:#a78bfa;font-size:11px;margin-right:6px}',
        '.lan-item-text{word-break:break-all;line-height:1.5}',
        '.lan-del{background:transparent;border:none;color:rgba(255,90,90,.8);cursor:pointer;font-size:12px;padding:2px 4px}',
        '.lan-add-row{display:flex;gap:6px;flex-wrap:wrap}',
        '.lan-input{flex:1;min-width:120px;padding:5px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:var(--dsh-color-background,transparent);color:var(--dsh-color-text,inherit);font-size:12px}',
        '.lan-btn{padding:5px 14px;border-radius:6px;border:1px solid rgba(124,92,255,.5);background:rgba(124,92,255,.15);color:#a78bfa;cursor:pointer;font-size:12px}',
        '.lan-btn:hover{background:rgba(124,92,255,.25)}',
        '.lan-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.lan-textarea{width:100%;min-height:140px;padding:8px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:var(--dsh-color-background,transparent);color:var(--dsh-color-text,inherit);font-size:12px;font-family:inherit;line-height:1.5;resize:vertical;box-sizing:border-box}',
        '.lan-dream-result{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(124,92,255,.1);font-size:12px;line-height:1.6}',
        '.lan-empty{color:var(--dsh-color-text-secondary,rgba(128,128,128,.6));padding:8px;text-align:center;font-size:12px}',
      ].join('')
      document.head.appendChild(tag)
    }

    // ───────────────────────── API ─────────────────────────
    function apiGet(path) {
      return fetch(path, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .catch(function () { return null })
    }
    function apiSend(path, method, body) {
      return fetch(path, {
        method: method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (r) { return r.json() }).catch(function () { return null })
    }

    // ───────────────────────── mood 卡片 ─────────────────────────
    function MoodCard(props) {
      var matched = props.matched
      var seq = matched && typeof matched === 'object' ? matched.seq : null
      var moodState = useState(null)
      var mood = moodState[0]
      var setMood = moodState[1]
      var openState = useState(true)
      var open = openState[0]
      var setOpen = openState[1]
      useEffect(function () {
        var alive = true
        var timer = null
        if (seq === null) return
        // 主机端在 agent/turn-stopping 时才解析 mood 入库，而本卡片挂载
        // 可能早于该事件完成：首次请求常落空。用指数退避重试（最长约 25s），
        // 拿到有内容的响应即停；刷新页面时数据早已就绪，一次即中。
        var attempts = 0
        function hasContent(res) {
          return !!(res && (res.vibe || (res.sparks && res.sparks.length)
            || (res.reflections && res.reflections.length)
            || (res.will && res.will.length)))
        }
        function load() {
          apiGet('/api/dsh-lan-memory/mood?seq=' + encodeURIComponent(seq)).then(function (res) {
            if (!alive) return
            if (hasContent(res)) {
              setMood(res)
            } else if (attempts < 6) {
              attempts += 1
              timer = setTimeout(load, 400 * Math.pow(2, attempts - 1))
            }
          })
        }
        load()
        return function () { alive = false; if (timer !== null) clearTimeout(timer) }
      }, [seq])
      if (!mood) return null
      function item(label, list) {
        if (!list || !list.length) return null
        return h('div', { className: 'lan-mood-row' },
          h('span', { className: 'lan-mood-label' }, label),
          h('ul', { className: 'lan-mood-list' }, list.map(function (x, i) { return h('li', { key: i }, x) })))
      }
      return h('div', { className: 'lan-mood-card' },
        h('div', { className: 'lan-mood-head', onClick: function () { setOpen(!open) } },
          h('span', { className: 'lan-mood-badge' }, 'mood'),
          h('span', null, open ? '状态池 ▾' : '状态池 ▸')),
        open ? h('div', { className: 'lan-mood-body' },
          mood.vibe ? h('div', { className: 'lan-mood-row' },
            h('span', { className: 'lan-mood-label' }, 'Vibe'),
            h('span', { className: 'lan-mood-vibe' }, mood.vibe)) : null,
          item('Sparks', mood.sparks),
          item('Reflections', mood.reflections),
          item('Will', mood.will)) : null)
    }

    // ───────────────────────── 记忆编辑器（单层） ─────────────────────────
    function MemoryLayerEditor(props) {
      var layer = props.layer          // 'pinned' | 'memory' | 'experience'
      var title = props.title
      var items = props.items
      var onChanged = props.onChanged
      var addFields = props.addFields   // 附加输入字段名数组（如 pinned 的 tag）
      var emptyText = props.emptyText

      var fieldStates = {}
      addFields.forEach(function (f) { fieldStates[f] = useState('') })
      var contentState = useState('')
      var content = contentState[0]
      var setContent = contentState[1]
      var busy = useState(false)

      function addItem() {
        var body = { content: content }
        addFields.forEach(function (f) { body[f] = fieldStates[f][0] })
        busy[1](true)
        apiSend('/api/dsh-lan-memory/memory?layer=' + layer, 'POST', body).then(function (res) {
          busy[1](false)
          if (res && res.ok) {
            setContent('')
            addFields.forEach(function (f) { fieldStates[f][1]('') })
            onChanged()
          }
        })
      }
      function delItem(item) {
        apiSend('/api/dsh-lan-memory/memory?layer=' + layer + '&id=' + encodeURIComponent(item.id), 'DELETE').then(function () {
          onChanged()
        })
      }

      return h('div', { className: 'lan-settings-block' },
        h('span', { className: 'lan-settings-title' }, title + '（' + items.length + ' 条）'),
        h('div', { className: 'lan-add-row' },
          addFields.map(function (f) {
            return h('input', {
              key: f, className: 'lan-input', placeholder: f,
              value: fieldStates[f][0], onChange: function (e) { fieldStates[f][1](e.target.value) },
            })
          }),
          h('input', {
            className: 'lan-input', placeholder: '内容', value: content,
            onChange: function (e) { setContent(e.target.value) },
          }),
          h('button', { className: 'lan-btn', onClick: addItem, disabled: busy[0] || !content.trim() }, '添加')),
        items.length === 0 ? h('div', { className: 'lan-empty' }, emptyText) :
        items.map(function (item, i) {
          return h('div', { key: item.id || i, className: 'lan-item' },
            h('div', { className: 'lan-item-main' },
              item.tag ? h('span', { className: 'lan-item-tag' }, item.tag) : null,
              (item.category ? h('span', { className: 'lan-item-tag' }, item.category) : null),
              (item.tags && item.tags.length ? item.tags.map(function (t) { return h('span', { key: t, className: 'lan-item-tag' }, t) }) : null),
              h('span', { className: 'lan-item-text' }, item.content)),
            h('button', { className: 'lan-del', onClick: function () { delItem(item) } }, '删'))
        }))
    }

    // ───────────────────────── 设置页 ─────────────────────────
    function SettingsPage(props) {
      var statusState = useState(null)
      var status = statusState[0]
      var dataState = useState({ pinned: [], memory: [], experience: [] })
      var data = dataState[0]
      var personaState = useState(null)
      var persona = personaState[0]
      var tabState = useState('memory')
      var tab = tabState[0]
      var dreamState = useState(null)
      var dream = dreamState[0]
      var dreamBusy = useState(false)
      var soulState = useState('')
      var moodContractState = useState('')

      function refresh() {
        apiGet('/api/dsh-lan-memory/status').then(function (r) { if (r) statusState[1](r) })
        apiGet('/api/dsh-lan-memory/memory?layer=pinned').then(function (r) { if (r) dataState[1](function (d) { return { pinned: r.items, memory: d.memory, experience: d.experience } }) })
        apiGet('/api/dsh-lan-memory/memory?layer=memory').then(function (r) { if (r) dataState[1](function (d) { return { pinned: d.pinned, memory: r.items, experience: d.experience } }) })
        apiGet('/api/dsh-lan-memory/memory?layer=experience').then(function (r) { if (r) dataState[1](function (d) { return { pinned: d.pinned, memory: d.memory, experience: r.items } }) })
        apiGet('/api/dsh-lan-memory/persona').then(function (r) {
          if (r) {
            personaState[1](r)
            soulState[1](r.soul)
            moodContractState[1](r.moodContract)
          }
        })
      }
      useEffect(function () { refresh() }, [])

      function runDream() {
        dreamBusy[1](true)
        apiSend('/api/dsh-lan-memory/dream', 'POST').then(function (res) {
          dreamBusy[1](false)
          if (res) { dreamState[1](res); refresh() }
        })
      }
      function savePersona() {
        apiSend('/api/dsh-lan-memory/persona', 'PUT', { soul: soulState[0], moodContract: moodContractState[0] }).then(function () {
          refresh()
        })
      }

      var tabs = [
        { id: 'pinned', label: '常驻记忆' },
        { id: 'memory', label: '检索记忆' },
        { id: 'experience', label: '经验库' },
        { id: 'persona', label: '人格' },
        { id: 'dream', label: '整理' },
      ]

      return h('div', { className: 'lan-settings-root' },
        h('div', { className: 'lan-settings-block' },
          h('span', { className: 'lan-settings-title' }, '澜 · Lan 记忆与人格'),
          h('span', { className: 'lan-settings-note' }, '鲸鱼娘人格 v1.1。数据目录：' + (status ? status.dataDir : '…') + ' ｜ 常驻 ' + (status ? status.pinned : '…') + ' ｜ 检索 ' + (status ? status.memory : '…') + ' ｜ 经验 ' + (status ? status.experience : '…')),
          h('div', { className: 'lan-tabs' },
            tabs.map(function (t) {
              return h('button', {
                key: t.id, className: 'lan-tab', 'data-active': String(tab === t.id),
                onClick: function () { tabState[1](t.id) },
              }, t.label)
            }))),

        tab === 'pinned' ? h(MemoryLayerEditor, {
          layer: 'pinned', title: '常驻记忆', items: data.pinned, onChanged: refresh,
          addFields: ['tag'], emptyText: '暂无常驻记忆（说"记住 X"或在此添加）',
        }) : null,

        tab === 'memory' ? h(MemoryLayerEditor, {
          layer: 'memory', title: '检索记忆', items: data.memory, onChanged: refresh,
          addFields: [], emptyText: '暂无检索记忆',
        }) : null,

        tab === 'experience' ? h(MemoryLayerEditor, {
          layer: 'experience', title: '经验库', items: data.experience, onChanged: refresh,
          addFields: ['category'], emptyText: '暂无经验',
        }) : null,

        tab === 'persona' && persona ? h('div', { className: 'lan-settings-block' },
          h('span', { className: 'lan-settings-title' }, '人格底稿（SOUL）'),
          h('textarea', { className: 'lan-textarea', value: soulState[0], onChange: function (e) { soulState[1](e.target.value) } }),
          h('span', { className: 'lan-settings-title' }, '状态池契约（MOOD）'),
          h('textarea', { className: 'lan-textarea', value: moodContractState[0], onChange: function (e) { moodContractState[1](e.target.value) } }),
          h('div', { className: 'lan-settings-row' },
            h('span', { className: 'lan-settings-note' }, '保存后立即生效（下轮组装注入新人格）'),
            h('button', { className: 'lan-btn', onClick: savePersona }, '保存人格'))) : null,

        tab === 'dream' ? h('div', { className: 'lan-settings-block' },
          h('span', { className: 'lan-settings-title' }, '记忆整理'),
          h('span', { className: 'lan-settings-note' }, '一键去重合并：常驻记忆、检索记忆、经验库逐层整理，语义重复的合并为一条，完全相同的一行去掉。整理前自动备份。' + (status && status.dream ? ' 上次运行 ' + String(status.dream.lastRunAt).replace('T', ' ').slice(0, 16) : '')),
          h('div', { className: 'lan-settings-row' },
            h('button', { className: 'lan-btn', onClick: runDream, disabled: dreamBusy[0] }, dreamBusy[0] ? '整理中…' : '一键整理')),
          dream && dream.stats ? h('div', { className: 'lan-dream-result' },
            '完成：常驻 ' + dream.stats.before.pinned + '→' + dream.stats.after.pinned + ' 条，检索 ' + dream.stats.before.memory + '→' + dream.stats.after.memory + ' 条，经验 ' + dream.stats.before.experience + '→' + dream.stats.after.experience + ' 条，耗时 ' + Math.round(dream.stats.tookMs / 1000) + 's') : null,
          dream && dream.error ? h('div', { className: 'lan-dream-result' }, '整理失败：' + dream.error) : null) : null)
    }

    // ───────────────────────── 插件主体 ─────────────────────────
    function apply(ctx) {
      try { ensureStyle() } catch (e) { console.warn('[dsh-lan-memory] style inject failed', e) }
      var slots = ctx.slots
      if (!slots) { console.warn('[dsh-lan-memory] slots service unavailable'); return }
      ctx.effect(function () {
        return function () {
          var tag = document.getElementById(STYLE_ID)
          if (tag) tag.remove()
        }
      }, 'dsh-lan-memory: styles')
      try {
        // turnTail 链：priority 排最后(10)，better-sidebar(-1)/deliverables(0) 的 produced-files 优先
        slots.inject('conversation.chat.turnTail', function () {
          return slots.register(
            { name: 'conversation.chat.turnTail', select: function (owner) { return { seq: owner && owner.seq } }, priority: 10, registrant: 'dsh-lan-memory' },
            MoodCard)
        })
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'lan', order: 30, label: function () { return 'Lan' }, registrant: 'dsh-lan-memory' },
            function (p) { return h(SettingsPage, { close: p && p.close }) })
        })
      } catch (e) {
        console.warn('[dsh-lan-memory] slot registration failed', e)
      }
      // ───────── mood 布局：卡片移到消息正文顶部 + 隐藏正文原始文本 ─────────
      // 官方没有 turnHead 槽位，卡片注册在 turnTail（消息尾部），这里在 DOM 层补救：
      //   1) 把 .lan-mood-card 移到所属消息正文的顶部（mood 原始文本之前）；
      //   2) 隐藏正文里 <mood>...</mood> 的原始文本（兼容两种渲染：标签被转义为
      //      字面文本、或未知 HTML 标签被原样渲染为 <mood> 元素）。
      // 消息容器启发式定位：从卡片向上找第一个 textContent 含 '<mood>' 的祖先。
      // React 重渲染重建节点时（无标记），observer 会再次处理。
      function layoutMoodCards() {
        if (typeof document === 'undefined' || !document.querySelectorAll) return
        var cards = document.querySelectorAll('.lan-mood-card')
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i]
          if (card.getAttribute('data-lan-laid-out') === '1') continue
          var el = card.parentNode
          var msgRoot = null
          for (var depth = 0; depth < 10 && el; depth++) {
            if (el.textContent && el.textContent.indexOf('<mood>') !== -1 && el.contains(card)) {
              msgRoot = el
              break
            }
            el = el.parentNode
          }
          if (!msgRoot) continue
          try {
            var anchor = null
            var hiding = false
            var kids = msgRoot.children || []
            for (var j = 0; j < kids.length; j++) {
              var kid = kids[j]
              var txt = kid.textContent || ''
              var isMoodTag = kid.tagName && kid.tagName.toLowerCase() === 'mood'
              if (!hiding && (txt.indexOf('<mood>') !== -1 || isMoodTag)) {
                hiding = true
                if (anchor === null) anchor = kid
              }
              if (hiding) {
                kid.style.display = 'none'
                if (txt.indexOf('</mood>') !== -1 || isMoodTag) hiding = false
              }
            }
            // 卡片插到 mood 原始文本之前（消息正文顶部）；无 anchor 则插到容器最前
            if (anchor !== null && anchor.parentNode && anchor !== card) {
              anchor.parentNode.insertBefore(card, anchor)
            } else if (msgRoot.firstChild !== card) {
              msgRoot.insertBefore(card, msgRoot.firstChild)
            }
            card.setAttribute('data-lan-laid-out', '1')
          } catch (e) { /* 布局失败无害，后续轮次再试 */ }
        }
      }
      try {
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
          var moodObserver = new MutationObserver(function () { layoutMoodCards() })
          moodObserver.observe(document.body, { childList: true, subtree: true })
          ctx.effect(function () {
            return function () { try { moodObserver.disconnect() } catch (e) {} }
          }, 'dsh-lan-memory: mood layout observer')
          setTimeout(layoutMoodCards, 600)
          setTimeout(layoutMoodCards, 2500)
        }
      } catch (e) { console.warn('[dsh-lan-memory] mood layout observer failed', e) }
      console.log('[dsh-lan-memory] client ready v1.3: settings page (memory/persona/dream) + mood card on top')
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
