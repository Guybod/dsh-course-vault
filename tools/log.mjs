#!/usr/bin/env node
/**
 * 插件日志维护：查看 / 归档 / 清空 `<DSH_HOME>/logs/dsh-course-vault.log`。
 *
 * 为什么需要它：排查启动问题时，日志里混着历史（包括我自己演练写进去的记录）会误导判断。
 * 每次要观察"下一次启动到底发生了什么"之前，先清空或归档，结论才干净。
 *
 * 用法：
 *   node tools/log.mjs            # 看最后 40 行 + 统计
 *   node tools/log.mjs --archive  # 归档（改名带时间戳）后留空
 *   node tools/log.mjs --clear    # 直接删除
 *   node tools/log.mjs --app      # 只看真机记录（[app] / [module] / [boot]，排除 [DRILL]）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const file = path.join(dshHome, 'logs', 'dsh-course-vault.log')
const mode = process.argv.includes('--archive')
  ? 'archive'
  : process.argv.includes('--clear')
    ? 'clear'
    : process.argv.includes('--app')
      ? 'app'
      : 'show'

if (mode === 'clear') {
  if (fs.existsSync(file)) {
    fs.rmSync(file)
    console.log('已删除：' + file)
  } else {
    console.log('日志不存在，无需删除。')
  }
  process.exit(0)
}

if (mode === 'archive') {
  if (!fs.existsSync(file)) {
    console.log('日志不存在，无需归档。')
    process.exit(0)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = `${file}.${stamp}`
  fs.renameSync(file, to)
  console.log('已归档 → ' + to)
  console.log('新日志会在下次插件加载时创建。')
  process.exit(0)
}

if (!fs.existsSync(file)) {
  console.log('日志不存在：' + file)
  console.log('说明插件代码还没有跑过（模块未被加载）。')
  process.exit(0)
}

const all = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
const drills = all.filter((l) => l.includes('[DRILL]'))
// 判定真机/演练只看标记，不做二次过滤——否则演练行会同时被两边算漏
const modules = all.filter((l) => l.includes('[module]'))
const boots = all.filter((l) => l.includes('[boot] boot '))

console.log('日志文件 : ' + file)
console.log(`总行数   : ${all.length}（演练 ${drills.length} / 真机 ${all.length - drills.length}）`)
console.log(`模块加载记录 : ${modules.length} 条（真机 ${modules.filter((l) => !l.includes('[DRILL]')).length}）`)
console.log(`apply 启动记录: ${boots.length} 条（真机 ${boots.filter((l) => !l.includes('[DRILL]')).length}）`)

const appModules = modules.filter((l) => !l.includes('[DRILL]'))
const appBoots = boots.filter((l) => !l.includes('[DRILL]'))
if (drills.length === all.length) {
  console.log('\n★ 日志里只有演练记录（我本地测试写的）—— 还没有真机启动过。')
} else if (appModules.length === 0) {
  console.log('\n★ 没有任何真机「模块已加载」记录 → 插件模块从未被加载（失败在更早：loader / package 声明）。')
} else if (appBoots.length === 0) {
  console.log('\n★ 模块加载过、但没有进入 apply() → 激活阶段失败。')
} else {
  console.log('\n插件被正常加载并进入了 apply()。')
}

const show = mode === 'app' ? all.filter((l) => !l.includes('[DRILL]')) : all
console.log(`\n--- 最后 ${Math.min(40, show.length)} 行 ---`)
for (const l of show.slice(-40)) console.log(l)
