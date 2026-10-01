/**
 * 导入：把 `.dsvault` 里的会话还原进本机 `$DSH_HOME/sessions`，并映射到目标工作区路径。
 *
 * 跨机路径映射是这里的核心：
 *   会话 header 里的 `cwd` 决定它属于哪个工作区；目标机路径不同时必须重写 `cwd`。
 *   而写入位置必须用 `projectKey(新 cwd)` 计算，与 DSH 的目录算法逐字节一致。
 *
 * 三条安全纪律（都在代码里强制，不靠使用者自觉）：
 *   1. 先校验 sha256 再写任何字节；坏包不落地；
 *   2. **同 id 已存在 → 默认跳过**，绝不覆盖本机已有会话；
 *   3. 默认 dry-run：只报计划，不写盘；显式 `apply: true` 才落盘。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'

import { listZip, readZipEntry } from './zip.js'
import { readHeader, replaceHeader, validateTranscript } from './zstd-codec.js'
import { targetPaths, scanSessions } from './session-store.js'
import { samePath, assertSafeRelative } from './paths.js'
import { sha256, writeFileAtomic, isFile } from './fsx.js'
import { planContentImport, applyContentImport } from './content.js'

/**
 * 读取 `.dsvault` 并逐项校验。
 * @param {string} vaultPath
 */
export async function openVault(vaultPath) {
  let buf
  try {
    buf = await fsp.readFile(vaultPath)
  } catch (err) {
    throw new Error(`读不到整合包：${vaultPath}（${err.message}）`)
  }
  const entries = listZip(buf)
  if (entries.reduce((total, e) => total + e.size, 0) > 1024 * 1024 * 1024) throw new Error('课程包解压后超过 1 GiB')
  const manifestEntry = entries.find((e) => e.name === '.dsvault/manifest.json')
  if (!manifestEntry) throw new Error('不是有效的 .dsvault：缺少 .dsvault/manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readZipEntry(buf, '.dsvault/manifest.json').toString('utf8'))
  } catch (err) {
    throw new Error(`manifest.json 解析失败：${err.message}`)
  }
  if (manifest.format !== 'dsvault') throw new Error(`格式标记不对：${manifest.format}`)
  if (manifest.vaultVersion !== 1) throw new Error(`不支持的课程包版本：${manifest.vaultVersion}`)
  if (!Array.isArray(manifest.sessions)) throw new Error('manifest.sessions 不是数组')

  const checks = []
  const ids = new Set()
  for (const record of manifest.sessions) {
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id)) throw new Error('会话 id 缺失或重复')
    ids.add(record.id)
    if (typeof record.file !== 'string' || !record.file.startsWith('.dsvault/sessions/')) throw new Error('会话文件路径无效')
    const entry = entries.find((e) => e.name === record.file)
    if (!entry) {
      checks.push({ id: record.id, ok: false, reason: '归档中缺少该会话文件', data: null })
      continue
    }
    let data
    try {
      data = readZipEntry(buf, record.file, entries)
    } catch (err) {
      checks.push({ id: record.id, ok: false, reason: err.message, data: null })
      continue
    }
    const actual = sha256(data)
    if (typeof record.sha256 !== 'string' || actual !== record.sha256) {
      checks.push({ id: record.id, ok: false, reason: 'sha256 不匹配（包可能损坏或被改动）', data: null })
      continue
    }
    const validated = validateTranscript(data)
    if (validated.header.id !== record.id || validated.header.version !== 4) throw new Error(`会话身份或格式不匹配：${record.id}`)
    checks.push({ id: record.id, ok: true, reason: 'ok', data })
  }
  // 内容校验必须先于任何会话写入，不能留下半个损坏的课程。
  for (const record of manifest.content ?? []) {
    if (typeof record.file !== 'string' || !record.file.startsWith('.dsvault/content/')) throw new Error('内容文件路径无效')
    const data = readZipEntry(buf, record.file, entries)
    if (typeof record.sha256 !== 'string' || sha256(data) !== record.sha256) throw new Error(`课程文件 sha256 校验失败：${record.path}`)
  }
  return { buf, manifest, checks, entries: entries.map((e) => e.name), archiveBytes: buf.length }
}

/**
 * 规划导入：不写盘，产出逐会话的动作清单。
 *
 * @param {object} opts
 * @param {string} opts.vaultPath 包路径
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} [opts.targetCwd] 目标工作区路径；省略则用包里的 sourceWorkspace
 * @param {boolean} [opts.replace] true=同 id 覆盖（会先备份原文件）；默认跳过
 * @returns {Promise<object>} 计划
 */
