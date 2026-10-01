/* 浏览器半包直接导出工厂注册脚本；不能指向仅有 name 的 Node 占位模块。 */
window.__ModuleLoader__.load({
  id: 'dsh-course-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    let dialogState = null
    const listeners = new Set()
    const show = (tab = 'library', root = '') => { dialogState = { tab, root }; for (const fn of listeners) fn() }
    const close = () => { dialogState = null; for (const fn of listeners) fn() }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const snapshot = () => dialogState

    async function rpc(method, payload = {}) {
      const res = await fetch(`/dsh-course/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) })
      if (!res.ok) throw new Error(`课程服务返回 HTTP ${res.status}`)
      const result = (await res.json()).result
      if (!result?.ok) throw new Error(result?.error?.message ?? '课程服务响应无效')
      return result.value
    }

    function Launchers({ root = '' }) {
      return h('div', { className: 'dsv-actions dsv-composer-actions' },
        h('button', { type: 'button', onClick: () => show('import', root) }, '导入课程'),
        h('button', { type: 'button', onClick: () => show('library', root) }, '我的课程 / 导出'))
    }

    function ComposerCourse({ useSessions, sessionId }) {
      const session = useSessions((s) => s.byId[sessionId])
      return session?.blank && session.projectionValues?.agentPreset === 'course' ? h(Launchers, { root: session.cwd }) : null
    }

    function HeaderCourse({ useSessions, sessionId }) {
      const session = useSessions((s) => s.byId[sessionId])
      return session?.projectionValues?.agentPreset === 'course' ? h('button', { type: 'button', className: 'dsv-header', onClick: () => show('library', session.cwd) }, '课程') : null
    }

    function CourseDialog({ initial, uiWorkspace, sessions, remote }) {
      const [tab, setTab] = React.useState(initial.tab)
      const [courses, setCourses] = React.useState([])
      const [root, setRoot] = React.useState(initial.root)
      const [parentDir, setParentDir] = React.useState('')
      const [courseName, setCourseName] = React.useState('')
      const [source, setSource] = React.useState(null)
      const [preview, setPreview] = React.useState(null)
      const [replace, setReplace] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [download, setDownload] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const formRef = React.useRef(null)
      const run = async (label, fn) => {
        setBusy(label); setError(''); setMessage('')
        try { await fn() } catch (e) { setError(e.message ?? String(e)) } finally { setBusy('') }
      }
      const loadCourses = async () => {
        const list = await rpc('course/list')
        setCourses(list.courses)
        setParentDir((current) => current || list.root)
        setRoot((current) => list.courses.some((c) => c.root === current) ? current : list.courses[0]?.root ?? '')
      }
      React.useEffect(() => { run('读取课程', loadCourses) }, [])
      React.useEffect(() => {
        const previous = document.activeElement
        formRef.current?.querySelector('button')?.focus()
        return () => previous?.focus?.()
      }, [])
      React.useEffect(() => {
        let current = true
        setHistory([])
        if (root) rpc('course/history', { root }).then((items) => { if (current) setHistory(items) }).catch((e) => { if (current) setError(e.message) })
        return () => { current = false }
      }, [root])
      const sourcePayload = () => ({ ...source, courseName, parentDir })
      const selectFile = (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        event.target.value = ''
        setPreview(null); setSource(null); setReplace(false)
        run('上传课程包', async () => {
          const res = await fetch(`/dsh-course/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
          const result = await res.json()
          if (!result.ok) throw new Error(result.error?.message ?? '上传失败')
          setSource(result.value)
          // 迁移包可能有正式课程名；让服务读取它，再由用户修改。
          const info = await rpc('course/preview', { ...result.value, parentDir })
          setCourseName(info.name)
        })
      }
      const doPreview = () => run('检查课程包', async () => { setPreview(await rpc('course/preview', sourcePayload())) })
      const browseParentDir = () => run('选择保存文件夹', async () => {
        // 与官方工作区选择器保持一致：桌面版走 preload，取消或失败不重试。
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__
        const selected = await (desktop === undefined ? uiWorkspace.pickDirectory() : desktop.pick())
        if (selected !== null) { setParentDir(selected); setPreview(null) }
      })
      const doImport = () => run('导入课程', async () => {
        const result = await rpc('course/add', { ...sourcePayload(), apply: true, replace })
        await sessions.refresh()
        setRoot(result.root)
        await loadCourses()
        setHistory(await rpc('course/history', { root: result.root }))
        setPreview(null); setTab('library')
        setMessage(`已导入「${result.course?.name ?? courseName}」。恢复 ${result.sessions?.written?.length ?? 0} 条聊天；课程资料、学习记录和代码已保存。${result.workspace?.failures?.length ? result.workspace.note : ''}`)
      })
      const doExport = () => run('导出完整课程', async () => {
        const result = await rpc('course/portable-export', { root })
        setDownload(result)
        setMessage(`已打包全部课程文件和 ${result.sessions} 条最新聊天。下载后在另一台电脑的「导入课程」中选择这个文件。`)
      })
      const startCourse = () => run('打开课程', async () => {
        const workspace = await rpc('course/open', { root })
        if (!workspace.workspaceId) throw new Error(workspace.note)
        await uiWorkspace.openWorkspace(workspace.workspaceId)
        const blank = Object.values(sessions.list.getSnapshot().byId).find((s) => s.blank && (s.retainedBy.mainView ?? 0) > 0 && s.cwd === root)
        if (blank) {
          const result = await remote.agentPresets.select(blank.id, 'course')
          if (!result.ok) throw new Error(result.error.message)
        }
        close()
      })
      const resume = (id) => run('打开学习记录', async () => { await sessions.refresh(); uiWorkspace.openSession(id); close() })
      const change = (setter) => (e) => { setter(e.target.value); setPreview(null) }
      const dismiss = () => { if (!busy) close() }
      const onKeyDown = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); dismiss() }
        if (e.key === 'Tab') {
          const focusable = [...formRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
          const first = focusable[0], last = focusable.at(-1)
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }
      return h('div', { className: 'dsv-backdrop', onClick: dismiss },
        h('section', { className: 'dsv-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dsv-title', ref: formRef, onClick: (e) => e.stopPropagation(), onKeyDown },
          h('div', { className: 'dsv-title' }, h('h2', { id: 'dsv-title' }, '课程学习'), h('button', { type: 'button', disabled: !!busy, onClick: dismiss, 'aria-label': '关闭课程窗口' }, '×')),
          h('p', { className: 'dsv-muted' }, '把课程资料、讲解与聊天、自己写的代码一起保存。换电脑时，导出一个完整课程包即可。'),
          h('nav', { className: 'dsv-tabs', 'aria-label': '课程操作' }, ['library', 'import'].map((t) => h('button', { key: t, type: 'button', disabled: !!busy, 'aria-pressed': tab === t, onClick: () => { setTab(t); setError(''); setMessage('') } }, t === 'library' ? '我的课程' : '导入课程'))),
          tab === 'import' ? h('div', { className: 'dsv-form' },
            h('label', null, '课程文件', h('input', { type: 'file', accept: '.zip,.dsvault', disabled: !!busy, onChange: selectFile })),
            source ? h('p', { className: 'dsv-muted' }, source.originalName) : h('p', { className: 'dsv-muted' }, '选择普通课程 ZIP 来开始学习，或选择 .dsvault 恢复已经学过的课程。'),
            h('label', null, '课程名称', h('input', { value: courseName, placeholder: '例如：LLM 与 VLA 手写课程', disabled: !!busy, onChange: change(setCourseName) })),
            h('div', { className: 'dsv-field' },
              h('label', { htmlFor: 'dsv-parent-dir' }, '保存位置（将在这里创建课程名称文件夹）'),
              h('div', { className: 'dsv-directory-field' },
                h('input', { id: 'dsv-parent-dir', value: parentDir, disabled: !!busy, onChange: change(setParentDir) }),
                h('button', { type: 'button', disabled: !!busy, onClick: browseParentDir, 'aria-label': '浏览保存文件夹' }, '浏览…'))),
            h('div', { className: 'dsv-folders' }, '01_课程大纲', h('br'), '02_讲解与记录', h('br'), '03_我的代码'),
            preview ? h('div', { className: 'dsv-preview' },
              h('strong', null, preview.type === 'source' ? '新课程' : '恢复学习中的课程'),
              h('p', null, `${preview.files} 个课程文件 · ${preview.sessions} 条聊天`),
              h('p', { className: 'dsv-path' }, preview.root),
              preview.legacy ? h('p', null, '这是旧版迁移包，会保留原来的目录结构。') : null,
              preview.exists ? h('label', { className: 'dsv-checkbox' }, h('input', { type: 'checkbox', checked: replace, disabled: !!busy, onChange: (e) => setReplace(e.target.checked) }), '更新已有课程的冲突文件和聊天（先保存备份）') : null,
              preview.exists ? h('p', null, `文件冲突 ${preview.summary?.content?.conflict ?? 0} 个；已有聊天 ${preview.summary?.sessions?.skip ?? 0} 条。默认保留本机版本。`) : null,
              h('button', { type: 'button', className: 'dsv-primary', disabled: !!busy, onClick: doImport }, '导入并保存课程')) : h('button', { type: 'button', className: 'dsv-primary', disabled: !!busy || !source || !courseName.trim(), onClick: doPreview }, '检查并预览')) :
            h('div', { className: 'dsv-form' },
              courses.length ? h('label', null, '选择课程', h('select', { value: root, disabled: !!busy, onChange: (e) => { setRoot(e.target.value); setDownload(null); setMessage('') } }, courses.map((c) => h('option', { key: c.root, value: c.root }, c.name)))) : h('p', null, '还没有课程。先导入课程 ZIP，或从另一台电脑导入迁移包。'),
              root && courses.length ? h(React.Fragment, null,
                h('p', { className: 'dsv-path' }, root),
                h('div', { className: 'dsv-actions' }, h('button', { type: 'button', disabled: !!busy, onClick: startCourse }, '开始新一课'), h('button', { type: 'button', disabled: !!busy, onClick: doExport }, '导出完整课程')),
                history.length ? h('div', { className: 'dsv-history' }, h('h3', null, '之前的聊天'), history.map((s, i) => h('button', { type: 'button', key: s.id, disabled: !!busy, onClick: () => resume(s.id) }, `${i === 0 ? '继续最近一次学习 · ' : ''}${new Date(s.createdAt).toLocaleString()} · ${s.id.slice(0, 8)}`))) : h('p', { className: 'dsv-muted' }, '尚未产生聊天。开始新一课后，会话会随课程一起迁移。')) : null),
          busy ? h('p', { role: 'status' }, `${busy}…`) : null,
          error ? h('p', { className: 'dsv-error', role: 'alert' }, error) : null,
          message ? h('p', { role: 'status' }, message) : null,
          download ? h('a', { className: 'dsv-download', href: download.downloadUrl, download: download.name }, `下载课程包 · ${(download.bytes / 1048576).toFixed(1)} MB`) : null))
    }

    function Overlay({ useSessions, uiWorkspace, sessions, remote }) {
      const state = React.useSyncExternalStore(subscribe, snapshot)
      const current = useSessions((s) => Object.values(s.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0))
      const isCourse = current?.projectionValues?.agentPreset === 'course'
      React.useEffect(() => { close() }, [isCourse, current?.id])
      if (!isCourse) return null
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsv-global', onClick: () => show('library', current.cwd) }, '课程管理'),
        state ? h(CourseDialog, { key: `${state.tab}:${state.root}`, initial: state, uiWorkspace, sessions, remote }) : null)
    }

    const css = `
      .dsv-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .dsv-actions button,.dsv-dialog button,.dsv-header,.dsv-global{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 12px;background:transparent;cursor:pointer}
      .dsv-actions button:hover:not(:disabled),.dsv-dialog button:hover:not(:disabled),.dsv-header:hover,.dsv-global:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsv-composer-actions{gap:6px}.dsv-composer-actions button{height:28px;font-size:12px;line-height:18px;padding:0 10px;white-space:nowrap}
      .dsv-dialog button:disabled{opacity:.5;cursor:default}.dsv-dialog :focus-visible,.dsv-actions :focus-visible,.dsv-header:focus-visible,.dsv-global:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}
      .dsv-header{font-size:12px;padding:4px 8px}
      .dsv-global{position:fixed;bottom:18px;right:20px;z-index:100;font-size:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 2px 12px #0001}
      .dsv-backdrop{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:10000;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;padding:max(24px,calc(var(--dsh-frame-overlay-top,24px) - var(--dsh-frame-chrome-top,0px))) 24px}
      .dsv-dialog{box-sizing:border-box;width:640px;max-width:100%;max-height:88vh;overflow:auto;padding:24px;border:1px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);box-shadow:var(--dsw-elevation-prominent,0 24px 80px #0003)}
      .dsv-title{display:flex;justify-content:space-between;align-items:center}.dsv-title h2{margin:0;font-size:22px}.dsv-title button{font-size:22px;padding:0 10px}
      .dsv-muted{color:var(--dsw-alias-label-secondary);font-size:13px}.dsv-tabs{display:flex;gap:8px;margin:20px 0}.dsv-dialog .dsv-tabs button[aria-pressed=true]{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-link);color:var(--dsw-alias-label-primary)}
      .dsv-form{display:grid;gap:12px}.dsv-form label{display:grid;gap:6px}.dsv-form input:not([type=checkbox]),.dsv-form select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:10px;background:transparent;color:inherit;font:inherit}
      .dsv-field{display:grid;gap:6px}.dsv-directory-field{display:flex;gap:8px}.dsv-directory-field input{min-width:0;flex:1}.dsv-directory-field button{flex:none;white-space:nowrap}
      .dsv-form input::placeholder{color:var(--dsw-alias-label-tertiary)}.dsv-form select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.dsv-form input::file-selector-button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;padding:4px 8px;margin-right:8px;cursor:pointer}
      .dsv-folders,.dsv-preview{border:1px solid var(--dsw-alias-border-l3);padding:12px 16px;border-radius:10px}.dsv-folders{color:var(--dsw-alias-label-secondary);font-size:13px}.dsv-path{font-size:12px;overflow-wrap:anywhere}.dsv-checkbox{display:flex!important;align-items:center}
      .dsv-dialog .dsv-primary,.dsv-download{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}.dsv-dialog .dsv-primary{justify-self:start}.dsv-dialog .dsv-primary:hover:not(:disabled),.dsv-download:hover{background:var(--dsw-alias-button-primary-hover)}.dsv-history{display:grid;gap:6px}.dsv-history h3{font-size:14px}.dsv-history button{text-align:left;font-size:12px}.dsv-error{color:var(--dsw-alias-state-error-primary)}.dsv-download{display:inline-block;padding:10px 16px;border-radius:8px;text-decoration:none}
    `

    return {
      inject: ['slots', 'uiWorkspace', 'sessions', 'remote', 'remote.agentPresets'],
      apply(ctx) {
        ctx.effect(() => { const style = document.createElement('style'); style.dataset.pluginCss = 'dsh-course-vault'; style.textContent = css; document.head.append(style); return () => style.remove() })
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'course-vault', order: 30 }, ComposerCourse))
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'course-vault', order: 20 }, HeaderCourse))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'course-vault', order: 80 }, (props) => h(Overlay, { ...props, uiWorkspace: ctx.uiWorkspace, sessions: ctx.sessions, remote: ctx.remote })))
      },
    }
  },
})
