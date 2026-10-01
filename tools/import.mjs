#!/usr/bin/env node
/**
 * 一键导入课程包（.dsvault）：课程内容 + 会话记录，支持跨机路径映射。
 *
 * 用法：
 *   node tools/import.mjs <包.dsvault>                          # 只看差异（不写盘）
 *   node tools/import.mjs <包.dsvault> --apply                  # 真正导入
 *   node tools/import.mjs <包.dsvault> --apply --replace        # 冲突内容也覆盖
 *   node tools/import.mjs <包.dsvault> --to D:\code\我的课程     # 指定课程内容落点
 *   node tools/import.mjs <包.dsvault> --sessions-only --apply   # 只导会话
 *
 * 两条默认安全线（都可以显式关掉，但默认必须安全）：
 *   1. 不带 --apply 就只做 dry-run，一个字节都不写；
 *   2. 内容冲突（本机改过）默认**不覆盖**，只列出来，要覆盖得加 --replace。
 *   会话永远不覆盖本机已有的同 id 会话（要覆盖得加 --replace）。
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { importFullVault } = await import(
  `file://${path.resolve(here, '..', 'src', 'core', 'import.js').replace(/\\/g, '/')}`
)

function parseArgs(argv) {
  const out = { vault: null, apply: false, replace: false, to: undefined, target: undefined, sessionsOnly: false, contentOnly: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--replace') out.replace = true
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--target') out.target = argv[++i]
    else if (a === '--sessions-only') out.sessionsOnly = true
    else if (a === '--content-only') out.contentOnly = true
    else if (!a.startsWith('--')) out.vault = a
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.vault) {
  console.error('用法: node tools/import.mjs <包.dsvault> [--apply] [--replace] [--to 课程文件夹] [--target 工作区]')
  process.exit(2)
}

const vaultPath = path.resolve(args.vault)
if (!fs.existsSync(vaultPath)) {
  console.error(`包不存在：${vaultPath}`)
  process.exit(2)
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 课程内容落点：默认取包里的 sourceContentRoot / sourceWorkspace
const contentTarget = args.to ? path.resolve(args.to) : undefined
const targetCwd = args.target ? path.resolve(args.target) : contentTarget

console.log(`包         : ${vaultPath}`)
console.log(`DSH_HOME   : ${dshHome}`)
console.log(`内容落点   : ${contentTarget ?? '（用包内记录）'}`)
console.log(`会话映射到 : ${targetCwd ?? '（用包内记录）'}`)
console.log(`模式       : ${args.apply ? '★ 写入' : 'dry-run（只看差异）'}${args.replace ? ' + 允许覆盖' : ''}`)
console.log('')

const result = await importFullVault({
  vaultPath,
  dshHome,
  contentTarget,
  targetCwd,
  apply: args.apply,
  replace: args.replace,
  sessionsOnly: args.sessionsOnly,
  contentOnly: args.contentOnly,
  onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
})

console.log('\n=== 结果 ===')
console.log(`包类型     : ${result.kind}`)
console.log(`源工作区   : ${result.sourceWorkspace}`)

if (result.sessions) {
  const s = result.sessions.summary
  console.log(`\n【会话】共 ${s.total} 条`)
  console.log(`  新建 ${s.create} | 覆盖 ${s.replace} | 跳过 ${s.skip} | 需改路径 ${s.rewrites}`)
  if (!args.apply) {
    console.log('  dry-run：以上都还没写。加 --apply 才落盘。')
  } else {
    for (const w of result.sessions.written) {
      console.log(`  ✓ ${w.headerRewritten ? '[已改路径] ' : ''}${w.id}`)
      console.log(`     → ${w.path}`)
    }
    for (const b of result.sessions.backups) console.log(`  备份：${b.path}`)
    for (const sk of result.sessions.skipped) console.log(`  跳过：${sk.id}（${sk.reason}）`)
  }
}

if (result.content) {
  const c = result.content.summary
  console.log(`\n【课程内容】共 ${c.create + c.same + c.conflict} 个文件`)
  console.log(`  新增 ${c.create} | 相同 ${c.same} | 冲突 ${c.conflict}`)
  if (c.conflict > 0) {
    console.log(`  ⚠️ 有 ${c.conflict} 个文件本机改过、包里也有一份 —— 默认不覆盖。`)
    console.log('     要覆盖请加 --replace（建议先用 git 提交一次，好回退）。')
  }
  if (args.apply) {
    console.log(`  已写入 ${result.content.written.length} 个`)
    if (result.content.skipped.length) console.log(`  保留本机版本 ${result.content.skipped.length} 个：${result.content.skipped.slice(0, 10).join(', ')}${result.content.skipped.length > 10 ? ' …' : ''}`)
  } else {
    console.log('  dry-run：以上都还没写。加 --apply 才落盘。')
  }
}

if (!args.apply) {
  console.log('\n确认无误后执行：')
  console.log(`  node tools/import.mjs "${args.vault}"${contentTarget ? ` --to "${contentTarget}"` : ''} --apply`)
}
