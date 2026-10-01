// 在隔离目录使用已安装桌面端的同一套插件验证冷启动，不修改安装包或真实 DSH_HOME。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const archive = process.argv[2]
if (!archive) throw new Error('用法：node tools/prepare-desktop-smoke.mjs <resources/app.asar>')
const root = path.join(repo, '.dev')
const runtime = path.join(root, 'dsh')
const fd = fs.openSync(archive, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const json = Buffer.alloc(head.readUInt32LE(12))
  fs.readSync(fd, json, 0, json.length, 16)
  const index = JSON.parse(json)
  const dataStart = 8 + head.readUInt32LE(4)
  let count = 0
  function extract(node, rel = '') {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const next = rel ? rel + '/' + name : name
      if (entry.files) { extract(entry, next); continue }
      const target = path.join(runtime, next)
      if (fs.existsSync(target)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (entry.unpacked) fs.copyFileSync(path.join(archive + '.unpacked', 'dsh', next), target)
      else {
        const bytes = Buffer.alloc(Number(entry.size))
        fs.readSync(fd, bytes, 0, bytes.length, dataStart + Number(entry.offset))
        fs.writeFileSync(target, bytes)
      }
      count++
    }
  }
  extract(index.files.dsh)
  console.log(`隔离运行时已准备，新增 ${count} 个文件`)
} finally { fs.closeSync(fd) }
const profile = path.join(root, 'home', 'profiles', 'default')
await fsp.mkdir(profile, { recursive: true })
const link = async (target, dest) => { try { await fsp.symlink(target, dest, 'junction') } catch (e) { if (e.code !== 'EEXIST') throw e } }
await link(repo, path.join(runtime, 'node_modules', 'dsh-course-vault'))
await link(path.join(runtime, 'node_modules'), path.join(profile, 'node_modules'))
await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-course-smoke', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-course-vault'] } } }, null, 2))
await fsp.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
await fsp.writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n')
console.log(`DSH_HOME=${path.join(root, 'home')}`)
console.log(`CLI=${path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')}`)
