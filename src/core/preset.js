/**
 * 课程模式的形态判定与自检。
 *
 * 这里有一个**必须记住的版本差异**（我们踩过，浪费了好几轮）：
 *
 * | | DSH 0.1.x（旧 CLI） | DSH 0.2.x（桌面端二进制） |
 * |---|---|---|
 * | 包 | `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset-registry` |
 * | 形态 | preset = **目录**（`agent.cordis.yml` + `preset.yml`） | preset = **声明式行**，注册表**不扫目录** |
 * | 加模式 | 往 `$DSH_HOME/.agent-presets/<id>/` 放目录 | 在 profile 补丁里插一行 `@deepseek-ai/dsh-agent-preset` |
 *
 * 所以本插件同时提供两种形态：
 *   · **0.2.x 主形态**（插件仓库根的 `cordis.patch.yml`）：课程模式作为 preset 声明打进 bundle 补丁，
 *     这是桌面端唯一有效的做法；
 *   · **0.1.x 兼容形态**（`preset/course/` 目录）：给仍在用目录扫描版的部署用。
 *
 * 自检必须**如实报告当前宿主是哪种形态**，不能拿旧目录存在与否去判断——否则就是撒谎
 * （上一版就是如此：在 0.2.x 上报 installed: true，误导排查）。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { walkFiles, writeFileAtomic, isFile, isDir } from './fsx.js'

/** 本插件贡献的 preset id。 */
export const PRESET_ID = 'course'

/** 包根：`src/core` 往上两级。 */
function packageRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url)) // <包根>/src/core
  return path.resolve(here, '..', '..')
}

/** 0.1.x 兼容形态的源目录。 */
export function presetSourceDir() {
  return path.join(packageRoot(), 'preset', PRESET_ID)
}

/** 0.1.x 兼容形态的目标目录：`<DSH_HOME>/.agent-presets/course`。 */
export function presetTargetDir(dshHome) {
  return path.join(dshHome, '.agent-presets', PRESET_ID)
}

/** 0.2.x 主形态：插件自带的 profile 补丁。 */
export function patchPath() {
  return path.join(packageRoot(), 'cordis.patch.yml')
}

/** preset id 合法性（与 DSH 约定一致）。 */
export function isValidPresetId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 读补丁文本，判断它是否声明了课程模式（0.2.x 主形态）。
 * 只做文本标记检查——补丁本身由生成脚本保证结构合法。
 */
async function inspectPatch() {
  const file = patchPath()
  if (!isFile(file)) return { present: false, declaresCourse: false, path: file }
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    return { present: true, declaresCourse: false, path: file, error: err.message }
  }
  return {
    present: true,
    declaresCourse:
      text.includes('@deepseek-ai/dsh-agent-preset') && /config:\s*\n\s*id:\s*course\b/.test(text),
    path: file,
  }
}

/**
 * 自检：如实报告两种形态的状态 + roster 实际发现了哪些模式。
 *
 * @param {string} dshHome
 * @param {object} [ctx] 宿主 ctx（用于读 agentPresets / agentPresetRegistry 服务）
 */
export async function presetStatus(dshHome, ctx) {
  const patch = await inspectPatch()
  const legacyDir = presetTargetDir(dshHome)

  const legacy = {
    path: legacyDir,
    installed: isFile(path.join(legacyDir, 'agent.cordis.yml')) && isFile(path.join(legacyDir, 'preset.yml')),
    source: presetSourceDir(),
    /** 只有 0.1.x 会读它 */
    primary: false,
  }

  // roster 的答案（两代版本的服务名不同）
  let roster = null
  const service = ctx?.get?.('agentPresets') ?? ctx?.get?.('agentPresetRegistry')
  if (service && typeof service.list === 'function') {
    try {
      const list = await service.list()
      roster = {
        total: list.length,
        ids: list.map((p) => p.id),
        courseVisible: list.some((p) => p.id === PRESET_ID),
        broken: list.filter((p) => p.broken).map((p) => ({ id: p.id, reason: p.broken })),
      }
    } catch (err) {
      roster = { error: err?.message ?? String(err) }
    }
  }

  return {
    presetId: PRESET_ID,
    /** 0.2.x 主形态：桌面端靠它生效 */
    patch: { ...patch, primary: true },
    /** 0.1.x 兼容形态 */
    legacyDir: legacy,
    roster,
    effective: patch.present && patch.declaresCourse ? 'patch (DSH 0.2.x)' : legacy.installed ? 'directory (DSH 0.1.x)' : 'none',
    note: 'DSH 0.2.x 的 preset 注册表不扫描目录，只有 profile 补丁里的 preset 声明会生效。',
  }
}

/**
 * 0.1.x 兼容形态的同步：把 `preset/course/` 复制到 `<DSH_HOME>/.agent-presets/course/`。
 *
 * 对 0.2.x 是**空操作**（写进去也没人读），所以插件默认不调用它；
 * 保留仅供仍在用目录扫描版的部署手动使用。
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
  if (!sourceFiles.some((f) => path.basename(f) === 'agent.cordis.yml')) {
    return { ok: false, target, written: [], removed: [], skipped: 0, reason: '预设源缺少 agent.cordis.yml' }
  }

  const written = []
  let skipped = 0
  const wanted = new Set()
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

  const removed = []
  if (isDir(target)) {
    for (const abs of await walkFiles(target)) {
      const rel = toRel(abs, target)
      if (wanted.has(rel)) continue
      const resolved = path.resolve(abs)
      if (!resolved.startsWith(path.resolve(target) + path.sep)) continue
      await fsp.rm(abs, { force: true })
      removed.push(rel)
    }
  }

  return { ok: true, target, written, removed, skipped }
}
