// 真人剧工坊 · 浏览器半边
// 侧栏加「真人剧工坊」入口；主区域是 /realman-studio/ 的工作台页面（iframe），
// 布局与「分镜导演台」一致：概览 / 我的真人剧 / 生成历史 / 新建真人剧 / 工作流。
// 页面里点「新建真人剧」「在对话里继续」时 postMessage 一段指令，这里开新对话并填进输入框。
// 明暗跟随 dsh 主题，切换时把配色发给页面。
//
// 注意：这个文件直接调 window.__ModuleLoader__.load，不要再被 build banner 包一层，
// 否则同一个 id 会注册两次（宿主会报 duplicate factory registration）。
window.__ModuleLoader__.load({
  id: 'dsh-realman-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'realman-studio'
    const LABEL = '真人剧工坊'
    const SRC = '/realman-studio/'

    // 胶片框 + 人像剪影：和 icon.svg 同一枚徽标（真人实拍，不是动画）
    function StudioIcon(props) {
      const s = (props && props.size) || 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round'
      },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }),
        h('path', { d: 'M8 4.5v15M16 4.5v15M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5' }),
        h('circle', { cx: 12, cy: 10.2, r: 1.8 }),
        h('path', { d: 'M9.2 16.5c0-1.8 1.2-3 2.8-3s2.8 1.2 2.8 3' }))
    }

    function apply(ctx) {
      const frames = new Set()
      let scheme = null

      const post = (frame, payload) => {
        try { if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, location.origin) } catch { /* 跨域/已卸载 */ }
      }
      const pushScheme = () => {
        if (scheme) for (const frame of frames) post(frame, { type: 'realman-studio:scheme', scheme })
      }

      // 主题：有 theme 服务就跟随，没有（老宿主/无主题）就用页面自己的默认
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['theme'], (c) => {
            const push = (snap) => {
              try { scheme = snap.active.colorScheme } catch { scheme = null }
              pushScheme()
            }
            try { push(c.theme.getTheme()) } catch { /* ignore */ }
            c.on('theme/change', push)
          })
        }
      } catch { /* ignore */ }

      function StudioPanel() {
        const ref = React.useRef ? React.useRef(null) : { current: null }

        if (React.useEffect) {
          React.useEffect(() => {
            const self = ref.current
            if (self) frames.add(self)
            function onMessage(e) {
              const frame = ref.current
              if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
              const m = e.data
              if (!m || m.type !== 'realman-studio:start' || typeof m.prompt !== 'string') return
              try {
                ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
              } catch (err) {
                console.error('[realman-studio] 开新对话失败', err)
                post(frame, { type: 'realman-studio:start-failed', message: String((err && err.message) || err) })
              }
            }
            addEventListener('message', onMessage)
            pushScheme()
            return () => { removeEventListener('message', onMessage); frames.delete(self) }
          }, [])
        }

        return h('iframe', {
          ref,
          src: SRC,
          title: LABEL,
          allow: 'fullscreen; clipboard-write',
          onLoad: (e) => { pushScheme(); post(e.currentTarget, { type: 'realman-studio:scheme', scheme }) },
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => LABEL }, StudioIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, StudioPanel))
    }

    return { inject: ['slots', 'uiWorkspace'], apply }
  }
})
