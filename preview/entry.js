// 预览入口：用真实 React 渲染「文件」tab，用假 ctx + 假 fetch 喂几行改动。
// 由 tools/preview/build-session-files.mjs 打包成 preview.bundle.js（免 CDN、可离线打开）。
import './shim.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../client.js'

const definition = window.__dshDefinition
if (!definition) throw new Error('client.js 没有注册模块')

const mod = definition.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})

const registrations = []
const sidebarOpened = []
const binding = {
  sessionId: 'session-preview',
  eventSource: {
    getSnapshot: () => ({
      entries: [
        { type: 'event', event: { type: 'user/message', seq: 3 } },
        { type: 'event', event: { type: 'workspace/changes', seq: 8 } },
        { type: 'event', event: { type: 'workspace/changes', seq: 21 } },
      ],
      hasMore: false,
      revision: 3,
    }),
  },
  session: { loadOlder: async () => {} },
}

const fakeCtx = {
  slots: {
    inject: (_name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get: (name) => {
    if (name === 'sessions') {
      return { binding: () => binding, list: { getSnapshot: () => ({ byId: { 'session-preview': { cwd: 'C:\\ws' } } }) } }
    }
    if (name === 'sidebarRight') {
      return {
        openResource: (url) => {
          sidebarOpened.push(url)
          window.__sidebarOpened = sidebarOpened
        },
      }
    }
    return undefined
  },
}

mod.apply(fakeCtx)

const registration = registrations.find((entry) => entry.options.name === 'conversation.view')
if (!registration) throw new Error('没有注册 conversation.view')

const props = typeof registration.options.inject === 'function' ? registration.options.inject('session-preview') : {}
console.log('registered view:', registration.options.id, registration.options.label, registration.options.order)

const files = [
  { path: 'src/client.js', display: 'src/client.js', added: 268, deleted: 0, firstTurn: 1, turn: 1 },
  { path: 'package.json', display: 'package.json', added: 34, deleted: 0, firstTurn: 1, turn: 1 },
  { path: 'install.ps1', display: 'install.ps1', added: 383, deleted: 12, firstTurn: 2, turn: 2 },
  { path: 'index.js', display: 'index.js', added: 149, deleted: 3, firstTurn: 3, turn: 3 },
  { path: 'C:\\Users\\56314\\shot.png', display: '~\\shot.png', added: 0, deleted: 0, binary: true, firstTurn: 3, turn: 3 },
  { path: 'dist/big.bin', display: 'dist/big.bin', added: 0, deleted: 0, oversized: true, firstTurn: 4, turn: 4 },
]

window.fetch = async () => ({
  status: 200,
  json: async () => ({ ok: true, cwd: 'C:\\ws', turns: 4, missing: 1, total: files.length, files }),
})

createRoot(document.getElementById('app')).render(
  React.createElement(registration.component, { ...props, inspectCall: undefined }),
)
