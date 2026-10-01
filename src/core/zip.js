/**
 * 最小 ZIP 写入器（store 不压缩），零第三方依赖。
 *
 * 为什么不用 fflate：插件要跨机器安装，少一个 vendored 依赖就少一处版本/许可负担；
 * 而 .dsvault 里的主要体积是已经 zstd 压缩过的会话日志（再 deflate 收益近零），
 * 所以 store 法完全够用，且产物是标准 ZIP，7-Zip / 资源管理器 / unzip 都能打开。
 *
 * 已实现的安全与兼容要点：
 *   - 文件名统一 `/` 分隔；含非 ASCII 时置 UTF-8 标志位（bit 11）；
 *   - 记录 CRC32 与大小，解压工具会据此校验；
 *   - 拒绝目录穿越（`..`、绝对路径、盘符）与超过 4 GiB 的产物（ZIP64 未实现，明确报错而非静默出错）。
 */

import zlib from 'node:zlib'
import { assertSafeRelative } from './paths.js'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** 标准 CRC32（IEEE 多项式，ZIP 要求）。 */
export function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

const U32_MAX = 0xffffffff

/**
 * @typedef {object} ZipEntry
 * @property {string} name 归档内路径（`/` 分隔）
 * @property {Buffer|Uint8Array} data 文件内容
 */

/**
 * 打包成 ZIP。
 * @param {ZipEntry[]} entries
 * @param {{mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function zipSync(entries, opts = {}) {
  if (entries.length >= 65535) throw new Error('条目过多，未实现 ZIP64')
  const mtime = opts.mtime ?? new Date()
  const dosTime = toDosTime(mtime)
  const locals = []
  const centrals = []
  let offset = 0
  const seen = new Set()

  for (const entry of entries) {
    const name = assertSafeRelative(entry.name)
    if (seen.has(name)) throw new Error(`归档内路径重复：${name}`)
    seen.add(name)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const nameBuf = Buffer.from(name, 'utf8')
    const hasNonAscii = /[^\x00-\x7f]/.test(name)
    const flags = hasNonAscii ? 0x0800 : 0
    const crc = crc32(data)
    if (data.length > U32_MAX) throw new Error(`单文件超过 4 GiB，未实现 ZIP64：${name}`)
    if (offset > U32_MAX) throw new Error('归档超过 4 GiB，未实现 ZIP64')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // local file header 签名
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(0, 8) // method: store
    localHeader.writeUInt16LE(dosTime.time, 10)
    localHeader.writeUInt16LE(dosTime.date, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18) // compressed size
    localHeader.writeUInt32LE(data.length, 22) // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra length
    locals.push(localHeader, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory 签名
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10) // method: store
    central.writeUInt16LE(dosTime.time, 12)
    central.writeUInt16LE(dosTime.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, nameBuf)

    offset += localHeader.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // central dir start disk
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, centralBuf, end])
}

function toDosTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 读取 ZIP 的中央目录条目（只读校验用，不做解压）。
 * 用于 `pack/view` 这类“先看包里有什么再装”的场景。
 *
 * @param {Buffer} buf
 * @returns {Array<{name:string,size:number,crc:number,offset:number}>}
 */
export function listZip(buf) {
  let eocdIdx = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocdIdx = i; break }
  }
  if (eocdIdx < 0) throw new Error('不是有效的 ZIP：找不到中央目录结尾记录')
  if (buf.readUInt16LE(eocdIdx + 4) || buf.readUInt16LE(eocdIdx + 6)) throw new Error('不支持分卷 ZIP')
  const count = buf.readUInt16LE(eocdIdx + 10)
  let cursor = buf.readUInt32LE(eocdIdx + 16)
  const centralEnd = cursor + buf.readUInt32LE(eocdIdx + 12)
  if (count === 65535 || cursor === U32_MAX || centralEnd > eocdIdx) throw new Error('不支持 ZIP64 或中央目录损坏')
  const out = []
  const seen = new Set()
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > centralEnd) throw new Error('ZIP 中央目录被截断')
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`中央目录第 ${i} 项签名错误`)
    const flags = buf.readUInt16LE(cursor + 8)
    const size = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const nameBuf = buf.subarray(cursor + 46, cursor + 46 + nameLen)
    const name = nameBuf.toString('utf8')
    if (name.includes('\uFFFD')) throw new Error('ZIP 文件名不是 UTF-8，请将压缩包另存为 UTF-8 ZIP')
    const normalized = assertSafeRelative(name.replace(/[/\\]+$/, ''))
    if (seen.has(normalized.toLowerCase())) throw new Error(`归档内路径重复：${name}`)
    seen.add(normalized.toLowerCase())
    const attributes = buf.readUInt32LE(cursor + 38)
    if (((attributes >>> 16) & 0xf000) === 0xa000) throw new Error(`拒绝 ZIP 符号链接：${name}`)
    if (flags & 1) throw new Error('不支持加密 ZIP')
    const method = buf.readUInt16LE(cursor + 10)
    if (method !== 0 && method !== 8) throw new Error(`不支持 ZIP 压缩方法：${method}`)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    if (size === U32_MAX || compressedSize === U32_MAX) throw new Error('不支持 ZIP64')
    out.push({ name, size, compressedSize, method, flags, directory: /[/\\]$/.test(name), crc: buf.readUInt32LE(cursor + 16), offset: localOffset })
    cursor += 46 + nameLen + extraLen + commentLen
    if (cursor > centralEnd) throw new Error('ZIP 中央目录被截断')
  }
  return out
}

/** 从 ZIP 中取出一个条目（store 法，因此可直接按偏移切片）。 */
export function readZipEntry(buf, name, index) {
  const entry = (index ?? listZip(buf)).find((e) => e.name === name)
  if (!entry) throw new Error(`归档中不存在：${name}`)
  const off = entry.offset
  if (off + 30 > buf.length) throw new Error(`本地文件头被截断：${name}`)
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error(`本地文件头签名错误：${name}`)
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  if (start + entry.compressedSize > buf.length) throw new Error(`ZIP 条目被截断：${name}`)
  const compressed = buf.subarray(start, start + entry.compressedSize)
  if (entry.size > 512 * 1024 * 1024) throw new Error(`ZIP 单文件超过 512 MiB：${name}`)
  const data = entry.method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) }) : compressed
  if (data.length !== entry.size) throw new Error(`ZIP 条目长度不匹配：${name}`)
  const actual = crc32(data)
  if (actual !== entry.crc) throw new Error(`CRC32 校验失败：${name}`)
  return data
}
