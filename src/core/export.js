/**
 * 导出：把某个工作区的全部会话打成一个 `.dsvault` 便携包。
 *
 * 包结构（标准 ZIP，可被 7-Zip / 资源管理器直接打开）：
 *   .dsvault/manifest.json    清单：源机工作区、会话元数据、逐文件 sha256
 *   .dsvault/sessions/<会话id>/session.v4.jsonl.zstd
 *
 * 关键设计：
 *   - **原始字节入包**。会话日志是 zstd 压缩的，本身不可再压，因此按字节原样打包，
 *     既省 CPU 又保证与源机完全一致。
 *   - **增量**。`exported.json` 账本记录已导出的会话 id，默认只导出自上次以来的新会话，
 *     避免 72 课来回搬时反复复制全量。
 *   - manifest 里带**每个文件的 sha256**，导入端据此逐项校验，坏包不落地。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'

import { sessionsForWorkspace, summarizeSessions, scanSessions } from './session-store.js'
import { collectContentFiles, readContentEntries } from './content.js'
import { zipSync } from './zip.js'
import { sha256, writeFileAtomic, safeFileName, fmtTime } from './fsx.js'
import { readCourseMetadata, CHAT_DIR } from './layout.js'
import { scanFrames, decodeFrame, validateTranscript } from './zstd-codec.js'

export const VAULT_FORMAT_VERSION = 1
export const LEDGER_NAME = 'exported.json'

/** 账本路径：`<课程文件夹>/sessions/exported.json`。 */
export function ledgerPath(sessionsDir) {
  return path.join(sessionsDir, LEDGER_NAME)
}

/** 读取导出账本；不存在或缺字段时返回空账本。 */
export async function readLedger(sessionsDir) {
  try {
    const raw = await fsp.readFile(ledgerPath(sessionsDir), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ledgerVersion: parsed.ledgerVersion ?? 1,
      updatedAt: parsed.updatedAt ?? 0,
      exported: parsed.exported && typeof parsed.exported === 'object' ? parsed.exported : {},
    }
  } catch {
    return { ledgerVersion: 1, updatedAt: 0, exported: {} }
  }
}

/** 原子写账本（导出成功后调用）。 */
export async function writeLedger(sessionsDir, ledger) {
  await writeFileAtomic(ledgerPath(sessionsDir), JSON.stringify({ ...ledger, ledgerVersion: 1 }, null, 2) + '\n')
}

/**
 * 生成默认包名：`<课程名>-<YYYYMMDD>.dsvault`。
 * @param {string} cwd 工作区路径
 * @param {Date} [now]
 */
export function defaultVaultName(cwd, now = new Date()) {
  const base = safeFileName(path.basename(cwd) || 'workspace')
  const pad = (v) => String(v).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `${base}-${stamp}.dsvault`
}

/**
 * 导出：会话记录 +（可选）整个课程文件夹，打成一个 `.dsvault`。
 *
 * 两个路径**刻意分开**，因为现实中它们经常不是同一个目录：
 *   - `workspace`：会话归属的工作区（用于按 header.cwd 匹配会话）；
 *   - `contentRoot`：要打包的课程文件夹（换机要搬的课程内容）。
 *
 * @param {object} opts
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 会话归属的工作区路径（缺省时回退到 `cwd`）
 * @param {string} [opts.contentRoot] 要打包的课程文件夹；给了就是「一键完整包」
 * @param {string} opts.sessionsDir 输出目录（通常 `<课程文件夹>/sessions`）
 * @param {string} [opts.name] 包名（不含目录）
 * @param {boolean} [opts.all] true=全量导出；默认增量（只导出自上次账本以来新增的会话）
 * @param {(stage:string, detail:string)=>void} [opts.onProgress]
 * @returns {Promise<object>} 结果摘要
 */
