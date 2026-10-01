#!/usr/bin/env node
/**
 * 一键导出课程包（.dsvault）：课程内容 + 该工作区的会话记录。
 *
 * 用法：
 *   node tools/export.mjs <课程文件夹>                    # 完整包，落到 <课程>/sessions/
 *   node tools/export.mjs <课程文件夹> --sessions-only    # 只导会话
 *   node tools/export.mjs <课程文件夹> --all              # 忽略账本，全量重导
 *   node tools/export.mjs <课程文件夹> --name 我的包.dsvault
 *
 * 为什么不走插件的 RPC 通道：那条通道挂了与 /api 同策略的鉴权栅栏，
 * 命令行/脚本过不去；而引擎本身是纯 Node 模块，直接调用最省事。
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { exportWorkspaceSessions, inspectVault, listVaults } = await import(
  `file://${path.resolve(here, '..', 'src', 'core', 'export.js').replace(/\\/g, '/')}`
)

function parseArgs(argv) {
  const out = { courseDir: null, sessionsOnly: false, all: false, name: undefined, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sessions-only') out.sessionsOnly = true
    else if (a === '--all') out.all = true
    else if (a === '--name') out.name = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (!a.startsWith('--')) out.courseDir = a
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.courseDir) {
  console.error('用法: node tools/export.mjs <课程文件夹> [--sessions-only] [--all] [--name X.dsvault] [--out 目录]')
  process.exit(2)
}

const courseDir = path.resolve(args.courseDir)
if (!fs.existsSync(courseDir)) {
  console.error(`课程文件夹不存在：${courseDir}`)
  process.exit(2)
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const sessionsDir = args.out ? path.resolve(args.out) : path.join(courseDir, 'sessions')

console.log(`课程文件夹 : ${courseDir}`)
console.log(`DSH_HOME   : ${dshHome}`)
console.log(`输出目录   : ${sessionsDir}`)
console.log(`模式       : ${args.sessionsOnly ? '仅会话' : '完整包（课程内容 + 会话）'}`)
console.log('')

const result = await exportWorkspaceSessions({
  dshHome,
  workspace: courseDir,
  contentRoot: args.sessionsOnly ? null : courseDir,
  sessionsDir,
  all: args.all,
  name: args.name,
  onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
})

if (result.skipped) {
  console.log('\n没有新内容需要导出（账本里已记录）。要强制全量请加 --all。')
  process.exit(0)
}

console.log('\n=== 导出完成 ===')
console.log(`包         : ${result.output}`)
console.log(`大小       : ${(result.bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`sha256     : ${result.sha256}`)
console.log(`会话数     : ${result.sessions}`)

const inspected = await inspectVault(result.output)
const badContent = inspected.contentChecks.filter((c) => !c.ok)
const badSessions = inspected.checks.filter((c) => !c.ok)
console.log(`内容文件   : ${inspected.manifest.content?.length ?? 0} 个（sha256 失败 ${badContent.length}）`)
console.log(`会话文件   : ${inspected.checks.length} 个（sha256 失败 ${badSessions.length}）`)
for (const b of [...badContent, ...badSessions]) console.log(`  ✗ ${b.path ?? b.id}: ${b.reason}`)

const vaults = await listVaults(sessionsDir)
console.log(`\n${sessionsDir} 下现有 ${vaults.length} 个包:`)
for (const v of vaults) console.log(`  - ${v.name}  ${(v.bytes / 1024 / 1024).toFixed(2)} MB`)
