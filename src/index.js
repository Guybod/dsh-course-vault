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
import { presetStatus } from './core/preset.js'
import { logEvent, logBootSnapshot, describeError, installProcessGuards, logFile } from './core/log.js'

export const name = 'dsh-course-vault'

/**
 * 不声明任何硬注入：可选服务缺失时本插件仍然加载，只是对应能力降级并记一条 warn。
 * 这样它不会因为宿主组合里没有 `dsh-web-app` 就把整个 profile 拖到启动失败。
 */
export const inject = []

/**
 * 模块加载即记一条（比 `apply()` 更早）。
 *
 * 这条记录的价值在于**区分两种失败**：
 *   - 日志里**没有**这条 → 模块根本没被加载/解析（失败在 loader 或 package 声明层，
 *     比如上次那个客户端半包问题）；
 *   - 有这条、但没有 `apply()` 的记录 → 模块解析成功、激活失败。
 *
 * 放在模块顶层是刻意的：它在任何服务、任何上下文可用之前就跑。
 * `logEvent` 自己吃光所有异常，所以它不可能成为加载失败的原因。
 */
logEvent('module', '模块已加载（import 完成）', { file: 'src/index.js' })

const PLUGIN_VERSION = '0.3.3'

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
 * 启动自检：只**报告**课程模式的实际状态，不做任何写入。
 *
 * 为什么不再同步：0.2.x（桌面端）的 preset 是 profile 补丁里的声明，注册表不扫目录，
 * 往 `<DSH_HOME>/.agent-presets/` 写目录**没有任何效果**，只会留下误导性的残留。
 * 0.1.x 部署若需要目录形态，显式调用 `syncCoursePreset()` 即可。
 */
function reportPresetStatus(ctx) {
  const log = getLogger(ctx)
  const tick = async () => {
    try {
      const status = await presetStatus(resolveRuntime(ctx).home, ctx)
      if (status.patch.present && status.patch.declaresCourse) {
        log.info(`[${name}] 课程模式形态：${status.effective}（补丁 ${status.patch.path}）`)
      } else {
        log.warn(
          `[${name}] 课程模式未就位：补丁 present=${status.patch.present} declaresCourse=${status.patch.declaresCourse}；` +
            `旧目录形态 installed=${status.legacyDir.installed}`,
        )
      }
      if (status.roster?.courseVisible) {
        log.info(`[${name}] roster 已发现「课程模式」（共 ${status.roster.total} 个模式）`)
        logEvent('preset', 'roster 已发现课程模式', { total: status.roster.total, ids: status.roster.ids })
      } else if (status.roster && !status.roster.error) {
        log.warn(`[${name}] roster 未发现「课程模式」，当前：${status.roster.ids.join(', ')}`)
        logEvent('preset', 'roster 未发现课程模式', { ids: status.roster.ids, broken: status.roster.broken })
      } else {
        logEvent('preset', 'roster 不可读', { roster: status.roster })
      }
    } catch (err) {
      log.warn(`[${name}] 自检失败：${err?.message ?? err}`)
      logEvent('preset', '自检抛错', describeError(err))
    }
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
      (endpoint) => Object.hasOwn(endpoints, endpoint) && typeof endpoints[endpoint] === 'function',
      endpoints.transfer,
    )
    if (registered === null) {
      log.warn(`[${name}] webServer.register 不可用，${CHANNEL} 通道未挂载`)
      logEvent('channel', 'registerRpc 返回 null（webServer.register 不可用）')
      return false
    }
    const runtime = resolveRuntime(ctx)
    log.info(
      `[${name}] v${PLUGIN_VERSION} 已加载：通道 ${CHANNEL}，DSH_HOME=${runtime.home}（${runtime.source}）`,
    )
    logEvent('channel', '通道已挂载', { channel: CHANNEL, attempt, home: runtime.home, source: runtime.source })
    return true
  }
  logEvent('channel', 'webServer 尚不可用，准备重试', { attempt, total: SERVICE_RETRY_DELAYS_MS.length })
  if (attempt >= SERVICE_RETRY_DELAYS_MS.length) {
    log.warn(
      `[${name}] 未找到 webServer 服务，${CHANNEL} RPC 通道未挂载；课程模式 preset 仍可用（该能力需要 web profile）`,
    )
    logEvent('channel', '放弃挂载：始终没有 webServer 服务')
    return false
  }
  setTimeout(() => attachChannelWhenReady(ctx, endpoints, attempt + 1), SERVICE_RETRY_DELAYS_MS[attempt])
  return false
}

/**
 * 插件入口。
 *
 * **绝不抛出**：本插件的任何失败都不该让 DSH 启动失败。
 * 上一版就因为这里的异常（客户端半包配置）导致条目激活失败，
 * 而 DSH 会把激活失败的 bundle 从 profile 里剔掉——用户看到的是"启动不了"。
 * 所以整个函数体包在 try/catch 里，异常只记日志、不冒泡。
 *
 * 另外：进入时立刻往文件写一条 boot 快照。这是"让启动错误可见"的第一步——
 * 只要日志里有这一行，就证明插件被加载到了；没有这一行，就证明失败发生在更早的
 * 模块解析/加载阶段（那时任何插件代码都还没跑）。两种结论都极其有用。
 *
 * @param {object} ctx cordis 上下文
 */
export function apply(ctx) {
  // 最先做的事：装兜底 + 写快照。此刻还没碰任何可能抛错的东西。
  installProcessGuards()
  logBootSnapshot('boot', { phase: 'apply-entered' })

  try {
    const runtime = resolveRuntime(ctx)
    logEvent('boot', 'runtime 已解析', { home: runtime.home, source: runtime.source, profile: runtime.profileName })

    const endpoints = makeEndpoints(() => resolveRuntime(ctx), () => ctx)
    logEvent('boot', '端点表已构建', { endpoints: Object.keys(endpoints).length })

    attachChannelWhenReady(ctx, endpoints)
    reportPresetStatus(ctx)

    logEvent('boot', 'apply() 完成', { logFile: logFile() })
  } catch (err) {
    logEvent('error', 'apply() 初始化失败（已吞掉，不影响宿主启动）', describeError(err))
    try {
      getLogger(ctx).warn(`[${name}] 初始化失败（已吞掉，不影响宿主启动）：${err?.message ?? err}`)
    } catch {
      /* 连日志都拿不到时也必须静默 */
    }
  }
}