export async function planImport(opts) {
  const { vaultPath, dshHome, replace = false } = opts
  if (!dshHome) throw new Error('缺少 DSH_HOME')
  const vault = await openVault(vaultPath)
  const targetCwd = opts.targetCwd ?? vault.manifest.sourceWorkspace
  if (!targetCwd) throw new Error('包里没有 sourceWorkspace，必须显式指定目标工作区路径')

  const broken = vault.checks.filter((c) => !c.ok)
  if (broken.length) {
    throw new Error(
      `包校验失败，拒绝导入：${broken.map((b) => `${b.id}(${b.reason})`).join('、')}`,
    )
  }

  const rewriteNeeded = !samePath(
    typeof vault.manifest.sourceWorkspace === 'string' ? vault.manifest.sourceWorkspace : targetCwd,
    targetCwd,
  )

  const actions = []
  const existingSessions = await scanSessions(dshHome)
  for (const check of vault.checks) {
    const record = vault.manifest.sessions.find((s) => s.id === check.id)
    const header = readHeader(check.data).header
    const sourceRoot = String(vault.manifest.sourceWorkspace ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    const sourceCwd = String(header.cwd ?? '').replace(/[\\/]+/g, '/')
    const relativeCwd = sourceRoot && sourceCwd.toLowerCase().startsWith(sourceRoot.toLowerCase() + '/') ? sourceCwd.slice(sourceRoot.length + 1) : ''
    const mappedCwd = relativeCwd ? path.join(targetCwd, assertSafeRelative(relativeCwd)) : targetCwd
    const duplicate = existingSessions.find((s) => s.id === record.id && !samePath(s.cwd, mappedCwd))
    if (duplicate) throw new Error(`本机已在另一课程路径保存同一聊天：${duplicate.cwd}。请更新原课程，或在另一台电脑导入；不能复制相同会话身份到两个工作区。`)
    const { projectDir, sessionDir, transcript } = targetPaths(dshHome, mappedCwd, record.id)
    const exists = isFile(transcript)
    let action = 'create'
    if (exists) action = replace ? 'replace' : 'skip'
    actions.push({
      id: record.id,
      createdAt: record.createdAt,
      createdAtText: record.createdAtText,
      parentSession: record.parentSession,
      delegationDepth: record.delegationDepth ?? 0,
      agentPreset: record.agentPreset,
      sourceCwd: header.cwd,
      targetCwd: mappedCwd,
      headerRewrite: !samePath(header.cwd, mappedCwd),
      action,
      targetProjectDir: projectDir,
      targetSessionDir: sessionDir,
      targetTranscript: transcript,
      bytes: check.data.length,
      data: check.data,
      header,
    })
  }

  // 内容段差异（完整包才有）。这里只读归档、不写盘。
  let contentPlan = null
  if (Array.isArray(vault.manifest.content) && vault.manifest.content.length > 0 && opts.contentTarget) {
    contentPlan = await planContentImport(opts.contentTarget, vault.manifest.content, (file) => {
      try {
        return readZipEntry(vault.buf, file)
      } catch {
        return undefined
      }
    })
  }

  return {
    vaultPath,
    manifest: vault.manifest,
    targetCwd,
    rewriteNeeded,
    actions,
    content: contentPlan,
    summary: {
      total: actions.length,
      create: actions.filter((a) => a.action === 'create').length,
      replace: actions.filter((a) => a.action === 'replace').length,
      skip: actions.filter((a) => a.action === 'skip').length,
      rewrites: actions.filter((a) => a.headerRewrite).length,
      bytes: actions.reduce((sum, a) => sum + a.bytes, 0),
      contentTotal: contentPlan ? contentPlan.create.length + contentPlan.same.length + contentPlan.conflict.length : 0,
      contentCreate: contentPlan?.create.length ?? 0,
      contentSame: contentPlan?.same.length ?? 0,
      contentConflict: contentPlan?.conflict.length ?? 0,
    },
  }
}

/**
 * 导入一个「完整包」（课程内容 + 会话记录，dsh-course-vault 的默认形态）。
 *
 * 两个落点各自独立，因此**一个失败不影响另一个**：
 *   - 课程内容 → `contentTarget`（课程文件夹）
 *   - 会话记录 → `$DSH_HOME/sessions`，并按 `targetCwd` 做路径映射
 *
 * @param {object} opts
 * @param {string} opts.vaultPath
 * @param {string} opts.dshHome
 * @param {string} opts.contentTarget 课程内容落点（通常是课程文件夹）
 * @param {string} [opts.targetCwd] 会话映射到的工作区路径（默认取包里的 sourceWorkspace）
 * @param {boolean} [opts.apply] 必须显式为 true 才写盘
 * @param {boolean} [opts.replace] 允许覆盖冲突的内容文件与会话
 * @param {boolean} [opts.contentOnly] 只导内容
 * @param {boolean} [opts.sessionsOnly] 只导会话
 * @param {(stage:string, detail:string)=>void} [opts.onProgress]
 */
export async function importFullVault(opts) {
  const progress = (stage, detail) => opts.onProgress?.(stage, detail ?? '')
  const vault = await openVault(opts.vaultPath)
  const hasContent = Array.isArray(vault.manifest.content) && vault.manifest.content.length > 0

  let preparedContent = null
  if (hasContent && opts.sessionsOnly !== true) {
    if (!opts.contentTarget) throw new Error('这是完整包，必须指定课程内容落点（contentTarget）')
    preparedContent = await planContentImport(opts.contentTarget, vault.manifest.content, (file) => readZipEntry(vault.buf, file))
  }

  // ① 会话段（除非明确只要内容）
  let sessionResult = null
  if (opts.contentOnly !== true) {
    sessionResult = await importVault(opts)
  }

  // ② 内容段
  let contentResult = null
  if (hasContent && opts.sessionsOnly !== true) {
    if (!opts.contentTarget) throw new Error('这是完整包，必须指定课程内容落点（contentTarget）')
    progress('content', `检查内容差异 → ${opts.contentTarget}`)
    const plan = preparedContent
    if (opts.apply !== true) {
      contentResult = { applied: false, plan }
    } else {
      const applied = await applyContentImport(plan, { replace: opts.replace === true, onProgress: progress })
      contentResult = { applied: true, ...applied, plan }
    }
  }

  return {
    ok: true,
    applied: opts.apply === true,
    kind: vault.manifest.kind,
    sourceWorkspace: vault.manifest.sourceWorkspace,
    contentTarget: opts.contentTarget ?? null,
    sessions: sessionResult,
    content: contentResult
      ? {
          applied: contentResult.applied,
          written: contentResult.written ?? [],
          skipped: contentResult.skipped ?? [],
          summary: {
            create: contentResult.plan.create.length,
            same: contentResult.plan.same.length,
            conflict: contentResult.plan.conflict.length,
          },
        }
      : null,
  }
}

/**
 * 执行导入。
 *
 * @param {object} opts 同 planImport，另加：
 * @param {boolean} opts.apply 必须显式为 true 才写盘
 * @param {(stage:string, detail:string)=>void} [opts.onProgress]
 * @returns {Promise<object>}
 */
export async function importVault(opts) {
  const progress = (stage, detail) => opts.onProgress?.(stage, detail ?? '')
  const plan = await planImport(opts)
  // dry-run 与正式导入返回**同一形状**（written/skipped 为空数组），
  // 调用方不必分辨两种模式；完整逐条计划体积很大，只在需要时另调 planImport。
  if (opts.apply !== true) {
    progress('plan', 'dry-run：未写入任何文件')
    return {
      ok: true,
      applied: false,
      targetCwd: plan.targetCwd,
      written: [],
      skipped: plan.actions.filter((a) => a.action === 'skip').map((a) => ({ id: a.id, reason: '目标机已存在同 id 会话' })),
      backups: [],
      summary: plan.summary,
    }
  }

  const written = []
  const backups = []
  const skipped = []
  progress('write', `准备写入 ${plan.actions.length} 个会话到 ${plan.targetCwd}`)

  for (const action of plan.actions) {
    if (action.action === 'skip') {
      skipped.push({ id: action.id, reason: '目标机已存在同 id 会话' })
      continue
    }
    let payload = action.data
    if (action.headerRewrite) {
      // 只重压 header frame；事件 frame 原样字节拷贝（无损）
      const nextHeader = { ...action.header, cwd: action.targetCwd }
      payload = replaceHeader(action.data, nextHeader)
      const recheck = readHeader(payload)
      if (recheck.header.cwd !== action.targetCwd) throw new Error(`路径重写后校验失败：${action.id}`)
    }

    // 写入前再自检一次，确保落盘的字节一定是合法会话日志
    validateTranscript(payload)

    if (action.action === 'replace' && isFile(action.targetTranscript)) {
      const backupPath = `${action.targetTranscript}.bak-${Date.now()}`
      const original = await fsp.readFile(action.targetTranscript)
      await writeFileAtomic(backupPath, original)
      backups.push({ id: action.id, path: backupPath })
    }

    await writeFileAtomic(action.targetTranscript, payload)
    written.push({
      id: action.id,
      path: action.targetTranscript,
      bytes: payload.length,
      headerRewritten: action.headerRewrite,
    })
    progress('write', `${action.action === 'replace' ? '覆盖' : '写入'} ${action.id}（${payload.length} B）`)
  }

  progress('done', `导入完成：写入 ${written.length}，跳过 ${skipped.length}`)
  return {
    ok: true,
    applied: true,
    targetCwd: plan.targetCwd,
    written,
    skipped,
    backups,
    summary: plan.summary,
  }
}
