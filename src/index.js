/**
 * dsh-course-vault 的 host 插件入口。
 *
 * 职责边界（刻意很窄）：
 *   - 只做**宿主侧文件工作**：会话日志的导出/导入、课程内容打包、课程模式 preset 维护；
 *   - 不做模型可见的工具、不改模型上下文——教学人设与流程由「课程模式」这个 agent preset 承担；
 *   - UI 通过 `/dsh-course` 前缀通道调用，不经模型、不进聊天栏。
 *
 * ## 一条必须记住的 cordis 规则（本插件踩过两次）
 *
 * **未在 `inject` 里声明的服务，用属性访问会直接抛错**：
 * `ctx.profileContext` / `ctx.connection` / `ctx.logger` 会分别抛
 * `cannot get property "X" without inject`，而且**可选链 `ctx?.X` 挡不住**。
 *
 * 而本插件又故意不硬注入（硬注入会让只有 `dsh-base` 的 profile 因为
 * `assertEntriesActivated` 而**整体启动失败**）。所以这里的纪律是：
 * **所有服务一律用 `ctx.get(name)` 取，取不到就降级**；日志走 `getLogger()`。
 *
 * 症状对照：如果哪天又写成属性访问，表现是 RPC 通道返回 **400 空响应**
 * （webserver 的 `handle()` 会把路由 handler 的抛错统一包成 400），而不是 500。
 */

import os from 'node:os'
import path from 'node:path'

import { makeEndpoints } from './endpoints.js'
import { registerRpc, CHANNEL } from './rpc.js'
import { presetStatus, syncCoursePreset, PRESET_ID } from './core/preset.js'

export const name = 'dsh-course-vault'

/**
 * 不声明任何硬注入：可选服务缺失时本插件仍然加载，只是对应能力降级并记一条 warn。
 * 这样它不会因为宿主组合里没有 `dsh-web-app` 就把整个 profile 拖到启动失败。
 */
export const inject = []

const PLUGIN_VERSION = '0.1.0'

/** 等可选服务出现的重试节奏（毫秒）。启动早期服务可能尚未发布。 */
const SERVICE_RETRY_DELAYS_MS = [0, 250, 750, 2000]

/**
 * 安全取日志器：`ctx.logger` 也是服务，未 inject 时属性访问会抛错。
 * 取不到就退回 no-op——日志永远不该让插件崩掉。
 */
function getLogger(ctx) {
  const logger = ctx?.get?.('logger')
  if (logger && typeof logger.info === 'function') {
    return {
      info: (m) => logger.info(m),
      warn: (m) => (typeof logger.warn === 'function' ? logger.warn(m) : logger.info(m)),
    }
  }
  return { info: () => {}, warn: () => {} }
}

/**
 * 运行时事实：home / profile 名 / 来源。
 * `ctx.get('profileContext')` 给出 DSH_HOME 的权威路径；取不到时回退环境变量。
 */
function resolveRuntime(ctx) {
  const pc = ctx?.get?.('profileContext')
  if (pc && typeof pc.home === 'string') {
    return {
      home: pc.home,
      profileName: pc.name ?? 'unknown',
      profileDir: pc.dir ?? null,
      source: 'profileContext',
    }
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return { home, profileName: 'unknown', profileDir: null, source: 'env' }
}

/**
 * 启动时自检课程模式 preset：**只在缺失或过期时才写盘**。
 *
 * 为什么不用 `ctx.effect()` 包这个动作：effect 的清理函数会在 dispose 时再执行一次，
 * 那是「卸载路径」，不该再做写盘。这里用一次性自检，失败只记录、不阻塞插件加载。
 */
function ensurePreset(ctx, home) {
  const log = getLogger(ctx)
  const tick = () => {
    presetStatus(home)
      .then(async (status) => {
        if (status.installed && status.upToDate) return
        const res = await syncCoursePreset({ dshHome: home })
        if (res.ok) {
          log.info(
            `[${name}] 课程模式 preset 已就位：${res.target}（写入 ${res.written.length}，清理 ${res.removed.length}）`,
          )
        } else {
          log.warn(`[${name}] 课程模式 preset 未同步：${res.reason}`)
        }
      })
      .catch((err) => {
        log.warn(`[${name}] 课程模式 preset 自检失败：${err?.message ?? err}`)
      })
  }
  // 留出本轮加载窗口，避免与 loader 的写回竞争
  if (typeof setImmediate === 'function') setImmediate(tick)
  else setTimeout(tick, 0)
}

/**
 * 等到 `webServer` 可用再挂通道。
 *
 * 用 `ctx.get('webServer')` 而不是 `ctx.webServer`；启动早期服务可能还没发布，
 * 所以按固定节奏重试几次；全部用完仍没有，就**如实记 warn 并停止**——不静默、不阻塞。
 */
function attachChannelWhenReady(ctx, endpoints, attempt = 0) {
  const log = getLogger(ctx)
  const ws = ctx?.get?.('webServer')
  if (ws && typeof ws.register === 'function') {
    const registered = registerRpc(
      ctx,
      ws,
      async (endpoint, payload) => endpoints[endpoint](payload),
      (endpoint) => Object.hasOwn(endpoints, endpoint),
    )
    if (registered === null) {
      log.warn(`[${name}] webServer.register 不可用，${CHANNEL} 通道未挂载`)
      return false
    }
    const runtime = resolveRuntime(ctx)
    log.info(
      `[${name}] v${PLUGIN_VERSION} 已加载：通道 ${CHANNEL}，DSH_HOME=${runtime.home}（${runtime.source}），preset=${PRESET_ID}`,
    )
    return true
  }
  if (attempt >= SERVICE_RETRY_DELAYS_MS.length) {
    log.warn(
      `[${name}] 未找到 webServer 服务，${CHANNEL} RPC 通道未挂载；课程模式 preset 仍可用（该能力需要 web profile）`,
    )
    return false
  }
  setTimeout(() => attachChannelWhenReady(ctx, endpoints, attempt + 1), SERVICE_RETRY_DELAYS_MS[attempt])
  return false
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文
 */
export function apply(ctx) {
  const runtime = resolveRuntime(ctx)
  const endpoints = makeEndpoints(() => resolveRuntime(ctx), () => ctx)

  attachChannelWhenReady(ctx, endpoints)
  ensurePreset(ctx, runtime.home)
}
