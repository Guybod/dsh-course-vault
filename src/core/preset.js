/**
 * 课程模式 preset 的维护：把插件仓库里的 `preset/course/` 同步到
 * `<DSH_HOME>/.agent-presets/course/`。
 *
 * 为什么必须由插件维护（而不是让用户手放）：
 *   1. `$DSH_HOME/.agent-presets` 可能是**换指 junction**（dsh-pack 整合包会按 profile 换指）。
 *      换指之后原来的课程模式就"消失"了——所以每次启动/每次 sync 都要能重新落进去。
 *   2. 预设是「组装 = 能力」，跟权限同级；由插件统一维护便于版本对齐与审计。
 *
 * 发现机制的事实（`dsh-agent-presets`）：
 *   - `$DSH_HOME/.agent-presets` 是推导出的 user 根，**不缓存**，写进去立即可见；
 *   - 目录名就是 preset id，必须匹配 `[a-z0-9][a-z0-9-]*`；
 *   - `agent.cordis.yml` 里的**相对路径从 preset 自己的目录解析**，所以技能随 preset 迁移。
 *
 * 幂等策略：逐文件比 sha256，只写有变化的文件，并删掉本插件拥有的陈旧文件
 * （绝不碰用户自己创建的其它 preset）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { walkFiles, writeFileAtomic, sha256, isFile, isDir } from './fsx.js'

/** 本插件贡献的 preset id（目录名）。 */
export const PRESET_ID = 'course'

/** 仓库内 preset 源目录：`<包根>/preset/course`。 */
export function presetSourceDir() {
  const here = path.dirname(fileURLToPath(import.meta.url)) // <包根>/src/core
  return path.resolve(here, '..', '..', 'preset', PRESET_ID)
}

/** 用户根下的目标目录：`<DSH_HOME>/.agent-presets/course`。 */
export function presetTargetDir(dshHome) {
  return path.join(dshHome, '.agent-presets', PRESET_ID)
}

/** preset id 合法性（与 DSH 的约束一致）。 */
export function isValidPresetId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 同步 preset：把源目录内容复制到目标目录，只写变化，删除本插件拥有的陈旧文件。
 *
 * @param {object} opts
 * @param {string} opts.dshHome
 * @param {string} [opts.sourceDir] 源目录（默认取仓库内的 preset/course）
 * @param {boolean} [opts.force] true=无条件重写全部文件
 * @returns {Promise<{ok:boolean, target:string, written:string[], removed:string[], skipped:number, reason?:string}>}
 */
export async function syncCoursePreset(opts = {}) {
  const { dshHome, force = false } = opts
  if (!dshHome) throw new Error('缺少 DSH_HOME')
  if (!isValidPresetId(PRESET_ID)) throw new Error(`preset id 非法：${PRESET_ID}`)

  const source = opts.sourceDir ?? presetSourceDir()
  if (!isDir(source)) {
    return { ok: false, target: presetTargetDir(dshHome), written: [], removed: [], skipped: 0, reason: `预设源目录不存在：${source}` }
  }
  const target = presetTargetDir(dshHome)

  const sourceFiles = await walkFiles(source)
  if (sourceFiles.length === 0) {
    return { ok: false, target, written: [], removed: [], skipped: 0, reason: `预设源目录为空：${source}` }
  }
  // 必须有组装文件，否则 DSH 会把它列为「损坏的 preset」
  if (!sourceFiles.some((f) => path.basename(f) === 'agent.cordis.yml')) {
    return { ok: false, target, written: [], removed: [], skipped: 0, reason: '预设源缺少 agent.cordis.yml' }
  }

  const written = []
  let skipped = 0
  const wanted = new Set()
  // Windows 上 path.relative 用 `\`，但对外报告统一成 `/`，便于跨平台比较与展示
  const toRel = (abs, base) => path.relative(base, abs).replace(/\\/g, '/')

  for (const abs of sourceFiles) {
    const rel = toRel(abs, source)
    wanted.add(rel)
    const dest = path.join(target, rel)
    const data = await fsp.readFile(abs)
    if (!force && isFile(dest)) {
      const existing = await fsp.readFile(dest)
      if (existing.equals(data)) {
        skipped += 1
        continue
      }
    }
    await writeFileAtomic(dest, data)
    written.push(rel)
  }

  // 清理本插件拥有的陈旧文件（只删目标目录内、源里已不存在的文件）
  const removed = []
  if (isDir(target)) {
    for (const abs of await walkFiles(target)) {
      const rel = toRel(abs, target)
      if (wanted.has(rel)) continue
      // 双保险：只删目标 preset 目录严格内部的文件
      const resolved = path.resolve(abs)
      if (!resolved.startsWith(path.resolve(target) + path.sep)) continue
      await fsp.rm(abs, { force: true })
      removed.push(rel)
    }
  }

  return { ok: true, target, written, removed, skipped }
}

/**
 * 检查课程模式是否已就位（给 UI / 自检用）。
 * @param {string} dshHome
 */
export async function presetStatus(dshHome) {
  const target = presetTargetDir(dshHome)
  const assembly = path.join(target, 'agent.cordis.yml')
  const meta = path.join(target, 'preset.yml')
  const skill = path.join(target, 'skills', 'course-tutor', 'SKILL.md')
  const source = presetSourceDir()
  let upToDate = null
  if (isDir(source) && isFile(assembly)) {
    const srcFiles = await walkFiles(source)
    upToDate = true
    for (const abs of srcFiles) {
      const rel = path.relative(source, abs).replace(/\\/g, '/')
      const dest = path.join(target, rel)
      if (!isFile(dest)) {
        upToDate = false
        break
      }
      const [a, b] = await Promise.all([fsp.readFile(abs), fsp.readFile(dest)])
      if (sha256(a) !== sha256(b)) {
        upToDate = false
        break
      }
    }
  }
  return {
    id: PRESET_ID,
    installed: isFile(assembly),
    hasMetadata: isFile(meta),
    hasSkill: isFile(skill),
    target,
    source,
    upToDate,
    /** 换指 junction 的提示：dsh-pack 切 profile 时可能整体换指 */
    note: '若 .agent-presets 是换指 junction，切换 profile 后可能丢失，重新 sync 即可恢复。',
  }
}