export async function exportWorkspaceSessions(opts) {
  const { dshHome, sessionsDir, onProgress } = opts
  const workspace = opts.workspace ?? opts.cwd
  const contentRoot = opts.contentRoot ?? null
  const progress = (stage, detail) => onProgress?.(stage, detail ?? '')
  if (!dshHome) throw new Error('缺少 DSH_HOME')
  if (!workspace) throw new Error('缺少会话归属的工作区路径（workspace）')
  if (!sessionsDir) throw new Error('缺少输出目录')

  progress('scan', `扫描 ${workspace} 的会话`)
  const all = await sessionsForWorkspace(dshHome, workspace, { descendants: !!contentRoot })
  // 允许「有内容无会话」：课程文件夹可能还没在这个工作区开过会话，
  // 但用户仍然要导出一份课程包（换机先放内容，之后再补会话）。
  if (all.length === 0 && !contentRoot) {
    throw new Error(`工作区没有任何会话记录：${workspace}（若只想打包课程内容，请给 contentRoot）`)
  }

  const ledger = await readLedger(sessionsDir)
  const known = new Set(Object.keys(ledger.exported))
  // 完整迁移包必须独立可恢复：包含所有会话的最新字节，不能依赖旧包/账本。
  const targets = opts.all || contentRoot ? all : all.filter((s) => !known.has(s.id))

  if (targets.length === 0 && !contentRoot) {
    const summary = summarizeSessions(all)
    return {
      ok: true,
      skipped: true,
      reason: '没有新会话需要导出（全部已在账本中）',
      total: summary.total,
      stats: summary,
    }
  }

  progress('collect', `读取 ${targets.length} 个会话的日志`)
  const entries = []
  const sessionRecords = []
  const snapshots = []
  const course = contentRoot ? await readCourseMetadata(contentRoot) : null
  for (const s of targets) {
    const data = await fsp.readFile(s.transcript)
    validateTranscript(data)
    const rel = `.dsvault/sessions/${s.id}/${s.transcriptName}`
    entries.push({ name: rel, data })
    sessionRecords.push({
      id: s.id,
      createdAt: s.createdAt,
      createdAtText: fmtTime(s.createdAt),
      cwd: s.cwd,
      delegationDepth: s.delegationDepth ?? 0,
      ...(s.parentSession ? { parentSession: s.parentSession } : {}),
      ...(s.agentPreset ? { agentPreset: s.agentPreset } : {}),
      version: s.version,
      file: rel,
      bytes: data.length,
      sha256: sha256(data),
    })
    if (course) {
      const text = scanFrames(data).frames.map((f) => decodeFrame(data.subarray(f.start, f.end)).toString('utf8')).join('')
      // 聊天原始记录保留在课程的第二个目录；Harness 中继续学习使用原生会话段。
      snapshots.push({ rel: `${CHAT_DIR}/${safeFileName(s.id)}/session.v4.jsonl.zstd`, data })
      snapshots.push({ rel: `${CHAT_DIR}/${safeFileName(s.id)}/session.jsonl`, data: Buffer.from(text) })
    }
    progress('collect', `已读 ${s.id}（${data.length} B）`)
  }

  // 课程内容段（可选）：把整个课程文件夹也收进同一个包，实现「换机只拷一个文件」。
  // 默认排除输出目录本身，避免把上一版包套进自己。
  let contentRecords = null
  let contentBytes = 0
  if (contentRoot) {
    progress('content', `收集课程内容：${contentRoot}`)
    const files = await collectContentFiles(contentRoot, { skipSiblings: [sessionsDir, ...(course ? [path.join(contentRoot, CHAT_DIR)] : [])] })
    const read = await readContentEntries(contentRoot, files)
    entries.push(...read.entries)
    contentRecords = read.records
    contentBytes = read.bytes
    for (const snapshot of snapshots) {
      const file = `.dsvault/content/${snapshot.rel}`
      entries.push({ name: file, data: snapshot.data })
      contentRecords.push({ path: snapshot.rel, file, bytes: snapshot.data.length, sha256: sha256(snapshot.data) })
      contentBytes += snapshot.data.length
    }
    progress('content', `内容 ${contentRecords.length} 个文件（${contentBytes} B）`)
  }

  const exportedAt = Date.now()
  const manifest = {
    format: 'dsvault',
    vaultVersion: VAULT_FORMAT_VERSION,
    kind: contentRoot ? 'course-full' : 'workspace-sessions',
    exportedAt,
    exportedAtText: fmtTime(exportedAt),
    sourceWorkspace: workspace,
    ...(contentRoot ? { sourceContentRoot: contentRoot } : {}),
    ...(course ? { course } : {}),
    toolkit: { name: 'dsh-course-vault', version: opts.toolVersion ?? '0.1.0' },
    dshHome,
    sessions: sessionRecords,
    ...(contentRecords ? { content: contentRecords } : {}),
    totals: {
      sessions: sessionRecords.length,
      sessionBytes: sessionRecords.reduce((sum, s) => sum + s.bytes, 0),
      ...(contentRecords ? { contentFiles: contentRecords.length, contentBytes } : {}),
      bytes: sessionRecords.reduce((sum, s) => sum + s.bytes, 0) + contentBytes,
    },
    notes: [
      '会话记录是「连续性」材料：跨机后模型能想起上次讨论过什么。',
      '完整包包含课程资料、学习进度、讲解笔记、学员代码和最新原生聊天。学习完成情况以学习进度中的实际证据为准。',
      '导入时若目标机工作区路径不同，插件的路径映射会重写会话 header 的 cwd。',
    ],
  }

  entries.push({ name: '.dsvault/manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') })

  progress('pack', `打包 ${entries.length} 个条目`)
  const bytes = zipSync(entries)
  if (contentRoot && bytes.length > 512 * 1024 * 1024) throw new Error('完整课程包超过当前导入上限 512 MiB，请移出可重新安装的环境和大型缓存后再导出')

  const fileName = opts.name ?? defaultVaultName(contentRoot ?? workspace, new Date(exportedAt))
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.dsvault')) throw new Error('包名必须是以 .dsvault 结尾的文件名')
  const outPath = path.join(sessionsDir, fileName)
  progress('write', `写入 ${outPath}`)
  await writeFileAtomic(outPath, bytes)

  // 更新账本：只记“已经成功落盘”的会话
  const nextLedger = {
    ledgerVersion: 1,
    updatedAt: exportedAt,
    exported: { ...ledger.exported },
  }
  for (const s of sessionRecords) {
    nextLedger.exported[s.id] = {
      createdAt: s.createdAt,
      bytes: s.bytes,
      lastExportedAt: exportedAt,
      vault: fileName,
    }
  }
  await writeLedger(sessionsDir, nextLedger)

  const stats = summarizeSessions(all)
  progress('done', `导出完成：${fileName}`)
  return {
    ok: true,
    skipped: false,
    output: outPath,
    name: fileName,
    bytes: bytes.length,
    sha256: sha256(bytes),
    sessions: sessionRecords.length,
    sessionIds: sessionRecords.map((s) => s.id),
    remaining: all.length - targets.length,
    stats,
  }
}

