/**
 * RPC 端点表：`/dsh-course/<endpoint>`。
 *
 * 每个端点的 payload 都显式过一遍（路径、布尔、字符串），避免把 UI 传来的任意值
 * 直接当文件系统路径用；写盘动作（export/import/preset-sync）都要求显式 `apply: true`
 * 或本身就是幂等且可回滚的操作。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { exportWorkspaceSessions, inspectVault, listVaults, listWorkspaces } from './core/export.js'
import { planImport, importFullVault } from './core/import.js'
import { syncCoursePreset, presetStatus } from './core/preset.js'
import { isDir } from './core/fsx.js'

const PLUGIN_VERSION = '0.1.0'

/** 课程卡的候选文件名（第一层为插件约定，其余为这门课已有的写法）。 */
const CARD_CANDIDATES = ['course.config.yaml', 'course.config.yml']

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数：${field}`)
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 极简 YAML 读取：只认 `key: value` 顶层，够读课程卡，不引第三方 YAML 库。 */
export function parseSimpleYaml(text) {
  const out = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === 'true') out[key] = true
    else if (value === 'false') out[key] = false
    else if (value !== '') out[key] = value
  }
  return out
}

/**
 * 读课程卡 + 关键文件是否存在。找不到就用课程文件夹自身的约定回退，
 * 并且**如实报告**读到了什么、缺什么（不虚构）。
 */
async function readCourseCard(contentRoot) {
  const cardPath = await (async () => {
    for (const name of CARD_CANDIDATES) {
      const p = path.join(contentRoot, name)
      try {
        await fsp.access(p)
        return p
      } catch {
        /* 继续找 */
      }
    }
    return null
  })()

  let card = null
  let cardError = null
  if (cardPath) {
    try {
      card = parseSimpleYaml(await fsp.readFile(cardPath, 'utf8'))
    } catch (err) {
      cardError = err.message
    }
  }

  const teacherPrompt = card?.teacherPrompt ?? '01_TEACHER_PROMPT.md'
  const learningState = card?.learningState ?? '03_LEARNING_STATE.md'
  const index = card?.index ?? '02_COURSE_INDEX.md'
  const present = async (rel) => {
    try {
      await fsp.access(path.join(contentRoot, rel))
      return true
    } catch {
      return false
    }
  }

  return {
    contentRoot,
    cardPath,
    card,
    cardError,
    files: {
      teacherPrompt: { name: teacherPrompt, present: await present(teacherPrompt) },
      learningState: { name: learningState, present: await present(learningState) },
      index: { name: index, present: await present(index) },
    },
  }
}

/**
 * 端点表。
 * @param {() => {home: string, profileName: string, source: string}} getRuntime
 * @param {() => object} [getCtx] 取宿主 ctx（`preset/list` 需要读 roster 服务）
 */
export function makeEndpoints(getRuntime, getCtx = () => undefined) {
  return {
    /** 运行时事实与版本。 */
    'runtime/get': async () => {
      const rt = getRuntime()
      return {
        plugin: { name: 'dsh-course-vault', version: PLUGIN_VERSION },
        dshHome: rt.home,
        profileName: rt.profileName,
        runtimeSource: rt.source,
        channel: '/dsh-course',
      }
    },

    /** 课程模式 preset 是否就位（含换指 junction 的提醒）。 */
    'preset/status': async () => {
      const rt = getRuntime()
      // 传 ctx：自检要顺带问 roster 实际发现了哪些模式（两代服务名都试）
      return presetStatus(rt.home, getCtx())
    },

    /** 手动同步课程模式 preset（幂等）。 */
    'preset/sync': async (payload) => {
      const rt = getRuntime()
      return syncCoursePreset({ dshHome: rt.home, force: payload?.force === true })
    },

    /** 列出会话根下所有工作区。 */
    'workspace/list': async () => {
      const rt = getRuntime()
      return listWorkspaces(rt.home)
    },

    /**
     * 列出 DSH 的 agent-preset roster 实际发现到的模式（含损坏原因）。
     *
     * 「课程模式没出现在模式选择器里」是最容易被误判的问题：组装文件可能完全合法，
     * 但 roster 压根没扫到用户根，或者把它判成了 broken 而选择器不显示损坏项。
     * 这个端点把 roster 的原始答案摊开，省得靠猜。
     */
    'preset/list': async () => {
      const ctx = getCtx()
      // DSH 0.1.x 用 agentPresets；0.2.x 用 agentPresetRegistry
      const roster = ctx?.get?.('agentPresets') ?? ctx?.get?.('agentPresetRegistry')
      if (!roster) {
        return {
          available: false,
          reason: '当前宿主没有挂载 agentPresets 服务（该 profile 不含 agent-preset roster）',
        }
      }
      const list = await roster.list()
      return {
        available: true,
        defaultId: roster.defaultId ?? null,
        authorable: roster.authorable ?? null,
        // roots 是 roster 实际扫描的目录——判断「为什么没扫到」看这里
        roots: (roster.roots ?? []).map((r) => ({ path: r.path, trust: r.trust })),
        presets: list.map((p) => ({
          id: p.id,
          trust: p.trust,
          name: p.name ?? null,
          description: p.description ?? null,
          order: p.order ?? null,
          path: p.path,
          ...(p.broken ? { broken: p.broken } : {}),
        })),
      }
    },

    /** 列出已经落盘的 .dsvault。 */
    'vault/list': async (payload) => {
      const dir = requireString(payload?.sessionsDir, 'sessionsDir')
      return listVaults(dir)
    },

    /** 查看一个 .dsvault 的清单并逐项校验 sha256。 */
    'vault/inspect': async (payload) => {
      const vaultPath = requireString(payload?.vaultPath, 'vaultPath')
      return inspectVault(vaultPath)
    },

    /** 读课程卡与关键文件存在性。 */
    'course/card': async (payload) => {
      const contentRoot = requireString(payload?.contentRoot, 'contentRoot')
      if (!isDir(contentRoot)) throw new Error(`课程文件夹不存在：${contentRoot}`)
      return readCourseCard(contentRoot)
    },

    /**
     * 一键导出：默认「完整包」（课程内容 + 会话记录）。
     * `sessionsOnly: true` 时只导会话（日常来回搬用）。
     */
    'course/export': async (payload) => {
      const rt = getRuntime()
      const progress = []
      const collect = (stage, detail) => progress.push(`${stage}: ${detail}`)
      const workspace = requireString(payload?.workspace, 'workspace')
      const contentRoot = optionalString(payload?.contentRoot)
      const sessionsOnly = payload?.sessionsOnly === true
      const sessionsDir =
        optionalString(payload?.sessionsDir) ?? (contentRoot ? path.join(contentRoot, 'sessions') : undefined)
      if (!sessionsDir) throw new Error('缺少参数：sessionsDir（或提供 contentRoot 以默认落到 <课程>/sessions）')

      const result = await exportWorkspaceSessions({
        dshHome: rt.home,
        workspace,
        contentRoot: sessionsOnly ? null : contentRoot,
        sessionsDir,
        all: payload?.all === true,
        name: optionalString(payload?.name),
        toolVersion: PLUGIN_VERSION,
        onProgress: collect,
      })
      return { ...result, progress }
    },

    /** 只看差异、不写盘（导入前的预览）。 */
    'course/import-plan': async (payload) => {
      const rt = getRuntime()
      const vaultPath = requireString(payload?.vaultPath, 'vaultPath')
      const contentTarget = optionalString(payload?.contentTarget)
      const targetCwd = optionalString(payload?.targetCwd)
      await planImport({ vaultPath, dshHome: rt.home, targetCwd, replace: payload?.replace === true })
      return importFullVault({ vaultPath, dshHome: rt.home, contentTarget, targetCwd, apply: false })
    },

    /**
     * 一键导入：内容落 contentTarget，会话落 $DSH_HOME/sessions 并按 targetCwd 映射。
     * 必须显式 `apply: true` 才写盘。
     */
    'course/import': async (payload) => {
      const rt = getRuntime()
      const progress = []
      const collect = (stage, detail) => progress.push(`${stage}: ${detail}`)
      const vaultPath = requireString(payload?.vaultPath, 'vaultPath')
      const contentTarget = optionalString(payload?.contentTarget)
      const targetCwd = optionalString(payload?.targetCwd)
      const result = await importFullVault({
        vaultPath,
        dshHome: rt.home,
        contentTarget,
        targetCwd,
        apply: payload?.apply === true,
        replace: payload?.replace === true,
        contentOnly: payload?.contentOnly === true,
        sessionsOnly: payload?.sessionsOnly === true,
        onProgress: collect,
      })
      return { ...result, progress }
    },
  }
}
