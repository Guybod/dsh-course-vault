/**
 * 宿主 RPC 通道：在 `ctx.webServer` 上挂 `/dsh-course` 前缀路由。
 *
 * 为什么不走 `ctx.connection.rpc.handle()`：第三方 bundle 走不通。
 * 官方 HostConnectionService.rpc.handle 内部把 owner 固定成 connection 插件自身的 context
 * （只 inject 了 credentials），register() 里访问 owner.webServer 会拿到 undefined 并抛错，
 * 结果是 fiber FAILED、插件列表显示「异常」。而 `/api` 前缀被 gateway 独占（一条通道
 * 只允许一个 owner）。所以第三方插件唯一稳定的直连通道，是自己 inject `webServer`
 * 并注册前缀路由——做法与已实测可用的 `@dsh-packforge/dsh-pack-plugin` 一致。
 *
 * 响应形状与官方客户端 `ctx.connection.rpc.call` 完全对称：
 *   { ok: true, value } | { ok: false, error: { code, message, details } }
 */

export const CHANNEL = '/dsh-course'

export const ok = (value) => ({ ok: true, value })
export const fail = (code, message, details = {}) => ({
  ok: false,
  error: { code, message, details: details ?? {} },
})

/** 与官方 endpointFromPath 同构：去通道前缀取相对 endpoint，并逐段做字符白名单。 */
export function endpointFromPath(url, channel = CHANNEL) {
  let pathname
  try {
    pathname = new URL(url, 'http://x').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !/^[A-Za-z0-9_$.-]+$/.test(s))) {
    return undefined
  }
  return endpoint
}

/**
 * 更严格的版本：先看**原始** URL 路径再做白名单。
 *
 * 为什么需要它：`new URL()` 会把 `/dsh-course/a/../b` 规范化成 `/dsh-course/b`，
 * 于是上面那份白名单永远看不到 `..` 段——规范化后虽然仍被限制在通道内（没有穿越风险），
 * 但白名单实际上失效了。这里对原始路径逐段校验，让拒绝理由真实成立。
 */
export function endpointFromRequestUrl(url, channel = CHANNEL) {
  if (typeof url !== 'string' || url === '') return undefined
  const rawPath = url.split('?')[0].split('#')[0]
  if (!rawPath.startsWith(`${channel}/`)) return undefined
  const endpoint = rawPath.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !/^[A-Za-z0-9_$.-]+$/.test(s))) {
    return undefined
  }
  return endpoint
}

/** 读 POST 体（JSON），上限 64 MiB。坏 JSON 转成 reject，由外层统一回 400。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 注册 `/dsh-course` 通道。
 * @param {object} ctx cordis 上下文（用于鉴权栅栏与 effect 生命周期）
 * @param {object} webServer 已解析到的 webServer 服务（可选服务，由调用方先取到）
 * @param {(endpoint: string, payload: object) => Promise<any>} dispatch
 * @param {(endpoint: string) => boolean} hasEndpoint
 * @returns {(() => void) | null} 注销函数；webServer 不可用时返回 null
 */
export function registerRpc(ctx, webServer, dispatch, hasEndpoint, transfer) {
  const ws = webServer
  if (!ws || typeof ws.register !== 'function') return null

  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      // 复用 connection 的 Host/Origin + 浏览器鉴权栅栏（与 /api 同策略）。
      //
      // 注意：必须走 ctx.get('connection')，**不能**写 `ctx?.connection`——
      // cordis 对未在 inject 里声明的服务，属性访问会直接抛
      // `cannot get property "connection" without inject`（可选链也挡不住），
      // 而 webserver 的 handle() 会把任何抛错包成 400 空响应，表现为"通道没反应"。
      const connection = ctx?.get?.('connection')
      const rejection = connection?.requestRejection?.(req)
      if (rejection) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const rawPath = (req.url ?? '').split('?')[0]
      if (transfer && req.method === 'POST' && rawPath === `${CHANNEL}/upload`) {
        try {
          const originalName = new URL(req.url, 'http://local').searchParams.get('name') ?? ''
          json(res, 200, ok(await transfer.upload(req, originalName)))
        } catch (err) { if (!res.destroyed) json(res, 400, fail('upload-error', err.message)) }
        return
      }
      if (transfer && req.method === 'GET' && rawPath.startsWith(`${CHANNEL}/download/`)) {
        try { await transfer.download(rawPath.slice(`${CHANNEL}/download/`.length), res) }
        catch (err) { if (!res.headersSent) json(res, 400, fail('download-error', err.message)); else res.destroy(err) }
        return
      }
      if (req.method === 'GET') {
        // 只提供健康探针，方便确认通道活着（不新增路由以免撞 duplicate 检查）
        const pathname = (() => {
          try {
            return new URL(req.url ?? '', 'http://x').pathname
          } catch {
            return ''
          }
        })()
        if (pathname === `${CHANNEL}/health`) {
          json(res, 200, ok({ channel: CHANNEL, alive: true }))
          return
        }
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const endpoint = endpointFromRequestUrl(req.url ?? '')
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        json(res, 400, {
          type: 'server-response',
          rpcId: 'invalid-request',
          result: fail('gateway/bad-request', 'invalid client-request message', { issues: [] }),
        })
        return
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
      if (body?.type !== 'client-request' || typeof body?.method !== 'string') {
        json(res, 200, {
          type: 'server-response',
          rpcId,
          result: fail('gateway/bad-request', 'invalid client-request message', { issues: [] }),
        })
        return
      }
      const payload = body?.payload ?? {}
      let result
      if (endpoint === undefined || !hasEndpoint(endpoint)) {
        result = fail('no-such-endpoint', `未知端点：${body.method}`)
      } else if (body.method !== endpoint) {
        result = fail(
          'gateway/bad-request',
          `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          { issues: [] },
        )
      } else {
        try {
          result = ok(await dispatch(endpoint, payload, ctx, undefined))
        } catch (err) {
          result = fail('endpoint-error', err?.message ?? String(err), { stack: err?.stack })
        }
      }
      json(res, 200, { type: 'server-response', rpcId, result })
    },
  }

  // 随 fiber 生命周期自动卸载（webserver.register 返回同步 disposer，effect 会接住）
  ctx.effect(() => ws.register(route), `dsh-course-vault: ${CHANNEL} rpc channel`)
  return () => {}
}
