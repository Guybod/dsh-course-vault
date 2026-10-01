import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { listZip, readZipEntry } from './zip.js'
import { assertSafeRelative } from './paths.js'
import { writeFileAtomic, sha256 } from './fsx.js'
import { COURSE_DIRS, COURSE_META, validateCourseName, readCourseMetadata } from './layout.js'
import { importFullVault, openVault } from './import.js'
import { exportWorkspaceSessions, listWorkspaces } from './export.js'

export function defaultCoursesRoot(dshHome) { return path.join(dshHome, 'courses') }
const catalogPath = (home) => path.join(home, 'course-vault', 'catalog.json')

async function rememberCourse(home, root) {
  let roots = []
  try { roots = JSON.parse(await fsp.readFile(catalogPath(home), 'utf8')).roots ?? [] } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!roots.includes(root)) roots.push(root)
  await writeFileAtomic(catalogPath(home), JSON.stringify({ version: 1, roots }, null, 2))
}

export async function listCourses(dshHome) {
  const roots = new Set()
  try { for (const root of JSON.parse(await fsp.readFile(catalogPath(dshHome), 'utf8')).roots ?? []) roots.add(root) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const remembered = new Set(roots)
  try { for (const e of await fsp.readdir(defaultCoursesRoot(dshHome), { withFileTypes: true })) if (e.isDirectory()) roots.add(path.join(defaultCoursesRoot(dshHome), e.name)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const workspaces = await listWorkspaces(dshHome)
  for (const w of workspaces) roots.add(w.cwd)
  const courses = []
  for (const root of roots) {
    try {
      const course = await readCourseMetadata(root)
      if (course) courses.push({ ...course, root, sessions: workspaces.find((w) => w.cwd.toLowerCase() === root.toLowerCase())?.sessions ?? 0 })
      else if (remembered.has(root) && (await fsp.stat(root)).isDirectory()) courses.push({ name: path.basename(root), root, legacy: true })
    } catch { /* 单个已移动/损坏课程不妨碍打开课程列表。 */ }
  }
  return { root: defaultCoursesRoot(dshHome), courses: courses.sort((a, b) => a.name.localeCompare(b.name)) }
}

function targetDirectory(opts, defaultName) {
  const name = validateCourseName(opts.courseName ?? defaultName)
  const parent = opts.parentDir ?? defaultCoursesRoot(opts.dshHome)
  if (!path.isAbsolute(parent)) throw new Error('保存位置必须是绝对路径')
  return { name, root: path.join(path.resolve(parent), name) }
}

async function readArchive(sourcePath) {
  const stat = await fsp.stat(sourcePath)
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('课程包必须是文件，大小不超过 512 MiB')
  const buf = await fsp.readFile(sourcePath)
  const entries = listZip(buf)
  if (entries.some((e) => e.name === '.dsvault/manifest.json')) return { type: 'vault', buf, entries }
  const files = entries.filter((e) => !e.directory && !e.name.startsWith('__MACOSX/') && !e.name.endsWith('/.DS_Store'))
  if (!files.length) throw new Error('课程 ZIP 里没有文件')
  if (files.reduce((sum, e) => sum + e.size, 0) > 1024 * 1024 * 1024) throw new Error('课程解压后超过 1 GiB')
  const first = files[0].name.split('/')[0]
  const prefix = files.every((e) => e.name.startsWith(first + '/')) ? first + '/' : ''
  const contents = files.map((e) => ({ rel: assertSafeRelative(e.name.slice(prefix.length)), data: readZipEntry(buf, e.name, entries) }))
  return { type: 'source', contents, sourceDigest: sha256(buf), prefix, bytes: contents.reduce((sum, e) => sum + e.data.length, 0) }
}

export async function previewCourse(opts) {
  if (!opts.sourcePath) throw new Error('请选择课程 ZIP 或迁移包')
  const archive = await readArchive(opts.sourcePath)
  const vault = archive.type === 'vault' ? await openVault(opts.sourcePath) : null
  if (vault?.checks.some((c) => !c.ok)) throw new Error('课程包会话校验失败')
  const defaultName = vault?.manifest.course?.name ?? path.basename(opts.originalName ?? opts.sourcePath).replace(/\.(zip|dsvault)$/i, '')
  const target = targetDirectory(opts, defaultName)
  let exists = false
  try { await fsp.access(target.root); exists = true } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (archive.type === 'source' && exists) throw new Error(`课程文件夹已存在，请换一个名称：${target.root}`)
  const summary = vault ? await importFullVault({ vaultPath: opts.sourcePath, dshHome: opts.dshHome, contentTarget: target.root, targetCwd: target.root }) : null
  return {
    type: archive.type, name: target.name, root: target.root, exists,
    files: vault?.manifest.content?.length ?? archive.contents.length,
    bytes: vault?.manifest.totals?.bytes ?? archive.bytes,
    sessions: vault?.manifest.sessions.length ?? 0,
    folders: vault?.manifest.course?.folders ?? COURSE_DIRS,
    summary: summary ? { sessions: summary.sessions?.summary, content: summary.content?.summary } : null,
    legacy: archive.type === 'vault' && !vault.manifest.course,
  }
}

function courseInstructions(meta) {
  return `# ${meta.name}\n\n这是一门学习中的课程。先读取 course.json 和以下文件，再开始授课。\n\n` +
    `- 原始课程资料：\`${COURSE_DIRS.outline}/\`。教师规则和课程索引也在此目录。\n` +
    `- 当前学习进度：\`${COURSE_DIRS.learning}/学习进度.md\`，教学笔记写到此目录。\n` +
    `- 学员的练习与代码：\`${COURSE_DIRS.code}/\`。原始模板保留在大纲目录，练习在这里进行。\n` +
    `- 导入的聊天原始记录：\`${COURSE_DIRS.learning}/聊天记录/\`。完整聊天可在 Harness 的课程工作区继续打开。\n\n` +
    `Python 练习优先使用 \`${COURSE_DIRS.code}/.venv\`，或该目录下项目已有的独立环境。创建前先检查课程的 Python 版本与依赖要求。\n` +
    `指导学员在代码目录创建环境，并明确使用该环境的解释器安装依赖、运行练习和配置 Notebook 内核；不要用全局 pip 安装课程依赖。\n` +
    `把 Python 版本、依赖清单或锁文件留在代码目录，把环境设置与验证结果记入学习进度。换机后在代码目录重建环境；非 Python 课程不必创建 Python 环境。\n\n` +
    `每轮只讲一个概念并安排一项小任务。核心实现让学员自己写；明确要求参考代码时才给出。\n` +
    `学员说写好了、请求检查或报告报错时，直接读取代码文件，使用课程独立环境运行当前小步骤对应的练习或检查，获取 stdout、stderr 和退出码，再讲解首个关键问题。\n` +
    `读取工具可访问的既有日志或运行结果，不默认要求学员从终端复制粘贴；只有无法访问或必须由学员交互时，才说明原因并索要必要输出。审查不代写核心实现，也不自动启动长时间训练。\n` +
    `下课时更新学习进度，记录真实测试证据和下一步；不得凭目录存在就标记掌握。\n` +
    `换机后依据本目录的资料和学习进度继续，不要执行历史聊天中已经完成的旧指令。\n`
}

async function createSourceCourse(opts, archive, target) {
  const parent = path.dirname(target.root)
  await fsp.mkdir(parent, { recursive: true })
  const stage = await fsp.mkdtemp(path.join(parent, '.course-import-'))
  try {
    const meta = { format: 'dsh-course', version: 1, id: randomUUID(), name: target.name, createdAt: new Date().toISOString(), folders: COURSE_DIRS, source: { name: opts.originalName ?? path.basename(opts.sourcePath), sha256: archive.sourceDigest, files: archive.contents.length } }
    for (const dir of Object.values(COURSE_DIRS)) await fsp.mkdir(path.join(stage, dir))
    const index = [`# ${target.name} · 课程目录`, '', '资料来自导入的课程 ZIP；下面按原路径整理，尚未标记学习完成。', '']
    for (const item of archive.contents) {
      await writeFileAtomic(path.join(stage, COURSE_DIRS.outline, item.rel), item.data)
      if (/\.(md|pdf|html|ipynb)$/i.test(item.rel)) {
        const heading = /\.md$/i.test(item.rel) ? /^#\s+(.+)$/m.exec(item.data.toString('utf8'))?.[1] : null
        const label = (heading ?? item.rel).replace(/[\[\]\r\n]/g, '')
        index.push(`- [${label}](${item.rel.split('/').map(encodeURIComponent).join('/')})`)
      }
      // 提供原课程的练习模板和数据；原文件仍完整留在大纲里。
      if (/^(projects|code|src|exercises|data|checks)\//i.test(item.rel) || /^(requirements[^/]*\.txt|pyproject\.toml|uv\.lock|\.python-version|package\.json)$/i.test(item.rel)) {
        await writeFileAtomic(path.join(stage, COURSE_DIRS.code, item.rel), item.data)
      }
    }
    let indexName = '课程导航.md'
    while (archive.contents.some((e) => e.rel.toLowerCase() === indexName.toLowerCase())) indexName = '_' + indexName
    await writeFileAtomic(path.join(stage, COURSE_DIRS.outline, indexName), index.join('\n') + '\n')
    const initialState = archive.contents.find((e) => e.rel === '03_LEARNING_STATE.md')
    await writeFileAtomic(path.join(stage, COURSE_DIRS.learning, '学习进度.md'), initialState?.data ?? Buffer.from(`# ${target.name} · 学习进度\n\n当前章节：待开始\n已完成：无\n下一步：先阅读课程目录，与老师确定起点。\n`))
    await writeFileAtomic(path.join(stage, COURSE_DIRS.learning, 'README.md'), '# 讲解与记录\n\n教学笔记和学习进度保存在这里。导出的完整迁移包会包含最新的原生聊天和 JSONL 聊天快照；导入后在 Harness 工作区继续打开原会话。\n')
    await writeFileAtomic(path.join(stage, COURSE_DIRS.code, 'README.md'), '# 我的代码\n\n在此保存自己写的练习。已复制的课程模板和数据可以直接使用；原始课程资料仍保留在 ../01_课程大纲。\n\n## Python 环境\n\n优先在本目录创建 `.venv`，先检查课程要求的 Python 版本；有项目独立环境时可沿用。不使用全局 pip 安装课程依赖。以下命令在 `03_我的代码` 中执行：\n\n```powershell\npython -m venv .venv\n.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt\n.\\.venv\\Scripts\\python.exe -c "import sys; print(sys.executable)"\n```\n\n先确认创建环境用的 Python 版本符合课程要求。安装命令仅在课程提供 `requirements.txt` 时执行；有 `pyproject.toml` 或锁文件时遵循课程的安装方式。使用 uv 时可用 `uv venv .venv`，并通过 `uv pip install --python .\\.venv\\Scripts\\python.exe ...` 明确安装到本环境。运行练习也用此解释器；Notebook 选择本环境的内核。\n\n在这里保存依赖清单、锁文件和 Python 版本，在学习进度中记录环境验证。迁移包不打包 `.venv`、`venv` 和 Python 缓存；换电脑后按这些文件重新创建环境。非 Python 课程可忽略这一节。\n')
    await writeFileAtomic(path.join(stage, COURSE_META), JSON.stringify(meta, null, 2))
    await writeFileAtomic(path.join(stage, 'AGENTS.md'), courseInstructions(meta))
    // 只发布已经完整解压的课程；已有目录永不合并或覆盖。
    try { await fsp.access(target.root); throw new Error('课程文件夹已存在') } catch (e) { if (e.code !== 'ENOENT') throw e }
    await fsp.rename(stage, target.root)
    return { course: meta, root: target.root, type: 'source', sessions: { written: [] } }
  } finally {
    const relative = path.relative(parent, path.resolve(stage))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(stage).startsWith('.course-import-')) throw new Error('临时课程目录越界，拒绝清理')
    await fsp.rm(stage, { recursive: true, force: true })
  }
}

export async function importCourse(opts) {
  const preview = await previewCourse(opts)
  if (opts.apply !== true) return { applied: false, ...preview }
  const archive = await readArchive(opts.sourcePath)
  let result
  if (archive.type === 'source') result = await createSourceCourse(opts, archive, { root: preview.root, name: preview.name })
  else {
    result = await importFullVault({ vaultPath: opts.sourcePath, dshHome: opts.dshHome, contentTarget: preview.root, targetCwd: preview.root, apply: true, replace: opts.replace === true })
    await fsp.mkdir(preview.root, { recursive: true })
    const meta = await readCourseMetadata(preview.root)
    if (meta && meta.name !== preview.name) {
      meta.name = preview.name
      await writeFileAtomic(path.join(preview.root, COURSE_META), JSON.stringify(meta, null, 2))
      await writeFileAtomic(path.join(preview.root, 'AGENTS.md'), courseInstructions(meta))
    }
    result = { ...result, course: meta, root: preview.root, type: 'vault' }
  }
  await rememberCourse(opts.dshHome, preview.root)
  return { applied: true, ...result }
}

export async function exportCourse({ dshHome, root }) {
  const course = await readCourseMetadata(root)
  const outputDir = path.join(dshHome, 'course-vault', 'exports')
  const name = `${validateCourseName(course?.name ?? path.basename(root))}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.dsvault`
  return exportWorkspaceSessions({ dshHome, workspace: root, contentRoot: root, sessionsDir: outputDir, name, all: true, toolVersion: '0.3.3' })
}