/**
 * 查看一个 `.dsvault`：读取 manifest 并逐项校验 sha256。
 * 用于「先看包里有什么再决定装不装」。
 */
export async function inspectVault(vaultPath) {
  const buf = await fsp.readFile(vaultPath)
  const { listZip, readZipEntry } = await import('./zip.js')
  const entries = listZip(buf)
  const manifestEntry = entries.find((e) => e.name === '.dsvault/manifest.json')
  if (!manifestEntry) throw new Error('不是有效的 .dsvault：缺少 .dsvault/manifest.json')
  const manifest = JSON.parse(readZipEntry(buf, '.dsvault/manifest.json').toString('utf8'))
  if (manifest.format !== 'dsvault') throw new Error(`格式标记不对：${manifest.format}`)

  const checks = []
  for (const s of manifest.sessions ?? []) {
    const entry = entries.find((e) => e.name === s.file)
    if (!entry) {
      checks.push({ id: s.id, ok: false, reason: '归档中缺少该会话文件' })
      continue
    }
    let data
    try {
      data = readZipEntry(buf, s.file)
    } catch (err) {
      checks.push({ id: s.id, ok: false, reason: err.message })
      continue
    }
    const actual = sha256(data)
    checks.push({
      id: s.id,
      ok: actual === s.sha256,
      reason: actual === s.sha256 ? 'ok' : `sha256 不匹配（包内 ${s.sha256.slice(0, 12)}… / 实际 ${actual.slice(0, 12)}…）`,
      bytes: data.length,
    })
  }
  // 内容段同样逐项校验 sha256（完整包才有）
  const contentChecks = []
  for (const record of manifest.content ?? []) {
    let data
    try {
      data = readZipEntry(buf, record.file)
    } catch (err) {
      contentChecks.push({ path: record.path, ok: false, reason: err.message })
      continue
    }
    const actual = sha256(data)
    contentChecks.push({
      path: record.path,
      ok: actual === record.sha256,
      reason: actual === record.sha256 ? 'ok' : 'sha256 不匹配',
      bytes: data.length,
    })
  }

  return {
    manifest,
    checks,
    contentChecks,
    kind: manifest.kind ?? 'workspace-sessions',
    archiveBytes: buf.length,
    entries: entries.map((e) => e.name),
  }
}

/** 列出磁盘上所有 .dsvault。 */
export async function listVaults(sessionsDir) {
  let names
  try {
    names = await fsp.readdir(sessionsDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names.filter((n) => n.endsWith('.dsvault'))) {
    const full = path.join(sessionsDir, name)
    try {
      const stat = await fsp.stat(full)
      out.push({ name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      /* 忽略读不到的 */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 找出会话根下所有工作区（去重后的 cwd），给导入/导出选择用。 */
export async function listWorkspaces(dshHome) {
  const all = await scanSessions(dshHome)
  const map = new Map()
  for (const s of all) {
    if (typeof s.cwd !== 'string') continue
    const key = s.cwd.toLowerCase()
    const cur = map.get(key)
    if (cur) cur.sessions += 1
    else map.set(key, { cwd: s.cwd, sessions: 1, lastAt: s.createdAt })
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
}
