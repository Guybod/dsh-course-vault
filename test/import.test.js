import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { exportWorkspaceSessions } from '../src/core/export.js'
import { planImport, importVault, openVault } from '../src/core/import.js'
import { readHeader, validateTranscript } from '../src/core/zstd-codec.js'
import { sessionsForWorkspace, targetPaths } from '../src/core/session-store.js'
import { projectKey } from '../src/core/paths.js'

const REAL_HOME = path.join(os.homedir(), '.dsh')
const SRC_CWD = 'C:\\Users\\MLTZ\\Documents\\deepseek-harness\\default-workspace'
const DST_CWD = 'D:\\code\\LLM_VLA_Handwritten_Course'
const hasSessions = fs.existsSync(path.join(REAL_HOME, 'sessions'))

/** 造一个隔离的假 DSH_HOME，只含必要的 sessions 目录。 */
function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-home-'))
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  return home
}

/** 用真实会话先导出一个包，供导入测试使用。 */
async function makeRealVault(dir) {
  return exportWorkspaceSessions({
    dshHome: REAL_HOME,
    cwd: SRC_CWD,
    sessionsDir: dir,
    all: true,
    name: 'src.dsvault',
  })
}

test('导入到同一路径：识别为已存在并默认跳过，apply 也不覆盖', { skip: !hasSessions }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-imp1-'))
  const v = await makeRealVault(tmp)

  // 目标 home 就用真实 home（会话本来就在那里）
  const plan = await planImport({ vaultPath: v.output, dshHome: REAL_HOME, targetCwd: SRC_CWD })
  assert.equal(plan.summary.total, v.sessions)
  assert.equal(plan.summary.skip, v.sessions)
  assert.equal(plan.summary.create, 0)
  assert.equal(plan.rewriteNeeded, false)

  const res = await importVault({ vaultPath: v.output, dshHome: REAL_HOME, targetCwd: SRC_CWD, apply: true })
  assert.equal(res.applied, true)
  assert.equal(res.written.length, 0)
  assert.equal(res.skipped.length, v.sessions)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('导入到不同路径：重写 header.cwd 并落到 projectKey(新路径) 下', { skip: !hasSessions }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-imp2-'))
  const v = await makeRealVault(tmp)
  const home = makeFakeHome()

  // dry-run 必须先不动文件
  const plan = await planImport({ vaultPath: v.output, dshHome: home, targetCwd: DST_CWD })
  assert.equal(plan.rewriteNeeded, true)
  assert.equal(plan.summary.create, v.sessions)
  assert.equal(plan.summary.rewrites, v.sessions)
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).length, 0, 'dry-run 不能写任何东西')

  const res = await importVault({ vaultPath: v.output, dshHome: home, targetCwd: DST_CWD, apply: true })
  assert.equal(res.written.length, v.sessions)

  for (const w of res.written) {
    assert.ok(fs.existsSync(w.path), `落盘文件应存在：${w.path}`)
    assert.equal(w.headerRewritten, true)
    // 目录名必须等于 DSH 的算法
    assert.equal(path.basename(path.dirname(path.dirname(w.path))), projectKey(DST_CWD))
    // 文件内容必须是合法会话日志，且 cwd 已换成目标路径
    const buf = fs.readFileSync(w.path)
    const validated = validateTranscript(buf)
    assert.equal(validated.header.cwd, DST_CWD, 'header.cwd 必须已被重写')
    assert.equal(validated.header.id, w.id, 'id 必须保持不变')
    assert.equal(validated.header.delegationDepth >= 0, true)
    assert.ok(validated.header.agentPreset === undefined || typeof validated.header.agentPreset === 'string')
  }

  // 事件 frame 必须与源文件无损一致：对比记录数
  const src = await sessionsForWorkspace(REAL_HOME, SRC_CWD)
  const open = await openVault(v.output)
  for (const s of open.manifest.sessions) {
    const srcFile = src.find((x) => x.id === s.id)
    const srcCount = validateTranscript(fs.readFileSync(srcFile.transcript)).recordCount
    const dstPath = targetPaths(home, DST_CWD, s.id).transcript
    const dstCount = validateTranscript(fs.readFileSync(dstPath)).recordCount
    assert.equal(dstCount, srcCount, `记录数必须不变：${s.id}`)
  }

  // 幂等：再次导入同一包应全部跳过，不产生重复
  const again = await importVault({ vaultPath: v.output, dshHome: home, targetCwd: DST_CWD, apply: true })
  assert.equal(again.written.length, 0)
  assert.equal(again.skipped.length, v.sessions)

  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('replace 才覆盖，且覆盖前留下备份', { skip: !hasSessions }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-imp3-'))
  const v = await makeRealVault(tmp)
  const home = makeFakeHome()

  await importVault({ vaultPath: v.output, dshHome: home, targetCwd: DST_CWD, apply: true })
  // 篡改目标文件，模拟“本机已有内容”
  const target = targetPaths(home, DST_CWD, v.sessionIds[0])
  fs.writeFileSync(target.transcript, Buffer.from('tampered'))

  const res = await importVault({ vaultPath: v.output, dshHome: home, targetCwd: DST_CWD, apply: true, replace: true })
  assert.equal(res.written.length, v.sessions)
  assert.equal(res.backups.length, v.sessions)
  for (const b of res.backups) assert.ok(fs.existsSync(b.path))
  assert.equal(readHeader(fs.readFileSync(target.transcript)).header.cwd, DST_CWD)

  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('坏包被拒绝：篡改归档字节导致 sha256 不匹配', { skip: !hasSessions }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-imp4-'))
  const v = await makeRealVault(tmp)
  const home = makeFakeHome()

  // 找到会话数据区并翻一个 bit（store 法：数据紧随 local header + 名字之后）
  const { listZip, readZipEntry } = await import('../src/core/zip.js')
  const buf = Buffer.from(fs.readFileSync(v.output))
  const entry = listZip(buf).find((e) => e.name.startsWith('.dsvault/sessions/'))
  const dataStart = entry.offset + 30 + Buffer.from(entry.name, 'utf8').length
  buf[dataStart] = buf[dataStart] ^ 0xff
  const badPath = path.join(tmp, 'bad.dsvault')
  fs.writeFileSync(badPath, buf)

  // 归档级 CRC 会先拦住（readZipEntry 校验 CRC）
  await assert.rejects(
    () => planImport({ vaultPath: badPath, dshHome: home, targetCwd: DST_CWD }),
    /CRC32|sha256|校验失败/,
  )
  // 且一个字节都没写到目标 home
  const written = fs.existsSync(path.join(home, 'sessions')) ? fs.readdirSync(path.join(home, 'sessions')) : []
  assert.equal(written.length, 0)

  void readZipEntry
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})
