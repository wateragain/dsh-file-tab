/**
 * dsh-session-files 的 Host 半边。
 *
 * 只做一件事：把「本次会话的每一轮改过哪些文件」聚合成一张表。
 * 数据不自己算——`ctx.workspaceChanges` 就是 deliverables 卡片用的那份
 * 每轮改动摘要（`workspace/changes` 事件宣告的 git 比对结果），这里按
 * 会话把多轮摘要按路径合并。
 *
 * 客户端只知道「哪些轮次有改动」（事件里的 seq），把 seq 列表 POST 过来，
 * 这里逐个取摘要。这样不需要任何鉴权，也不读会话日志。
 */

const ROUTE_PATH = '/plugins/dsh-session-files/list'
const MAX_BODY_BYTES = 256 * 1024
const MAX_SEQS = 4000

export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        void handle(ctx, req, res)
      },
    }),
  )
}

async function handle(ctx, req, res) {
  if (!isSameOrigin(req)) {
    return send(res, 403, { ok: false, code: 'FORBIDDEN', message: '拒绝跨源请求' })
  }
  if (req.method !== 'POST' || req.headers['x-dsh-session-files'] !== '1') {
    return send(res, 405, { ok: false, code: 'BAD_REQUEST', message: `只接受 POST ${ROUTE_PATH}` })
  }

  let body
  try {
    body = await readJson(req)
  } catch (_error) {
    return send(res, 400, { ok: false, code: 'BAD_BODY', message: '请求体不是合法 JSON' })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId === '') {
    return send(res, 400, { ok: false, code: 'NO_SESSION', message: '缺少 sessionId' })
  }
  const seqs = normalizeSeqs(body.seqs)
  if (seqs.length === 0) {
    return send(res, 400, { ok: false, code: 'NO_SEQ', message: '没有可查的轮次序号' })
  }

  const changes = service(ctx, 'workspaceChanges')
  if (changes === undefined || typeof changes.summary !== 'function') {
    return send(res, 503, {
      ok: false,
      code: 'NO_SERVICE',
      message: '本 Host 没有 workspaceChanges 服务，改动摘要不可用',
    })
  }

  const files = new Map()
  let turns = 0
  let missing = 0
  let cwd
  for (const seq of seqs) {
    let summary
    try {
      summary = changes.summary(sessionId, seq)
    } catch (_error) {
      summary = undefined
    }
    if (summary === undefined || summary === null) {
      missing += 1
      continue
    }
    turns += 1
    if (typeof summary.cwd === 'string' && summary.cwd !== '') cwd = summary.cwd
    const list = Array.isArray(summary.files) ? summary.files : []
    for (const file of list) {
      const path = typeof file.path === 'string' ? file.path : ''
      if (path === '') continue
      const previous = files.get(path)
      const entry = {
        path,
        display: typeof file.display === 'string' && file.display !== '' ? file.display : path,
        added: count(file.added),
        deleted: count(file.deleted),
        binary: file.binary === true,
        oversized: file.oversized === true,
        turn: count(summary.turn),
        firstTurn: previous === undefined ? count(summary.turn) : Math.min(previous.firstTurn, count(summary.turn)),
      }
      files.set(path, entry)
    }
  }

  const result = [...files.values()].sort((left, right) =>
    left.display < right.display ? -1 : left.display > right.display ? 1 : 0,
  )
  send(res, 200, {
    ok: true,
    cwd: cwd ?? null,
    turns,
    missing,
    total: result.length,
    files: result,
  })
}

function service(ctx, name) {
  try {
    const got = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (got !== undefined) return got
  } catch (_error) {
    // ctx.get 在该服务未注册时会抛错，落到属性查一遍。
  }
  try {
    return ctx[name]
  } catch (_error) {
    return undefined
  }
}

function normalizeSeqs(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    const seq = Number(item)
    if (!Number.isFinite(seq) || seq < 0) continue
    const key = Math.trunc(seq)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_SEQS) break
  }
  return out.sort((left, right) => left - right)
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/** 浏览器同源 POST 也会带 Origin；只要 Origin 与 Host 不一致就拒绝。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch (_invalidOrigin) {
    return false
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
