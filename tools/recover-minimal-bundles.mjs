#!/usr/bin/env node
/**
 * 应急恢复：把 profile 的 bundles 收敛到"最小可启动"组合。
 *
 * 什么时候用：DSH 启动不起来（或起来后插件全没了）。DSH 在启动失败时会自愈——
 * 把激活失败的 bundle 从 profile 里剔掉；但如果剔得不干净或残留了坏行，
 * 下一次启动会继续失败。这个脚本把 bundles 强制写回只有 base + web-app 的组合，
 * 那两个是桌面端一定能解析的。
 *
 * 它**只动 bundles 列表**，不碰依赖、不碰 node_modules、不碰你的 patch 层。
 *
 * 用法：
 *   node tools/recover-minimal-bundles.mjs            # 默认修 profiles/default
 *   node tools/recover-minimal-bundles.mjs desktop    # 指定 profile 名
 *   node tools/recover-minimal-bundles.mjs desktop --dry
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profileName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'default'
const dry = process.argv.includes('--dry')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)
const manifest = path.join(profileDir, 'package.json')

const MINIMAL = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

if (!fs.existsSync(manifest)) {
  console.error(`找不到 profile 清单：${manifest}`)
  process.exit(2)
}

let pkg
try {
  pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
} catch (err) {
  console.error(`清单不是合法 JSON，无法自动修：${err.message}`)
  console.error('手动把它改成下面这样即可（保留 dependencies，只改 bundles）：')
  console.error(JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: MINIMAL } } }, null, 2))
  process.exit(2)
}

const before = pkg?.dsh?.profile?.bundles
console.log(`profile : ${profileDir}`)
console.log(`清单    : ${manifest}`)
console.log(`当前 bundles（${Array.isArray(before) ? before.length : '缺失'}）:`)
for (const b of Array.isArray(before) ? before : []) console.log('  -', b)

// 备份只在**真要写**的时候做——dry-run 不该产生任何文件
let backup = null
if (!dry) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  backup = path.join(profileDir, `package.json.bak-recover-${stamp}`)
  fs.copyFileSync(manifest, backup)
  console.log(`\n已备份原清单 → ${backup}`)
}

pkg.name = pkg.name || `dsh-profile-${profileName}`
pkg.private = true
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = { ...(pkg.dsh.profile || {}), bundles: MINIMAL }

if (dry) {
  console.log('\n--dry：未写入任何文件。将写成的 bundles：')
  for (const b of MINIMAL) console.log('  -', b)
  process.exit(0)
}

fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('\n已写入最小 bundles：')
for (const b of MINIMAL) console.log('  -', b)
console.log('\n现在重启 DSH。起来之后到「插件」面板把你需要的插件重新启用。')
