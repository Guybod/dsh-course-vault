import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sessionsForWorkspace, scanSessions, summarizeSessions, targetPaths } from '../src/core/session-store.js'
import { exportWorkspaceSessions, inspectVault, listVaults, readLedger, defaultVaultName } from '../src/core/export.js'
import { readHeader } from '../src/core/zstd-codec.js'

const DSH_HOME = path.join(os.homedir(), '.dsh')
const CWD = 'C:\\Users\\MLTZ\\Documents\\deepseek-harness\\default-workspace'
const hasSessions = fs.existsSync(path.join(DSH_HOME, 'sessions'))

test('targetPaths 与 DSH 目录算法一致', () => {
  const t = targetPaths(DSH_HOME, CWD, 'session-abc')
  assert.equal(
    path.basename(t.projectDir),
    '--C-Users-MLTZ-Documents-deepseek-harness-default-workspace--',
  )
  assert.equal(path.basename(t.transcript), 'session.v4.jsonl.zstd')
})

test('scanSessions 能识别真实会话并读全 header 字段', { skip: !hasSessions }, async () => {
  const all = await scanSessions(DSH_HOME)
  assert.ok(all.length >= 1, '至少应有一个真实会话')
  const s = all[0]
  assert.equal(typeof s.id, 'string')
  assert.equal(typeof s.cwd, 'string')
  assert.equal(typeof s.createdAt, 'number')
  assert.equal(s.delegationDepth, 0)
  assert.ok(s.size > 0)
  assert.ok(fs.existsSync(s.transcript))
})

test('sessionsForWorkspace 只返回该工作区的会话，且只信 cwd 不信目录名', { skip: !hasSessions }, async () => {
  const mine = await sessionsForWorkspace(DSH_HOME, CWD)
  assert.ok(mine.length >= 1)
  for (const s of mine) {
    assert.equal(s.cwd.toLowerCase(), CWD.toLowerCase())
  }
  // 大小写与分隔符不同也应命中
  const alt = await sessionsForWorkspace(DSH_HOME, CWD.replace(/\\/g, '/'))
  assert.equal(alt.length, mine.length)
  // 不存在的路径必须返回空
  const none = await sessionsForWorkspace(DSH_HOME, 'C:\\definitely\\not\\a\\workspace')
  assert.equal(none.length, 0)
})

test('summarizeSessions 统计自洽', { skip: !hasSessions }, async () => {
  const mine = await sessionsForWorkspace(DSH_HOME, CWD)
  const sum = summarizeSessions(mine)
  assert.equal(sum.total, mine.length)
  assert.equal(sum.roots + sum.subagents, sum.total)
  assert.ok(sum.bytes > 0)
})

test('全量导出 → 落盘 → 重新打开校验全部 sha256 通过', { skip: !hasSessions }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-export-'))
  const res = await exportWorkspaceSessions({
    dshHome: DSH_HOME,
    cwd: CWD,
    sessionsDir: tmp,
    all: true,
    name: 'test-vault.dsvault',
  })
  assert.equal(res.ok, true)
  assert.equal(res.skipped, false)
  assert.ok(fs.existsSync(res.output))
  assert.ok(res.bytes > 0)
  assert.ok(res.sessions >= 1)

  const inspected = await inspectVault(res.output)
  assert.equal(inspected.manifest.format, 'dsvault')
  assert.equal(inspected.manifest.sourceWorkspace, CWD)
  assert.equal(inspected.checks.length, res.sessions)
  for (const c of inspected.checks) assert.equal(c.ok, true, `${c.id}: ${c.reason}`)

  // 包内 transcript 必须与磁盘上的源文件逐字节相同
  const zip = await import('../src/core/zip.js')
  const buf = fs.readFileSync(res.output)
  for (const s of inspected.manifest.sessions) {
    const packed = zip.readZipEntry(buf, s.file)
    const srcFile = (await sessionsForWorkspace(DSH_HOME, CWD)).find((x) => x.id === s.id)
    const src = fs.readFileSync(srcFile.transcript)
    assert.ok(packed.equals(src), `包内 ${s.id} 必须与源文件字节一致`)
    readHeader(packed) // 包内文件必须是可解析的合法会话日志
  }

  // 账本已记录
  const ledger = await readLedger(tmp)
  assert.equal(Object.keys(ledger.exported).length, res.sessions)

  // 再次导出（默认增量）应跳过
  const again = await exportWorkspaceSessions({ dshHome: DSH_HOME, cwd: CWD, sessionsDir: tmp })
  assert.equal(again.ok, true)
  assert.equal(again.skipped, true)

  // listVaults 能看到
  const vaults = await listVaults(tmp)
  assert.equal(vaults.length, 1)
  assert.equal(vaults[0].name, 'test-vault.dsvault')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('导出到不存在的工作区必须明确报错', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsvault-export2-'))
  await assert.rejects(
    () => exportWorkspaceSessions({ dshHome: DSH_HOME, cwd: 'C:\\nope\\nope', sessionsDir: tmp }),
    /没有任何会话记录/,
  )
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('defaultVaultName 形如 <课程名>-<YYYYMMDD>.dsvault', () => {
  const name = defaultVaultName('D:\\code\\LLM_VLA_Handwritten_Course', new Date(2026, 9, 1))
  assert.equal(name, 'LLM_VLA_Handwritten_Course-20261001.dsvault')
})
