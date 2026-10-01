/**
 * 会话发现层：在 `$DSH_HOME/sessions` 里定位“属于某个工作区”的全部会话。
 *
 * 设计取舍（重要）：
 *   - **不信目录名，只信 header 里的 `cwd`**。目录名是 `projectKey(cwd)` 的有损编码
 *     （分隔符压缩 + 251 字符截断），拿它反推路径会出错；反过来用 `cwd` 匹配是精确的。
 *   - 目录名只用于**写入**时计算落点（导出到哪 / 导入到哪），那里必须与 DSH 的算法逐字节一致。
 *   - 子会话（`delegationDepth > 0`）会被识别并标记，默认随父会话一起导出（保留血缘）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'

import { readHeaderFromFile } from './zstd-codec.js'
import { projectKey, samePath, encodeSegment } from './paths.js'

/** transcript 文件名前缀（不含压缩后缀时也兼容 `.jsonl`）。 */
const TRANSCRIPT_PREFIX = 'session.'

/** 判断某文件名是否是会话 transcript。 */
export function isTranscriptName(name) {
  return name.startsWith(TRANSCRIPT_PREFIX) && (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
}

/** DSH 会话根目录：`<DSH_HOME>/sessions`。 */
export function sessionsRoot(dshHome) {
  return path.join(dshHome, 'sessions')
}

/**
 * 扫描整个会话根，返回每个会话的元数据。
 *
 * @param {string} dshHome DSH_HOME
 * @returns {Promise<Array<{id:string, cwd:string|undefined, createdAt:number, delegationDepth:number,
 *   agentPreset:string|undefined, parentSession:string|undefined, dir:string, transcript:string,
 *   size:number, mtimeMs:number, projectDir:string}>>}
 */
export async function scanSessions(dshHome) {
  const root = sessionsRoot(dshHome)
  const out = []
  let projects
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    let sessionDirs
    try {
      sessionDirs = await fsp.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sdir of sessionDirs) {
      if (!sdir.isDirectory()) continue
      const dir = path.join(projectDir, sdir.name)
      let names
      try {
        names = await fsp.readdir(dir)
      } catch {
        continue
      }
      const transcriptName = names.find(isTranscriptName)
      if (!transcriptName) continue
      const transcript = path.join(dir, transcriptName)
      const header = await readHeaderFromFile(transcript, fsp)
      if (!header) continue
      let stat = null
      try {
        stat = await fsp.stat(transcript)
      } catch {
        /* 读不到大小不影响识别 */
      }
      out.push({
        id: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        delegationDepth: header.delegationDepth ?? 0,
        agentPreset: header.agentPreset,
        parentSession: header.parentSession,
        isSeeded: header.isSeeded,
        version: header.version,
        dir,
        transcript,
        transcriptName,
        projectDir,
        projectKey: project.name,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
      })
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/**
 * 找出属于某个工作区路径的全部会话（含子会话）。
 *
 * @param {string} dshHome
 * @param {string} cwd 工作区路径
 * @returns {Promise<Array>} 按 createdAt 升序（导出顺序稳定）
 */
export async function sessionsForWorkspace(dshHome, cwd) {
  const all = await scanSessions(dshHome)
  const mine = all.filter((s) => typeof s.cwd === 'string' && samePath(s.cwd, cwd))
  // 子会话排在其父会话之后，便于阅读
  mine.sort((a, b) => a.createdAt - b.createdAt)
  return mine
}

/**
 * 目标落点：某个 cwd 在会话根下的项目目录，以及某个会话的日志文件绝对路径。
 *
 * 写入端必须用这个函数，保证与 DSH 的目录算法一致：
 *   - 项目目录名 = `projectKey(cwd)`
 *   - **会话目录名 = `encodeSegment(id)`**（已核实 DSH 的 `sessionDir()` 就是这么拼的；
 *     即使 id 里只有安全字符，也必须走这个转义，否则含特殊字符的 id 会写错位置）
 *   - 文件名 = `session.v4.jsonl.zstd`
 */
export function targetPaths(dshHome, cwd, sessionId) {
  const projectDir = path.join(sessionsRoot(dshHome), projectKey(cwd))
  const sessionDir = path.join(projectDir, encodeSegment(sessionId))
  return { projectDir, sessionDir, transcript: path.join(sessionDir, 'session.v4.jsonl.zstd') }
}

/** 汇总会话集合的基本统计（给 UI / 提示用）。 */
export function summarizeSessions(sessions) {
  const roots = sessions.filter((s) => (s.delegationDepth ?? 0) === 0)
  const subs = sessions.filter((s) => (s.delegationDepth ?? 0) > 0)
  return {
    total: sessions.length,
    roots: roots.length,
    subagents: subs.length,
    bytes: sessions.reduce((sum, s) => sum + (s.size ?? 0), 0),
    oldest: sessions.length ? Math.min(...sessions.map((s) => s.createdAt)) : 0,
    newest: sessions.length ? Math.max(...sessions.map((s) => s.createdAt)) : 0,
  }
}
