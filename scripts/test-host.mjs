/**
 * Host 路由自测：假 ctx + 假 req/res，只跑 index.js 里的 handle 逻辑。
 *
 * 覆盖：跨源、方法、请求头、坏 JSON、缺 sessionId、空 seqs、服务缺失、
 * 多轮摘要聚合、同路径去重、摘要抛错、排序。
 */
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const ROUTE = '/plugins/dsh-session-files/list'
let failures = 0

function check(name, condition, detail) {
  if (condition) {
    console.log(`  [OK] ${name}`)
    return
  }
  failures += 1
  console.log(`  [失败] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function fakeContext(summary) {
  const registered = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    get: (name) => (name === 'workspaceChanges' ? summary : undefined),
    workspaceChanges: summary,
  }
  return { ctx, registered }
}

function fakeRequest({ method = 'POST', headers = {}, body = '{}' } = {}) {
  const stream = Readable.from([Buffer.from(body, 'utf8')])
  stream.method = method
  stream.headers = { host: '127.0.0.1:41082', 'content-type': 'application/json', ...headers }
  stream.destroy = () => {}
  return stream
}

function fakeResponse() {
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const response = {
    status: 0,
    payload: null,
    done,
    writeHead: (status) => {
      response.status = status
    },
    end: (body) => {
      response.payload = body === undefined ? null : JSON.parse(body)
      finish()
    },
  }
  return response
}

async function call(handler, requestOptions) {
  const response = fakeResponse()
  handler(fakeRequest(requestOptions), response)
  await response.done
  return response
}

const HEADER = { 'x-dsh-session-files': '1' }

const summaries = {
  10: {
    turn: 1,
    cwd: 'C:\\ws',
    files: [
      { path: 'b.txt', display: 'b.txt', added: 3, deleted: 0 },
      { path: 'a.txt', display: 'a.txt', added: 1, deleted: 2 },
    ],
    total: 2,
    added: 4,
    deleted: 2,
  },
  12: {
    turn: 2,
    cwd: 'C:\\ws',
    files: [
      { path: 'b.txt', display: 'b.txt', added: 5, deleted: 1 },
      { path: 'C:\\tmp\\c.log', display: '~\\c.log', added: 0, deleted: 7, binary: true },
    ],
    total: 2,
    added: 5,
    deleted: 8,
  },
}

const summaryService = {
  summary: (sessionId, seq) => {
    if (seq === 99) throw new Error('boom')
    return summaries[seq]
  },
}

const { ctx, registered } = fakeContext(summaryService)
apply(ctx)

console.log('注册路由')
check('注册了一条 exact 路由', registered.length === 1 && registered[0].kind === 'exact')
check('路由路径正确', registered[0].path === ROUTE, registered[0]?.path)

const handler = registered[0].handler

console.log('拒绝分支')
{
  const response = await call(handler, { headers: { origin: 'https://evil.example', ...HEADER }, body: '{}' })
  check('跨源 403', response.status === 403, response.status)
}
{
  const response = await call(handler, { method: 'GET', headers: HEADER })
  check('GET 405', response.status === 405, response.status)
}
{
  const response = await call(handler, { body: '{}' })
  check('缺请求头 405', response.status === 405, response.status)
}
{
  const response = await call(handler, { headers: HEADER, body: '{oops' })
  check('坏 JSON 400', response.status === 400, response.status)
}
{
  const response = await call(handler, { headers: HEADER, body: '{}' })
  check('缺 sessionId 400', response.status === 400 && response.payload.code === 'NO_SESSION', response.payload?.code)
}
{
  const response = await call(handler, { headers: HEADER, body: JSON.stringify({ sessionId: 's1', seqs: [] }) })
  check('空 seqs 400', response.status === 400 && response.payload.code === 'NO_SEQ', response.payload?.code)
}

console.log('服务缺失')
{
  const bare = fakeContext(undefined)
  apply(bare.ctx)
  const bareHandler = bare.registered[0].handler
  const response = await call(bareHandler, {
    headers: HEADER,
    body: JSON.stringify({ sessionId: 's1', seqs: [10] }),
  })
  check('没有 workspaceChanges 时 503', response.status === 503 && response.payload.code === 'NO_SERVICE', response.payload?.code)
}

console.log('聚合')
{
  const response = await call(handler, {
    headers: HEADER,
    body: JSON.stringify({ sessionId: 's1', seqs: [12, 10, 10, 'x', -1, 99] }),
  })
  check('返回 200', response.status === 200, response.status)
  const payload = response.payload
  check('两轮命中 + 抛错的一轮记为 missing', payload.turns === 2 && payload.missing === 1, JSON.stringify({ turns: payload.turns, missing: payload.missing }))
  check('cwd 透传', payload.cwd === 'C:\\ws', payload.cwd)
  check('按路径去重为 3 个文件', payload.total === 3 && payload.files.length === 3, payload.total)
  const byPath = new Map(payload.files.map((file) => [file.path, file]))
  const b = byPath.get('b.txt')
  check('同路径取最后一轮的计数', b.added === 5 && b.deleted === 1, JSON.stringify(b))
  check('同路径保留最早轮次', b.firstTurn === 1, JSON.stringify(b))
  check('保留 binary 标记', byPath.get('C:\\tmp\\c.log').binary === true)
  check('按 display 排序', payload.files[0].display === 'a.txt', payload.files.map((file) => file.display).join('|'))
}

console.log('错误响应格式')
{
  const response = await call(handler, { headers: HEADER, body: '{}' })
  check('错误带 code 和 message', typeof response.payload.code === 'string' && typeof response.payload.message === 'string')
  check('JSON 无 BOM 前缀', typeof response.payload === 'object')
}

console.log('')
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
console.log('全部通过')
