/**
 * 把 profile 的 patch 层恢复成备份内容（原子替换）。
 *
 * 为什么需要它：修 profile 的 bundles 时，这个用户 patch 被重写过，丢了这些行：
 *   - ui-settings-general（欢迎页版本）
 *   - ui-settings.enabled: true → 被改成 false（设置/模式相关 UI 会被停用）
 *   - agent-default-model（用户选的 provider/model/reasoningEffort 整行丢失）
 * 以及若干值被降级（usage detailed→compact、developerTools true→false、completion api-key→skipped）。
 *
 * **本脚本只做恢复，不做任何"我觉得需要"的加法**——加了什么都不确定，
 * 而多一行可能与 bundle 里的同名行撞车。要加课程模式相关的声明，改插件的补丁，
 * 那里是可版本管理、可回滚的地方。
 *
 * 用法：
 *   node tools/fix-profile-patch.mjs --dry     # 只看差异，不写
 *   node tools/fix-profile-patch.mjs           # 恢复（先备份当前内容）
 */

import fs from 'node:fs'
import path from 'node:path'

const profileName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'default'
const dry = process.argv.includes('--dry')
const profileDir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh'), 'profiles', profileName)
const target = path.join(profileDir, 'cordis.patch.yml')

if (!fs.existsSync(target)) {
  console.error('找不到 patch 文件：' + target)
  process.exit(2)
}

// 找最新的 .bak-* 备份
const backups = fs
  .readdirSync(profileDir)
  .filter((n) => n.startsWith('cordis.patch.yml.bak-'))
  .map((n) => ({ n, p: path.join(profileDir, n), t: fs.statSync(path.join(profileDir, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t)

if (backups.length === 0) {
  console.error('没有 cordis.patch.yml.bak-* 备份，无法恢复。')
  console.error('可手动按 README「出事了怎么办」里的说明重建。')
  process.exit(2)
}

const src = backups[0]
const current = fs.readFileSync(target, 'utf8')
const restored = fs.readFileSync(src.p, 'utf8')

console.log(`profile  : ${profileDir}`)
console.log(`当前 patch: ${target}`)
console.log(`恢复自   : ${src.n}（${new Date(src.t).toLocaleString('zh-CN')}）`)

const curLines = current.split('\n')
const newLines = restored.split('\n')
console.log(`\n行数：当前 ${curLines.length} → 恢复后 ${newLines.length}`)

// 逐行差异（只打印 id 行，便于看谁丢了）
const idsOf = (lines) => lines.filter((l) => /^\s*-?\s*id:\s/.test(l)).map((l) => l.trim())
const curIds = idsOf(curLines)
const newIds = idsOf(newLines)
const lost = newIds.filter((x) => !curIds.includes(x))
const extra = curIds.filter((x) => !newIds.includes(x))
console.log('\n当前 patch 缺少的行：')
for (const l of lost) console.log('  + ' + l)
console.log('\n当前 patch 多出的行（恢复后会消失）：')
for (const l of extra) console.log('  - ' + l)

if (dry) {
  console.log('\n--dry：未写入任何文件。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const keep = path.join(profileDir, `cordis.patch.yml.before-restore-${stamp}`)
fs.copyFileSync(target, keep)
const tmp = target + '.tmp-restore'
fs.writeFileSync(tmp, restored, 'utf8')
fs.renameSync(tmp, target)

console.log(`\n已备份当前内容 → ${path.basename(keep)}`)
console.log('已恢复。重启 DSH 生效。')
