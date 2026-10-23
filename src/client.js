/**
 * dsh-session-files 的浏览器半边。
 *
 * 在会话视图的 tab 条（对话 / 轨迹 / 上下文 / 编队）里加一个「文件」：
 * 列出本次会话每一轮记录到的文件改动，点一行在右侧栏打开文件原文——
 * 不是「第 X 轮改动」的 diff。
 *
 * 数据链：本页从会话事件里收集 `workspace/changes` 的 seq →
 * POST 到 Host 的 `/plugins/dsh-session-files/list` → Host 用
 * `ctx.workspaceChanges.summary()` 把多轮摘要按路径合并回来。
 */

const VIEW_ID = 'session-files'
const ENDPOINT = 'plugins/dsh-session-files/list'
const FILE_PREFIX = 'dsh-resource://file/'
const POLL_MS = 3000

/** Host 侧挂在 main 之外，只注册 tab；真正的渲染在本文件的 FilesView。 */
window.__ModuleLoader__.load({
  id: 'dsh-session-files',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const runtime = { ctx: null }

    const CSS = `
.dshf-root { box-sizing: border-box; height: 100%; min-height: 100%; display: flex; flex-direction: column;
  color: var(--dsw-alias-label-primary, #1b1d21); background: var(--dsw-alias-bg-base, #fff);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif); }
.dshf-root * { box-sizing: border-box; }
.dshf-head { flex: none; display: flex; align-items: center; gap: 12px; padding: 14px 24px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceef1); }
.dshf-title { font-size: 14px; font-weight: 600; }
.dshf-count { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dshf-grow { flex: 1; }
.dshf-btn { height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #e3e5e9); border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-secondary, #5a6068); font: inherit; font-size: 12px; cursor: pointer; }
.dshf-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); color: var(--dsw-alias-label-primary, #1b1d21); }
.dshf-btn:disabled { opacity: .5; cursor: default; }
.dshf-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 24px 40px; }
.dshf-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 8px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dshf-row:hover { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dshf-icon { flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2, #eceef2); color: var(--dsw-alias-label-secondary, #5a6068); font-size: 11px; font-weight: 700; }
.dshf-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.dshf-meta { flex: none; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dshf-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.dshf-add { color: var(--dsw-alias-state-success-primary, #2f9e5f); }
.dshf-del { color: var(--dsw-alias-state-error-primary, #d0453d); }
.dshf-turn { padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #f5f6f8); }
.dshf-badge { padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #f5f6f8); }
.dshf-note { margin: 8px 10px 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dshf-empty { padding: 64px 0 48px; text-align: center; color: var(--dsw-alias-label-tertiary, #8a8f99); font-size: 13px; line-height: 1.8; }
.dshf-error { margin: 16px 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary, #d0453d);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d0453d) 8%, transparent); font-size: 12px; line-height: 1.7; }
.dshf-error h4 { margin: 0 0 6px; font-size: 13px; }
.dshf-error code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.dshf-diag { margin-top: 8px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
`

    /**
     * 与服务层拿值：优先 `ctx.get`，没有就退回属性。
     * 不用 cordis 的 inject 声明，是因为任一声明缺失都会让整个插件不加载，
     * 那样连错误界面都看不到。
     */
    function service(ctx, name) {
      try {
        const got = typeof ctx.get === 'function' ? ctx.get(name) : undefined
        if (got !== undefined) return got
      } catch (_error) {
        // ctx.get 在服务未注册时会抛，继续试属性。
      }
      try {
        return ctx[name]
      } catch (_error) {
        return undefined
      }
    }

    /** `dsh-resource://file/` 地址：与 DSH 的 util/workspace-path 同一套编码。 */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    function fileAddressFor(sessionId, cwd, path) {
      const normalized = String(path).replace(/\\/g, '/')
      const sessionAddress = (relative) =>
        FILE_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + relative.split('/').map(encodeSegment).join('/')
      if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(normalized)) return sessionAddress(normalized.replace(/^(?:\.\/)+/, ''))
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root !== '' && normalized === root) return sessionAddress('')
      if (root !== '' && normalized.startsWith(root + '/')) return sessionAddress(normalized.slice(root.length + 1))
      return sessionAddress(normalized)
    }

    /** 从会话事件快照里收集改动轮次的 seq。 */
    function collect(sessionId) {
      const ctx = runtime.ctx
      const sessions = service(ctx, 'sessions')
      if (sessions === undefined) throw new Error('客户端服务 sessions 不可用')
      const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
      if (binding === undefined) throw new Error('会话 ' + sessionId + ' 还没绑定到本页面')
      const source = binding.eventSource
      if (source === undefined || typeof source.getSnapshot !== 'function') {
        throw new Error('会话没有暴露事件快照（eventSource）')
      }
      const window_ = source.getSnapshot() ?? {}
      const entries = Array.isArray(window_.entries) ? window_.entries : []
      const seqs = []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object' || event.type !== 'workspace/changes') continue
        seqs.push(event.seq)
      }
      const summary = typeof sessions.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : {}
      const cwd = summary?.byId?.[sessionId]?.cwd
      return {
        seqs,
        cwd: typeof cwd === 'string' ? cwd : undefined,
        hasMore: window_.hasMore === true,
        session: binding.session,
      }
    }

    async function fetchFiles(sessionId, seqs) {
      const response = await fetch(new URL(ENDPOINT, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-files': '1' },
        body: JSON.stringify({ sessionId, seqs }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error('Host 返回的不是 JSON（HTTP ' + response.status + '）')
      if (payload.ok !== true) throw new Error(payload.code + '：' + String(payload.message ?? '未知错误'))
      return payload
    }

    function openInSidebar(sessionId, cwd, path) {
      const sidebarRight = service(runtime.ctx, 'sidebarRight')
      if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
        throw new Error('右侧栏服务 sidebarRight 不可用')
      }
      sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))
    }

    function FilesView(props) {
      const sessionId = props.sessionId
      const [state, setState] = useState({ phase: 'loading', files: [], turns: 0, missing: 0, cwd: null, error: null })
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setState({ phase: 'error', files: [], turns: 0, missing: 0, cwd: null, error: '当前会话还没有 id' })
          return
        }
        try {
          const info = collect(sessionId)
          const effectiveCwd = info.cwd
          if (info.seqs.length === 0) {
            if (alive.current) {
              setState({ phase: 'empty', files: [], turns: 0, missing: 0, cwd: effectiveCwd ?? null, error: null })
            }
            return
          }
          const payload = await fetchFiles(sessionId, info.seqs)
          if (!alive.current) return
          setState({
            phase: payload.files.length === 0 ? 'empty' : 'done',
            files: payload.files,
            turns: payload.turns,
            missing: payload.missing,
            cwd: payload.cwd ?? effectiveCwd ?? null,
            error: null,
          })
        } catch (error) {
          if (!alive.current) return
          setState({ phase: 'error', files: [], turns: 0, missing: 0, cwd: null, error: messageOf(error) })
        }
      }, [sessionId])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void load()
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const loadOlder = useCallback(async () => {
        setBusy(true)
        try {
          const sessions = service(runtime.ctx, 'sessions')
          const binding = typeof sessions?.binding === 'function' ? sessions.binding(sessionId) : undefined
          if (typeof binding?.session?.loadOlder === 'function') await binding.session.loadOlder()
        } catch (_error) {
          // 取不到更早的轮次就保持现状。
        }
        await load()
        if (alive.current) setBusy(false)
      }, [load, sessionId])

      const open = useCallback(
        (file) => {
          try {
            openInSidebar(sessionId, state.cwd, file.path)
          } catch (error) {
            setState((previous) => ({ ...previous, error: messageOf(error) }))
          }
        },
        [sessionId, state.cwd],
      )

      const head = h(
        'div',
        { className: 'dshf-head' },
        h(React.Fragment, null, h('style', null, CSS)),
        h('span', { className: 'dshf-title' }, '本次会话的文件'),
        h(
          'span',
          { className: 'dshf-count' },
          state.phase === 'done' ? state.files.length + ' 个文件 · ' + state.turns + ' 轮改动' : '',
        ),
        h('span', { className: 'dshf-grow' }),
        h('button', { className: 'dshf-btn', type: 'button', onClick: () => void load() }, '刷新'),
        h('button', { className: 'dshf-btn', type: 'button', onClick: () => void loadOlder(), disabled: busy }, '加载更早轮次'),
      )

      let body
      if (state.phase === 'error') {
        body = h(
          'div',
          { className: 'dshf-body' },
          h(
            'div',
            { className: 'dshf-error', role: 'alert' },
            h('h4', null, '没能列出文件'),
            h('code', null, state.error ?? '未知错误'),
            h(
              'div',
              { className: 'dshf-diag' },
              '这个 tab 已经挂上了；上面的错误说明某一环没通（服务名、事件结构或 Host 路由）。',
            ),
          ),
        )
      } else if (state.phase === 'empty') {
        body = h(
          'div',
          { className: 'dshf-body' },
          h(
            'div',
            { className: 'dshf-empty' },
            h('div', null, '本次会话还没记录到文件改动。'),
            h('div', null, '改动是每轮由 Host 的 git 比对记录的；空会话、只读问答，或 Host 重启前的旧轮次都会是空的。'),
          ),
        )
      } else {
        const rows = state.files.map((file) =>
          h(
            'button',
            { key: file.path, className: 'dshf-row', type: 'button', title: file.path, onClick: () => open(file) },
            h('span', { className: 'dshf-icon' }, '文'),
            h('span', { className: 'dshf-path' }, file.display),
            h(
              'span',
              { className: 'dshf-meta' },
              file.binary ? h('span', { className: 'dshf-badge' }, '二进制') : null,
              file.oversized ? h('span', { className: 'dshf-badge' }, '未捕获') : null,
              file.added > 0 ? h('span', { className: 'dshf-mono dshf-add' }, '+' + file.added) : null,
              file.deleted > 0 ? h('span', { className: 'dshf-mono dshf-del' }, '−' + file.deleted) : null,
              h('span', { className: 'dshf-turn' }, '第 ' + file.firstTurn + ' 轮'),
            ),
          ),
        )
        body = h(
          'div',
          { className: 'dshf-body' },
          state.phase === 'loading' && rows.length === 0 ? h('div', { className: 'dshf-empty' }, '正在读取改动记录…') : null,
          ...rows,
          state.missing > 0
            ? h(
                'div',
                { className: 'dshf-note' },
                '有 ' + state.missing + ' 轮改动摘要已被 Host 释放（通常是重启前的轮次），这些轮次的文件没有计入。',
              )
            : null,
          h('div', { className: 'dshf-note' }, '点一行在右侧打开文件原文；改动对比仍在对话里的改动卡片上。'),
        )
      }

      return h('div', { className: 'dshf-root' }, head, body)
    }

    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      return error.message ? String(error.message) : String(error)
    }

    function apply(ctx) {
      runtime.ctx = ctx
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: VIEW_ID,
            order: 40,
            label: '文件',
            inject: (sessionId) => ({ sessionId }),
          },
          FilesView,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
