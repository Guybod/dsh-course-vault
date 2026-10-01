import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { zipSync, listZip, readZipEntry } from '../src/core/zip.js'
import { importCourse, previewCourse, exportCourse, listCourses } from '../src/core/course.js'
import { COURSE_DIRS, CHAT_DIR, validateCourseName } from '../src/core/layout.js'
import { targetPaths, scanSessions } from '../src/core/session-store.js'
import { readHeader, scanFrames, readHeaderFromFile } from '../src/core/zstd-codec.js'
import { openVault, importFullVault, planImport } from '../src/core/import.js'
import { makeEndpoints } from '../src/endpoints.js'
import { planContentImport } from '../src/core/content.js'
import { sha256 } from '../src/core/fsx.js'

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.dev/tests')
async function scratch(t) {
  await fsp.mkdir(testRoot, { recursive: true })
  const dir = await fsp.mkdtemp(path.join(testRoot, 'course-'))
  t.after(async () => {
    const relative = path.relative(testRoot, path.resolve(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return dir
}
async function source(dir) {
  const file = path.join(dir, 'source.zip')
  await fsp.writeFile(file, zipSync([
    {name:'course/02_COURSE_INDEX.md',data:Buffer.from('# 课程索引\n第一课：注意力\n')},
    {name:'course/03_LEARNING_STATE.md',data:Buffer.from('当前：待开始\n')},
    {name:'course/lessons/U01.md',data:Buffer.from('# 第一课\n')},
    {name:'course/projects/P01/practice.py',data:Buffer.from('# TODO: 学员自己实现\n')},
    {name:'course/data/tiny.json',data:Buffer.from('[1,2,3]')},
  ]))
  return file
}
async function seed(home, cwd, id, text = '第一课完成', createdAt = 1000) {
  const file = targetPaths(home, cwd, id).transcript
  const header = {type:'session',version:4,id,cwd,createdAt,isSeeded:false,agentPreset:'course',delegationDepth:0}
  const event = {seq:0,type:'user/message',time:createdAt,surfaceOp:'append',data:{id:`${id}-message`,source:{kind:'user'},role:'user',content:[{type:'text',text}]}}
  const frame = (record) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(record)+'\n'), {params:{[zlib.constants.ZSTD_c_checksumFlag]:1}})
  await fsp.mkdir(path.dirname(file),{recursive:true})
  await fsp.writeFile(file,Buffer.concat([frame(header),frame(event)]))
  return file
}

test('普通 ZIP 导入保留原件、三目录、课程导航和练习模板', async(t) => {
  const dir = await scratch(t), home = path.join(dir,'home')
  const opts = {sourcePath:await source(dir),dshHome:home,courseName:'中文课程'}
  const preview = await previewCourse(opts)
  await assert.rejects(fsp.access(preview.root),{code:'ENOENT'})
  assert.equal(preview.files,5)
  const result = await importCourse({...opts,apply:true})
  for (const folder of Object.values(COURSE_DIRS)) assert.ok((await fsp.stat(path.join(result.root,folder))).isDirectory())
  for (const folder of [COURSE_DIRS.outline,COURSE_DIRS.code]) assert.equal(await fsp.readFile(path.join(result.root,folder,'projects/P01/practice.py'),'utf8'),'# TODO: 学员自己实现\n')
  assert.match(await fsp.readFile(path.join(result.root,COURSE_DIRS.outline,'课程导航.md'),'utf8'),/lessons\/U01.md/)
  assert.equal((await listCourses(home)).courses[0].name,'中文课程')
  await assert.rejects(importCourse({...opts,apply:true}),/已存在/)
})

test('完整包含续写后的最新聊天，跨机恢复进度、代码和子目录路径', async(t) => {
  const dir = await scratch(t), homeA = path.join(dir,'machineA'), homeB = path.join(dir,'machineB')
  const imported = await importCourse({sourcePath:await source(dir),dshHome:homeA,courseName:'注意力课',apply:true})
  const original = await seed(homeA,imported.root,'lesson-chat')
  await seed(homeA,path.join(imported.root,COURSE_DIRS.code),'code-chat','张量形状已核验',2000)
  await seed(homeA,path.join(dir,'unrelated'),'other-chat','无关聊天')
  await exportCourse({dshHome:homeA,root:imported.root})
  await fsp.appendFile(original,zlib.zstdCompressSync(Buffer.from(JSON.stringify({seq:1,type:'user/message',time:3000,surfaceOp:'append',data:{id:'lesson-next',source:{kind:'user'},role:'user',content:[{type:'text',text:'继续学习：第二课已完成'}]}})+'\n')))
  await fsp.writeFile(path.join(imported.root,COURSE_DIRS.learning,'学习进度.md'),'第二课已完成\n下一步：第三课\n')
  await fsp.writeFile(path.join(imported.root,COURSE_DIRS.code,'projects/P01/practice.py'),'def attention(q,k,v):\n    return q @ k.T @ v\n')
  const exported = await exportCourse({dshHome:homeA,root:imported.root})
  assert.equal(exported.sessions,2)
  const vault = await openVault(exported.output)
  assert.equal(vault.checks.find(c=>c.id==='lesson-chat').data.length,(await fsp.stat(original)).size)
  const result = await importCourse({sourcePath:exported.output,dshHome:homeB,courseName:'另一台电脑的课程',apply:true})
  assert.equal(result.sessions.written.length,2)
  assert.equal(await fsp.readFile(path.join(result.root,COURSE_DIRS.learning,'学习进度.md'),'utf8'),'第二课已完成\n下一步：第三课\n')
  assert.match(await fsp.readFile(path.join(result.root,CHAT_DIR,'lesson-chat/session.jsonl'),'utf8'),/第二课已完成/)
  assert.match(await fsp.readFile(path.join(result.root,COURSE_DIRS.code,'projects/P01/practice.py'),'utf8'),/return q @ k.T @ v/)
  const restored = await scanSessions(homeB)
  assert.equal(restored.find(s=>s.id==='code-chat').cwd,path.join(result.root,COURSE_DIRS.code))
  const old = await fsp.readFile(original), next = await fsp.readFile(restored.find(s=>s.id==='lesson-chat').transcript)
  assert.deepEqual(old.subarray(scanFrames(old).frames[0].end),next.subarray(scanFrames(next).frames[0].end))
  assert.equal(readHeader(next).header.cwd,result.root)
})

test('大于 64 KiB 的聊天仍能发现，header 读取不受后续 frame 影响', async(t) => {
  const dir=await scratch(t),file=await seed(dir,dir,'long-chat')
  const random=Buffer.alloc(100000); for(let i=0;i<random.length;i++)random[i]=Math.random()*256
  await fsp.appendFile(file,zlib.zstdCompressSync(random))
  assert.ok((await fsp.stat(file)).size>65536)
  assert.equal((await readHeaderFromFile(file,fsp)).id,'long-chat')
})

test('课程换机保留代码和依赖定义，在目标机重建 Python 环境', async(t) => {
  const dir = await scratch(t), homeA = path.join(dir, 'env-a'), homeB = path.join(dir, 'env-b')
  const imported = await importCourse({ sourcePath: await source(dir), dshHome: homeA, courseName: '独立环境课', apply: true })
  const code = path.join(imported.root, COURSE_DIRS.code)
  const put = async (rel, data) => {
    const file = path.join(code, rel)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, data)
  }
  const definitions = { 'requirements.txt': 'numpy==2.2.6\n', 'uv.lock': '# preserved lock\n', '.python-version': '3.12\n' }
  for (const [rel, data] of Object.entries(definitions)) await put(rel, data)
  const generated = ['.venv/pyvenv.cfg', '.venv/Scripts/python.exe', 'projects/P01/venv/Lib/site-packages/fake.py', 'projects/P02/.VENV/pyvenv.cfg', '__pycache__/practice.pyc', '.pytest_cache/results']
  for (const rel of generated) await put(rel, 'local machine environment')
  const exported = await exportCourse({ dshHome: homeA, root: imported.root })
  const vault = await openVault(exported.output)
  const paths = vault.manifest.content.map((item) => item.path)
  for (const rel of generated) assert.ok(!paths.includes(`${COURSE_DIRS.code}/${rel}`), `环境生成物不应迁移：${rel}`)
  const restored = await importCourse({ sourcePath: exported.output, dshHome: homeB, courseName: '另一台环境课', apply: true })
  for (const [rel, data] of Object.entries(definitions)) assert.equal(await fsp.readFile(path.join(restored.root, COURSE_DIRS.code, rel), 'utf8'), data)
  assert.equal(await fsp.readFile(path.join(restored.root, COURSE_DIRS.code, 'projects/P01/practice.py'), 'utf8'), '# TODO: 学员自己实现\n')
  for (const rel of generated) await assert.rejects(fsp.access(path.join(restored.root, COURSE_DIRS.code, rel)), { code: 'ENOENT' })
})

test('坏内容在写入任何原生聊天前被拒绝', async(t) => {
  const dir=await scratch(t),home=path.join(dir,'a')
  const imported=await importCourse({sourcePath:await source(dir),dshHome:home,courseName:'课',apply:true})
  await seed(home,imported.root,'chat')
  const exported=await exportCourse({dshHome:home,root:imported.root})
  const buf=await fsp.readFile(exported.output),entries=listZip(buf)
  const manifest=JSON.parse(readZipEntry(buf,'.dsvault/manifest.json',entries)); manifest.content[0].sha256='bad'
  const broken=path.join(dir,'broken.dsvault')
  await fsp.writeFile(broken,zipSync(entries.map(e=>({name:e.name,data:e.name==='.dsvault/manifest.json'?Buffer.from(JSON.stringify(manifest)):readZipEntry(buf,e.name,entries)}))))
  const targetHome=path.join(dir,'b')
  await assert.rejects(importFullVault({vaultPath:broken,dshHome:targetHome,targetCwd:path.join(dir,'dest'),contentTarget:path.join(dir,'dest'),apply:true}),/sha256/)
  await assert.rejects(fsp.access(targetHome),{code:'ENOENT'})
})

test('拒绝同机跨课程复制相同会话身份；拒绝替换已加载聊天', async(t) => {
  const dir=await scratch(t),home=path.join(dir,'home')
  const imported=await importCourse({sourcePath:await source(dir),dshHome:home,courseName:'课',apply:true})
  await seed(home,imported.root,'active-chat')
  const exported=await exportCourse({dshHome:home,root:imported.root})
  await assert.rejects(planImport({vaultPath:exported.output,dshHome:home,targetCwd:path.join(dir,'复制课')}),/另一课程路径/)
  const endpoint=makeEndpoints(()=>({home}),()=>({get:(key)=>key==='sessions'?{get:()=>({})}:undefined}))
  await assert.rejects(endpoint['course/add']({sourcePath:exported.output,courseName:'课',replace:true,apply:true}),/目前已在 Harness 中加载/)
})

test('拒绝非法课程名和忽略大小写的重复 ZIP 路径',() => {
  for(const name of ['../课程','C:\\课','CON','NUL.txt','课.','a/b','a:b',''])assert.throws(()=>validateCourseName(name))
  assert.throws(()=>listZip(zipSync([{name:'a.txt',data:Buffer.from('a')},{name:'A.txt',data:Buffer.from('b')}])),/重复/)
})

test('课程内容清单不能把两个记录写到同一 Windows 路径',async(t) => {
  const dir=await scratch(t),data=Buffer.from('内容')
  await assert.rejects(planContentImport(dir,[{path:'a.txt',file:'a',sha256:sha256(data)},{path:'A.txt',file:'b',sha256:sha256(data)}],()=>data),/目标重复/)
})
