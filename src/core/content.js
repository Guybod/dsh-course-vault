/**
 * 课程内容段的文件操作：把一个课程文件夹收进 `.dsvault`，以及安全地解回来。
 *
 * 为什么需要它：会话记录只解决「模型记得上次聊过什么」，而换电脑真正要搬的是
 * **整门课**——大纲、讲义、你手搓的代码、测验、学习档案。这些都远小于会话日志
 * （实测一门课 146 文件 / 0.91 MB），所以「一键完整包」是现实的。
 *
 * 安全与正确性要点：
 *   - 打包时排除版本库、依赖目录、Python 虚拟环境和存档目录本身；
 *   - 解包时逐文件比 sha256，区分「新增 / 相同 / 冲突」，**默认绝不覆盖冲突文件**；
 *   - 所有归档内路径都过 `assertSafeRelative`，拒绝 `..`、绝对路径、盘符。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'

import { walkFiles, writeFileAtomic, sha256, isFile } from './fsx.js'
import { assertSafeRelative } from './paths.js'

/** 打包内容时永远跳过的目录名（任意层级）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsvault', 'sessions', '.venv', 'venv', '__pycache__', '.pytest_cache'])

/**
 * 收集课程文件夹下应入包的文件。
 *
 * `skipSiblings` 用于排除输出目录（例如 `<课程>/sessions`），
 * 否则导出包会被写进正在打包的目录里，形成自我嵌套。
 *
 * @param {string} root 课程文件夹
 * @param {{skipSiblings?: string[], skipDirs?: Set<string>}} [opts]
 * @returns {Promise<Array<{rel:string, abs:string, size:number}>>}
 */
export async function collectContentFiles(root, opts = {}) {
  const skipDirs = new Set([...(opts.skipDirs ?? SKIP_DIRS)].map((name) => name.toLowerCase()))
  const skipRoots = (opts.skipSiblings ?? []).map((p) => path.resolve(p).toLowerCase())
  const isSkippedRoot = (abs) => {
    const resolved = path.resolve(abs).toLowerCase()
    return skipRoots.some((s) => resolved === s || resolved.startsWith(s + path.sep))
  }
  const all = await walkFiles(root, [], { skipDirectory: (abs, name) => skipDirs.has(name.toLowerCase()) || isSkippedRoot(abs) })
  const out = []
  for (const abs of all) {
    const rel = path.relative(root, abs)
    const parts = rel.split(path.sep)
    if (parts.some((seg) => skipDirs.has(seg.toLowerCase())) || isSkippedRoot(abs)) continue
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      continue
    }
    out.push({ rel: assertSafeRelative(rel), abs, size: stat.size })
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

/**
 * 把内容文件读成归档条目，并产出带 sha256 的清单。
 * @param {string} root
 * @param {Array<{rel:string,abs:string,size:number}>} files
 * @returns {Promise<{entries:Array<{name:string,data:Buffer}>, records:Array<object>, bytes:number}>}
 */
export async function readContentEntries(root, files) {
  const entries = []
  const records = []
  let bytes = 0
  for (const f of files) {
    let data
    try {
      data = await fsp.readFile(f.abs)
    } catch {
      throw new Error(`课程文件读取失败，未生成迁移包：${f.rel}`)
    }
    const name = `.dsvault/content/${f.rel}`
    entries.push({ name, data })
    records.push({
      path: f.rel,
      file: name,
      bytes: data.length,
      sha256: sha256(data),
    })
    bytes += data.length
  }
  return { entries, records, bytes }
}

/**
 * 规划内容导入：逐文件比 sha256，分出新增 / 相同 / 冲突。
 *
 * @param {string} contentRoot 目标课程文件夹
 * @param {Array<{path:string,file:string,sha256:string,bytes:number}>} records manifest 里的内容清单
 * @param {(file:string)=>Buffer|undefined} readEntry 从归档取文件字节
 * @returns {Promise<{create:Array, same:Array, conflict:Array}>}
 */
export async function planContentImport(contentRoot, records, readEntry) {
  const create = []
  const same = []
  const conflict = []
  const seen = new Set()
  for (const record of records ?? []) {
    const rel = assertSafeRelative(record.path)
    if (seen.has(rel.toLowerCase())) throw new Error(`课程内容目标重复：${rel}`)
    seen.add(rel.toLowerCase())
    const target = path.join(contentRoot, rel)
    let existing = null
    if (isFile(target)) {
      try {
        existing = sha256(await fsp.readFile(target))
      } catch {
        existing = null
      }
    }
    const data = readEntry(record.file)
    if (data === undefined) throw new Error(`课程包缺少文件：${record.file}`)
    if (typeof record.sha256 !== 'string' || sha256(data) !== record.sha256) throw new Error(`课程文件 sha256 校验失败：${rel}`)
    await assertNoSymlinkTarget(target)
    if (existing === null) {
      create.push({ path: rel, target, bytes: data.length, data })
    } else if (existing === record.sha256) {
      same.push({ path: rel, target })
    } else {
      conflict.push({
        path: rel,
        target,
        bytes: data.length,
        data,
        existingSha256: existing,
        incomingSha256: record.sha256,
      })
    }
  }
  return { create, same, conflict }
}

/** 导入前检查现存的所有祖先，防止通过目录链接写到课程之外。 */
async function assertNoSymlinkTarget(target) {
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    try { if ((await fsp.lstat(p)).isSymbolicLink()) throw new Error(`导入目标含符号链接：${p}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (p === path.dirname(p)) break
  }
}

/**
 * 落盘内容导入结果。
 *
 * @param {{create:Array, conflict:Array}} plan
 * @param {{replace?:boolean, onProgress?:(stage:string,detail:string)=>void}} [opts]
 * @returns {Promise<{written:string[], skipped:string[]}>}
 */
export async function applyContentImport(plan, opts = {}) {
  const written = []
  const skipped = []
  for (const item of plan.create ?? []) {
    await assertNoSymlinkTarget(item.target)
    await writeFileAtomic(item.target, item.data)
    written.push(item.path)
    opts.onProgress?.('content', `新增 ${item.path}`)
  }
  for (const item of plan.conflict ?? []) {
    if (opts.replace !== true) {
      skipped.push(item.path)
      opts.onProgress?.('content', `冲突跳过 ${item.path}`)
      continue
    }
    await assertNoSymlinkTarget(item.target)
    const original = await fsp.readFile(item.target)
    await writeFileAtomic(`${item.target}.bak-${Date.now()}`, original)
    await writeFileAtomic(item.target, item.data)
    written.push(item.path)
    opts.onProgress?.('content', `覆盖 ${item.path}`)
  }
  return { written, skipped }
}
