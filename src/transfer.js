import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

export function makeTransfers(getHome) {
  const downloads = new Map()
  return {
    async upload(req, originalName) {
      if (!/\.(zip|dsvault)$/i.test(originalName)) throw new Error('请选择 .zip 课程资料或 .dsvault 迁移包')
      const dir = path.join(getHome(), 'course-vault', 'uploads')
      await fsp.mkdir(dir, { recursive: true })
      // 清理上次启动留下的临时上传文件，仅限本插件的 UUID 命名文件。
      for (const name of await fsp.readdir(dir)) if (/^[a-f0-9-]{36}\.(zip|dsvault)$/.test(name)) {
        const file = path.join(dir, name)
        if (Date.now() - (await fsp.stat(file)).mtimeMs > 24 * 3600 * 1000) await fsp.unlink(file)
      }
      const sourcePath = path.join(dir, randomUUID() + path.extname(originalName).toLowerCase())
      let size = 0
      const limit = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length
        callback(size > 512 * 1024 * 1024 ? new Error('课程包超过 512 MiB') : null, chunk)
      } })
      try { await pipeline(req, limit, fs.createWriteStream(sourcePath, { flags: 'wx' })) }
      catch (e) { await fsp.unlink(sourcePath).catch(() => {}); throw e }
      return { sourcePath, originalName, bytes: size }
    },
    downloadLink(file, name) {
      const token = randomUUID()
      const now = Date.now()
      for (const [key, item] of downloads) if (item.expires < now) downloads.delete(key)
      downloads.set(token, { file, name, expires: now + 3600 * 1000 })
      return `/dsh-course/download/${token}`
    },
    async download(token, res) {
      const item = downloads.get(token)
      if (!item || item.expires < Date.now()) { res.writeHead(404); res.end('下载已过期，请重新导出'); return }
      const stat = await fsp.stat(item.file)
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': stat.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`, 'cache-control': 'no-store' })
      await pipeline(fs.createReadStream(item.file), res)
    },
  }
}
