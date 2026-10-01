window.__ModuleLoader__.load({
  id: 'dsh-course-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 通道与客户端插件共用（host 半包挂在同一个前缀上）。 */
    const CHANNEL = '/dsh-course'

    /** 走官方 client-request 信封调 host 半包，不依赖 ctx.remote 是否暴露我们的端点。 */
    async function rpc(method, payload) {
      const res = await fetch(`${CHANNEL}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `${Date.now()}`,
          method,
          payload: payload ?? {},
        }),
      })
      if (!res.ok) throw new Error(`通道返回 HTTP ${res.status}（${CHANNEL}/${method}）`)
      const body = await res.json()
      const result = body?.result
      if (!result) throw new Error('响应格式不对：缺少 result')
      if (!result.ok) throw new Error(result.error?.message ?? '未知错误')
      return result.value
    }

    /** 极简对话框：报告纯文本结果，不引入宿主组件库。 */
    function Dialog({ title, lines, onClose }) {
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          },
          onClick: onClose,
        },
        h(
          'div',
          {
            onClick: (e) => e.stopPropagation(),
            style: {
              maxWidth: '660px',
              maxHeight: '70vh',
              overflow: 'auto',
              background: 'var(--dsw-surface, #1f1f22)',
              color: 'var(--dsw-text, #e8e8ea)',
              border: '1px solid var(--dsw-border, #3a3a40)',
              borderRadius: '10px',
              padding: '16px 18px',
              font: '13px/1.6 ui-monospace, Consolas, monospace',
              whiteSpace: 'pre-wrap',
              minWidth: '320px',
            },
          },
          [
            h(
              'div',
              { key: 't', style: { fontWeight: 600, marginBottom: 8, fontFamily: 'system-ui' } },
              title,
            ),
            h('div', { key: 'b' }, lines.join('\n')),
            h(
              'button',
              {
                key: 'c',
                type: 'button',
                onClick: onClose,
                style: {
                  marginTop: 12,
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-border, #3a3a40)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                },
              },
              '关闭',
            ),
          ],
        ),
      )
    }

    /**
     * 课程包按钮组：导出 / 导入 / 设为默认模式。
     *
     * 注意：组件里**不能**用 `ctx` 这个名字——注册进 slot 的组件收到的 `ctx` 是
     * React hooks 上下文，不是插件上下文。所以 `remote` 由 apply 显式传进来。
     */
    function CourseVaultButtons({ remote }) {
      const [busy, setBusy] = React.useState('')
      const [dialog, setDialog] = React.useState(null)

      const wrap = (label, fn) => async () => {
        setBusy(label)
        try {
          const lines = await fn()
          setDialog({ title: `${label}`, lines })
        } catch (err) {
          setDialog({ title: `${label}失败`, lines: [String(err?.message ?? err)] })
        } finally {
          setBusy('')
        }
      }

      /** 课程文件夹：优先猜已注册工作区里的那个，猜不到就问。 */
      const pickCourseDir = async (hint) => {
        let list = []
        try {
          list = (await rpc('workspace/list', {})) || []
        } catch {
          /* 读不到就纯手填 */
        }
        const guess =
          list.find((w) => /course|课程|LLM_VLA/i.test(w.cwd))?.cwd ?? list[0]?.cwd ?? hint ?? ''
        const answer = window.prompt('课程文件夹的完整路径（打包/解包的根目录）：', guess)
        return answer ? answer.trim().replace(/[\\/]+$/, '') : null
      }

      const onExport = wrap('导出课程包', async () => {
        const courseDir = await pickCourseDir()
        if (!courseDir) throw new Error('已取消（未填写课程文件夹）')
        const r = await rpc('course/export', { workspace: courseDir, contentRoot: courseDir })
        if (r.skipped) {
          return ['没有新会话需要导出（账本已记录）。', '', '要全量重导请用命令行：node tools/export.mjs <课程> --all']
        }
        return [
          '导出成功',
          '',
          `包    : ${r.output}`,
          `大小  : ${(r.bytes / 1024 / 1024).toFixed(2)} MB`,
          `会话  : ${r.sessions} 条`,
          '',
          '把这些内容拷到另一台电脑，再点「导入课程包」还原。',
          '（会话为 0 说明这个工作区还没上过课；包只含课程内容。）',
        ]
      })

      const onImport = wrap('导入课程包', async () => {
        const vaultPath = window.prompt('课程包（.dsvault）的完整路径：', '')
        if (!vaultPath) throw new Error('已取消（未填写包路径）')
        const to = await pickCourseDir()
        if (!to) throw new Error('已取消（未填写落点）')

        const dry = await rpc('course/import-plan', {
          vaultPath: vaultPath.trim(),
          contentTarget: to,
        })
        const s = dry.sessions?.summary ?? {}
        const c = dry.content?.summary ?? {}
        const lines = [
          '【预检 · 尚未写入】',
          `路径映射: ${s.rewrites ?? 0} 条会话需要改 cwd`,
          '',
          `会话: 新建 ${s.create ?? 0} / 覆盖 ${s.replace ?? 0} / 跳过 ${s.skip ?? 0}`,
          `内容: 新增 ${c.create ?? 0} / 相同 ${c.same ?? 0} / 冲突 ${c.conflict ?? 0}`,
        ]
        if ((c.conflict ?? 0) > 0) lines.push('', `⚠️ ${c.conflict} 个文件本机改过，默认不覆盖（保本机版本）。`)
        setDialog({ title: '导入预检（还没写）', lines })

        const go = window.confirm(
          [
            `会话：新建 ${s.create ?? 0}、覆盖 ${s.replace ?? 0}、跳过 ${s.skip ?? 0}`,
            `内容：新增 ${c.create ?? 0}、相同 ${c.same ?? 0}、冲突 ${c.conflict ?? 0}`,
            '',
            '现在真正写入吗？',
          ].join('\n'),
        )
        if (!go) return ['已取消，未写入任何文件。']

        const r = await rpc('course/import', {
          vaultPath: vaultPath.trim(),
          contentTarget: to,
          apply: true,
          registerWorkspace: true,
        })
        const out = [
          '导入完成',
          '',
          `内容: 写入 ${r.content?.written?.length ?? 0} 个文件`,
          `会话: 写入 ${r.sessions?.written?.length ?? 0} 条（跳过 ${r.sessions?.skipped?.length ?? 0}）`,
        ]
        if (r.workspace) {
          const w = r.workspace
          out.push(
            '',
            `工作区: ${w.created ? '已新建并注册' : w.alreadyRegistered ? '已存在' : '未注册'} — ${w.path ?? ''}`,
          )
          if (w.note) out.push(w.note)
        }
        return out
      })

      const onSetDefault = wrap('设为默认模式', async () => {
        const settings = remote?.settings
        if (!settings || typeof settings.update !== 'function') {
          throw new Error('当前宿主没有 settings.update，请手动在设置页里把默认模式改成「课程模式」')
        }
        await settings.update('agent-preset-registry', { selectedDefault: 'course' }, void 0)
        return [
          '已把「课程模式」设为新会话的默认模式。',
          '',
          '只影响之后新建的会话；已有会话不受影响。',
        ]
      })

      const baseBtn = {
        display: 'inline-flex',
        alignItems: 'center',
        height: '26px',
        padding: '0 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-border, #3a3a40)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      const btnStyle = busy ? Object.assign({}, baseBtn, { opacity: 0.55, cursor: 'default' }) : baseBtn

      const items = [
        { key: 'export', label: busy === '导出课程包' ? '导出中…' : '导出课程包', onClick: onExport },
        { key: 'import', label: busy === '导入课程包' ? '导入中…' : '导入课程包', onClick: onImport },
        { key: 'default', label: busy === '设为默认模式' ? '设置中…' : '设为默认模式', onClick: onSetDefault },
      ]

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
          items.map((it) =>
            h(
              'button',
              { key: it.key, type: 'button', style: btnStyle, disabled: !!busy, onClick: it.onClick },
              it.label,
            ),
          ),
        ),
        dialog ? h(Dialog, { title: dialog.title, lines: dialog.lines, onClose: () => setDialog(null) }) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const remote = ctx?.remote
        // 会话头部右侧工具区（官方「会话日志」导出按钮也在这一区）
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'course-vault', order: 20 },
            (props) => h(CourseVaultButtons, Object.assign({}, props, { remote })),
          ),
        )
      },
    }
  },
})
