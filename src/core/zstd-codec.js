/**
 * DSH 会话日志的物理编码层（zstd 多 frame 拼接容器）。
 *
 * 为什么必须自己实现：DSH 把每个持久化批次写成一个**独立、带 checksum 的 zstd frame**，
 * 依次拼接在同一个文件里。Node 内置 zstd 解不开这种拼接容器：
 *   - `zstdDecompressSync` 只解第一个 frame（425KB 的文件只解出 header 一行）；
 *   - `createZstdDecompress` 流式 API 直接报 `ZSTD_error_prefix_unknown`。
 * 所以必须按 frame 魔数切分，再逐 frame 解压。
 *
 * 压缩端同样要对齐 DSH 的 `CHECKSUM_OPTIONS`（`ZSTD_c_checksumFlag: 1`），
 * 否则新 frame 不带 checksum，与既有日志风格不一致。
 *
 * 本模块只依赖 `node:zlib`，不读写文件，便于单独测试。
 */

import zlib from 'node:zlib'

const { constants } = zlib

/** zstd frame 起始魔数（小端读取 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** DSH 写日志时使用的压缩参数：单 frame 带内容校验和。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 按 Zstandard header 与 block 长度切分，避免压缩内容中的魔数造成误切。
 *
 * @param {Buffer} buffer 整个文件字节
 * @returns {{frames: Array<{start:number,end:number}>, headerBytesBefore: number}}
 */
export function scanFrames(buffer, { firstOnly = false } = {}) {
  const frames = []
  let offset = 0
  const need = (bytes) => { if (offset + bytes > buffer.length) throw new Error('会话日志含未写完的 Zstandard frame，请等待当前回复结束后再导出') }
  while (offset < buffer.length) {
    const start = offset
    need(5)
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`非法 Zstandard frame：${offset}`)
    const descriptor = buffer[offset + 4]
    if (descriptor & 24) throw new Error('非法 Zstandard frame header')
    offset += 5
    const single = !!(descriptor & 32), flag = descriptor >>> 6, dictionary = descriptor & 3
    const headerBytes = (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag === 0 ? single ? 1 : 0 : 1 << flag)
    need(headerBytes); offset += headerBytes
    for (;;) {
      need(3)
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const kind = (header >>> 1) & 3
      if (kind === 3) throw new Error('非法 Zstandard block 类型')
      const size = kind === 1 ? 1 : header >>> 3
      need(size); offset += size
      if (header & 1) break
    }
    if (descriptor & 4) { need(4); offset += 4 }
    frames.push({ start, end: offset })
    if (firstOnly) break
  }
  return { frames, headerBytesBefore: 0 }
}

/** 解一个完整 frame；失败时抛错（相当于 DSH 的 checksum 校验失败）。 */
export function decodeFrame(frame) {
  return zlib.zstdDecompressSync(frame)
}

/**
 * 读取 header frame 的内容。
 *
 * DSH 后端要求“第一个 frame 恰好是一行 header 记录”（`assertZstdHeaderFrame`），
 * 这里对齐同一条不变量：解析结果必须只有一行有效记录。
 *
 * @param {Buffer} buffer 整个文件字节
 * @returns {{header: object, frameCount: number, frameRanges: Array<{start:number,end:number}>}}
 */
export function readHeader(buffer) {
  const { frames, headerBytesBefore } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('不是有效的 zstd 会话日志：找不到任何 frame')
  if (headerBytesBefore !== 0) throw new Error('不是有效的 zstd 会话日志：文件开头有非 frame 字节')
  const plaintext = decodeFrame(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (plaintext.length === 0 || plaintext.indexOf('\n') !== plaintext.length - 1) {
    throw new Error('会话 header frame 不是恰好一行记录')
  }
  const header = JSON.parse(plaintext)
  if (header?.type !== 'session' || typeof header.id !== 'string') {
    throw new Error('会话 header 缺少 type:"session" 或 id')
  }
  return { header, frameCount: frames.length, frameRanges: frames }
}

/**
 * 只从磁盘读第一个 frame，解出 header。
 *
 * 会话日志动辄几百 KB 到几 MB，而列目录时只需要 header 里的 `id` / `cwd` / `agentPreset`。
 * 因此先读固定大小的开头，切出第一个 frame 的字节区间再精确读取，避免整体载入内存。
 *
 * @param {string} file 会话文件绝对路径
 * @param {import('node:fs/promises')} fsp
 * @returns {Promise<object|null>} 解析失败返回 null（由调用方决定记 warning 还是跳过）
 */
export async function readHeaderFromFile(file, fsp) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const size = (await handle.stat()).size
    if (size === 0) return null
    let probeSize = Math.min(1 << 16, size)
    let first, probe
    for (;;) {
      probe = Buffer.alloc(probeSize)
      const { bytesRead } = await handle.read(probe, 0, probeSize, 0)
      try { first = scanFrames(probe.subarray(0, bytesRead), { firstOnly: true }).frames[0]; break }
      catch (error) {
        if (probeSize === size) throw error
        probeSize = Math.min(probeSize * 2, size)
      }
    }
    if (!first) return null
    const plaintext = decodeFrame(probe.subarray(first.start, first.end)).toString('utf8')
    if (plaintext.length === 0 || plaintext.indexOf('\n') !== plaintext.length - 1) return null
    const header = JSON.parse(plaintext)
    return header?.type === 'session' && typeof header.id === 'string' ? header : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 只替换 header frame，其余 frame **按原字节原样保留**。
 *
 * 这是跨机路径映射能做到无损的原因：header 是独立 frame，事件 frame 里不含路径，
 * 因此改 cwd 只需重压第一个 frame，不需要“全解全压”（后者会碰到 DSH 的
 * `packChunkRuns` 打包行重编码，风险高得多）。
 *
 * @param {Buffer} buffer 原文件字节
 * @param {object} nextHeader 新的 header 对象
 * @returns {Buffer} 新的文件字节
 */
export function replaceHeader(buffer, nextHeader) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('不是有效的 zstd 会话日志：找不到任何 frame')
  const headerLine = JSON.stringify(nextHeader) + '\n'
  const head = zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'), CHECKSUM_OPTIONS)
  const rest = frames.slice(1).map((f) => buffer.subarray(f.start, f.end))
  return Buffer.concat([head, ...rest])
}

/**
 * 校验一个会话文件：所有 frame 必须逐个解压成功，且第一个 frame 只有一行。
 * 用于导入前的自检，避免把坏包写进 $DSH_HOME。
 *
 * @param {Buffer} buffer
 * @returns {{frameCount:number, recordCount:number, header:object}}
 */
export function validateTranscript(buffer) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('不是有效的 zstd 会话日志：找不到任何 frame')
  let header = null
  let recordCount = 0
  for (let i = 0; i < frames.length; i += 1) {
    let text
    try {
      text = decodeFrame(buffer.subarray(frames[i].start, frames[i].end)).toString('utf8')
    } catch (err) {
      throw new Error(`第 ${i} 个 frame 解压失败（checksum 或数据损坏）：${err.message}`)
    }
    if (i === 0) {
      if (text.length === 0 || text.indexOf('\n') !== text.length - 1) {
        throw new Error('会话 header frame 不是恰好一行记录')
      }
      header = JSON.parse(text)
    }
    recordCount += text.split('\n').filter((l) => l.length > 0).length
  }
  return { frameCount: frames.length, recordCount, header }
}
