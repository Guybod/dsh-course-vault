/**
 * 跨平台文件系统小工具：原子写、递归列目录、sha256、大小人类可读化。
 *
 * 导入会话是“不能出错的写操作”，所以这里坚持两条：
 *   1. 先写临时文件再原子改名，绝不让目标文件停在半截状态；
 *   2. 覆盖已有文件前先备份（调用方决定备份位置）。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'

/** 递归列出目录下的文件（返回绝对路径），跳过符号链接目录。 */
export async function walkFiles(dir, out = []) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walkFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 目录是否存在（且确实是目录）。 */
export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 原子写：同目录临时文件 → rename；rename 覆盖是 POSIX/Windows 上的原子替换。 */
export async function writeFileAtomic(target, data) {
  const dir = path.dirname(target)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, target)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

export async function sha256File(p) {
  const buf = await fsp.readFile(p)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** 字节数变人类可读。 */
export function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** 时间戳（毫秒）→ `YYYY-MM-DD HH:mm` 本地时间，用于 manifest 可读性。 */
export function fmtTime(ms) {
  const d = new Date(ms)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 文件名安全化：把 Windows/POSIX 非法字符换成 `-`。 */
export function safeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim() || 'untitled'
}
