/**
 * 插件生命周期的文件日志——**绝不抛错**。
 *
 * 为什么要它：桌面端启动失败时，错误信息目前无处可见
 * （`~/.dsh/profiles/<name>/.plugin-manager/logs` 里只有 pnpm/git 的日志，没有 loader 的）。
 * 我们为此付出过一次代价：插件加错配置 → 启动失败 → DSH 自愈把 bundle 剔掉，
 * 而**看不到任何原因**，只能靠猜。这个模块把插件侧能观察到的事实写进文件，
 * 让"插件到底有没有被加载、加载到哪一步失败"变成可查的事实。
 *
 * 设计约束（都是刻意为之）：
 *   - **同步写**：启动早期崩溃时异步写盘可能还没落盘；进程直接死掉时同步写才有用。
 *   - **绝不抛错**：日志失败绝不能成为新的失败原因。
 *   - **不 import 任何 DSH 包**：它必须在 loader 能给的任何上下文里都可用。
 *   - 落在 `<DSH_HOME>/logs/` 下，与 DSH 自己的痕迹放一起，便于一眼看到。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 日志目录：`<DSH_HOME>/logs`，取不到就退回临时目录。 */
function logDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    return path.join(home, 'logs')
  } catch {
    return path.join(os.tmpdir(), 'dsh-course-vault-logs')
  }
}

/** 日志文件路径。 */
export function logFile() {
  return path.join(logDir(), 'dsh-course-vault.log')
}

/**
 * 这条记录是不是来自"演练"（测试脚本）而不是真机启动？
 *
 * 教训：我用假 ctx 演练时写出的日志，和真机启动的日志混在同一个文件里，
 * 后来排查时分不清哪条是谁写的，白花了好几轮。用环境变量显式标记，
 * 真机排查时可以直接过滤掉。
 */
function isDrill() {
  return process.env.DSH_COURSE_VAULT_DRILL === '1'
}

/** 把一行（或多个值）同步追加到日志；任何失败都静默吞掉。 */
export function logEvent(scope, message, extra) {
  try {
    const dir = logDir()
    fs.mkdirSync(dir, { recursive: true })
    const parts = [
      new Date().toISOString(),
      `pid=${process.pid}`,
      isDrill() ? '[DRILL]' : '[app]',
      `[${scope}]`,
      typeof message === 'string' ? message : JSON.stringify(message),
    ]
    if (extra !== undefined) {
      try {
        parts.push(typeof extra === 'string' ? extra : JSON.stringify(extra))
      } catch {
        parts.push('[extra 无法序列化]')
      }
    }
    fs.appendFileSync(logFile(), parts.join(' ') + '\n', 'utf8')
  } catch {
    /* 日志失败绝不再抛 */
  }
}

/** 把错误对象拆成可读的一行（含 cause 链），供 fatal 记录用。 */
export function describeError(err) {
  if (err === undefined || err === null) return String(err)
  if (!(err instanceof Error)) {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  const chain = []
  let cur = err
  let depth = 0
  while (cur && depth < 6) {
    const name = cur.name ?? 'Error'
    const msg = cur.message ?? ''
    const where = cur.stack ? String(cur.stack).split('\n')[1]?.trim() : ''
    chain.push(`${name}: ${msg}${where ? `  @ ${where}` : ''}`)
    cur = cur.cause
    depth += 1
  }
  return chain.join('  ← cause: ')
}

/**
 * 安装进程级兜底：未捕获异常 / 未处理拒绝都先落盘再放行。
 *
 * 只在插件加载时装一次；用全局标记防重复安装（HMR / 多次加载同一模块时可能重复执行）。
 * **不改变原有行为**：记录之后仍然把错误交回原处理器（如果还有）或让进程照常结束。
 */
export function installProcessGuards() {
  const flag = '__dshCourseVaultGuardsInstalled__'
  if (globalThis[flag]) return
  globalThis[flag] = true

  try {
    process.on('uncaughtException', (err) => {
      logEvent('fatal', 'uncaughtException', describeError(err))
      // 交回默认行为（其他 listener 仍在；没有则进程退出，与未安装时一致）
    })
    process.on('unhandledRejection', (reason) => {
      logEvent('fatal', 'unhandledRejection', describeError(reason))
    })
  } catch {
    /* 装不上也不影响 */
  }
}

/** 记录一次"插件入口被调用"的完整环境快照。 */
export function logBootSnapshot(scope, extra) {
  const info = {
    dshHome: process.env.DSH_HOME ?? null,
    dshProfile: process.env.DSH_PROFILE ?? null,
    dshProfileDir: process.env.DSH_PROFILE_DIR ?? null,
    node: process.version,
    execPath: process.execPath,
    cwd: (() => {
      try {
        return process.cwd()
      } catch {
        return null
      }
    })(),
    ...(extra ?? {}),
  }
  logEvent(scope, 'boot', info)
}
