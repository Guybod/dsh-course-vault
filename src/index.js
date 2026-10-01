/**
 * dsh-course-vault 的 host 插件入口。
 *
 * 职责边界（刻意很窄）：
 *   - 只做**宿主侧文件工作**：会话日志的导出/导入、课程内容打包、课程模式 preset 维护；
 *   - 不做模型可见的工具、不改模型上下文——教学人设与流程由「课程模式」这个 agent preset 承担；
 *   - UI 通过 `/dsh-course` 前缀通道调用，不经模型、不进聊天栏。
 *
 * 运行时事实来源：`ctx.profileContext.home`（官方 ProfileContext），
 * 缺失时回退 `DSH_HOME` 环境变量与 `~/.dsh`——与已实测可用的第三方插件同源。
 */

import os from 'node:os'
import path from 'node:path'

import { makeEndpoints } from './endpoints.js'
import { registerRpc, CHANNEL } from './rpc.js'
import { presetStatus, syncCoursePreset, PRESET_ID } from './core/preset.js'

export const name = 'dsh-course-vault'

/**
 * 依赖的宿主服务。`webServer` 与 `profileContext` 缺一不可：
 * 前者是第三方插件唯一的直连通道，后者给出 DSH_HOME 的权威路径。
 */
export const inject = ['webServer', 'profileContext']

const PLUGIN_VERSION = '0.1.0'

/** 运行时事实：home / profile 名 / 来源。 */
function resolveRuntime(ctx) {
  const pc = ctx?.profileContext
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
 * 为什么不用 `ctx.effect()` 包同步动作：effect 的清理函数会在 dispose 时再执行一次，
 * 那是「卸载路径」，不该再做写盘。这里用一次性自检，失败只记录、不阻塞插件加载。
 */
function ensurePreset(ctx, home) {
  const tick = () => {
    presetStatus(home)
      .then(async (status) => {
        if (status.installed && status.upToDate) return
        const res = await syncCoursePreset({ dshHome: home })
        if (res.ok) {
          ctx?.logger?.info?.(
            `[${name}] 课程模式 preset 已就位：${res.target}（写入 ${res.written.length}，清理 ${res.removed.length}）`,
          )
        } else {
          ctx?.logger?.warn?.(`[${name}] 课程模式 preset 未同步：${res.reason}`)
        }
      })
      .catch((err) => {
        ctx?.logger?.warn?.(`[${name}] 课程模式 preset 自检失败：${err?.message ?? err}`)
      })
  }
  // 留出本轮加载窗口，避免与 loader 的写回竞争
  if (typeof setImmediate === 'function') setImmediate(tick)
  else setTimeout(tick, 0)
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文
 */
export function apply(ctx) {
  const runtime = resolveRuntime(ctx)
  const endpoints = makeEndpoints(() => resolveRuntime(ctx))

  const registered = registerRpc(
    ctx,
    async (endpoint, payload, _ctx, _runtime) => endpoints[endpoint](payload),
    (endpoint) => Object.hasOwn(endpoints, endpoint),
  )

  if (registered === null) {
    ctx?.logger?.warn?.(`[${name}] webServer 服务不可用，${CHANNEL} 通道未挂载；仅课程模式 preset 仍可用`)
  } else {
    ctx?.logger?.info?.(
      `[${name}] v${PLUGIN_VERSION} 已加载：通道 ${CHANNEL}，DSH_HOME=${runtime.home}（${runtime.source}），preset=${PRESET_ID}`,
    )
  }

  ensurePreset(ctx, runtime.home)
}
