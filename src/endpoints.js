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
import { previewCourse, importCourse, listCourses, exportCourse } from './core/course.js'
import { makeTransfers } from './transfer.js'
import { sessionsForWorkspace } from './core/session-store.js'

const PLUGIN_VERSION = '0.3.3'

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
  const transfer = makeTransfers(() => getRuntime().home)
  const endpoints = {
    'course/list': async () => listCourses(getRuntime().home),
    'course/preview': async (payload) => previewCourse({ ...payload, sourcePath: requireString(payload?.sourcePath, 'sourcePath'), dshHome: getRuntime().home }),
    'course/add': async (payload) => {
      if (payload?.replace === true && payload?.apply === true) {
        const preview = await previewCourse({ ...payload, dshHome: getRuntime().home })
        const plan = preview.type === 'vault' ? await planImport({ vaultPath: payload.sourcePath, dshHome: getRuntime().home, targetCwd: preview.root, replace: true }) : null
        for (const action of plan?.actions ?? []) {
          if (action.action === 'replace' && getCtx()?.get?.('sessions')?.get?.(action.id)) throw new Error('这条聊天目前已在 Harness 中加载，请关闭该会话后再更新课程，避免覆盖正在使用的记录。')
        }
      }
      const result = await importCourse({ ...payload, sourcePath: requireString(payload?.sourcePath, 'sourcePath'), dshHome: getRuntime().home, apply: payload?.apply === true })
      if (result.applied) {
        result.workspace = await ensureWorkspaceRegistered(getCtx(), result.root, [...(result.sessions?.written ?? []), ...(result.sessions?.skipped ?? [])].map((s) => s.id))
      }
      return result
    },
    'course/portable-export': async (payload) => {
      await getCtx()?.get?.('sessionPersistence')?.flush?.()
      const result = await exportCourse({ dshHome: getRuntime().home, root: requireString(payload?.root, 'root') })
      return { ...result, downloadUrl: transfer.downloadLink(result.output, result.name) }
    },
    'course/open': async (payload) => ensureWorkspaceRegistered(getCtx(), requireString(payload?.root, 'root')),
    'course/history': async (payload) => {
      const sessions = await sessionsForWorkspace(getRuntime().home, requireString(payload?.root, 'root'), { descendants: true })
      return sessions.filter((s) => !s.delegationDepth).reverse().map((s) => ({ id: s.id, createdAt: s.createdAt, agentPreset: s.agentPreset }))
    },
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
     *
     * `registerWorkspace: true` 时顺带把课程文件夹注册成 DSH 工作区——
     * 这样导入完就能直接在侧边栏看到它，不用再去点「添加工作区」。
     */
    'course/import': async (payload) => {
      const rt = getRuntime()
      const progress = []
      const collect = (stage, detail) => progress.push(`${stage}: ${detail}`)
      const vaultPath = requireString(payload?.vaultPath, 'vaultPath')
      const contentTarget = optionalString(payload?.contentTarget)
      const targetCwd = optionalString(payload?.targetCwd)
      const applied = payload?.apply === true
      const result = await importFullVault({
        vaultPath,
        dshHome: rt.home,
        contentTarget,
        targetCwd,
        apply: applied,
        replace: payload?.replace === true,
        contentOnly: payload?.contentOnly === true,
        sessionsOnly: payload?.sessionsOnly === true,
        onProgress: collect,
      })

      // 只在真正写入后才动工作区注册
      let workspace = null
      if (applied && payload?.registerWorkspace === true) {
        workspace = await ensureWorkspaceRegistered(getCtx(), contentTarget ?? targetCwd, result.sessions?.written?.map((s) => s.id) ?? [])
      }
      return { ...result, workspace, progress }
    },
  }
  // 传输不作为 JSON RPC 端点；浏览器直接流式上传/下载二进制。
  Object.defineProperty(endpoints, 'transfer', { value: transfer })
  return endpoints
}

/**
 * 把某个目录注册成 DSH 工作区（幂等）。
 *
 * 0.2.x 的服务名是 `workspaceRegistry`；0.1.x 是 `workspaceRegistry` 的同名服务，
 * 两者都按 `{ create(path), resolveByPath(path) }` 提供，所以这里只做能力探测。
 * 注册失败**不影响导入结果**——所以只如实回报，不抛错。
 *
 * @param {object} ctx 宿主 ctx
 * @param {string|undefined} dir 要注册的目录
 */
async function ensureWorkspaceRegistered(ctx, dir, sessionIds = []) {
  if (!dir) return { path: null, created: false, note: '未提供目录，跳过工作区注册' }
  const registry = ctx?.get?.('workspaceRegistry')
  if (!registry || typeof registry.create !== 'function') {
    return { path: dir, created: false, note: '当前宿主没有 workspaceRegistry 服务，请手动添加工作区' }
  }
  try {
    const existing = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(dir) : null
    const created = existing ?? await registry.create(dir)
    const attached = []
    const failures = []
    for (const id of sessionIds) {
      try {
        if (typeof created.attachSession !== 'function') throw new Error('此版本不支持会话归属登记')
        await created.attachSession(id)
        attached.push(id)
      } catch (err) { failures.push({ id, message: err.message }) }
    }
    return {
      path: dir,
      created: !existing,
      alreadyRegistered: !!existing,
      workspaceId: created?.id ?? created?.workspaceId ?? null,
      attached, failures,
      note: failures.length ? '部分会话归属登记失败，请重启 Harness 后检查课程工作区。' : '已注册课程工作区。',
    }
  } catch (err) {
    return { path: dir, created: false, note: `注册工作区失败：${err?.message ?? err}` }
  }
}
