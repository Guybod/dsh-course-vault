/**
 * 路径编码规则——**必须与 DSH 后端逐字节一致**。
 *
 * 来源：`@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey()` / `encodeSegment()`。
 * 这两个函数是包私有的，没有导出，所以在本插件里重述一遍；规则一旦漂移，
 * 跨机导入就会把文件写到一个 DSH 永远找不到的目录里。
 *
 *   projectKey('C:\\code\\My Course')
 *     => '--C-code-My~0020Course--'
 *   sessionDir = <root>/<projectKey>/<encodeSegment(id)>/
 */

/** 单个路径段的转义：安全码元原样保留，其余（含 `~`）转成 `~XXXX`。 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('无法编码空的路径段')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * cwd → 项目目录名。
 *
 * 分隔符（`/`、`\`、`:`）连续出现时压缩成一个 `-`；开头的 `-` 序列被剥掉；
 * 截断到 251 字符。**分隔符替换和截断都是有损的**（DSH 自己的取舍）——
 * 这意味着不能靠目录名反推原始路径，只能靠 header 里的 `cwd`。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('无法编码空的 cwd')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Windows 下比较两个路径是否指向同一位置。
 *
 * 不做 realpath（后续可选增强）：先用大小写不敏感 + 分隔符归一化做保守比较。
 * 宁可判定为“不同”而走人工确认，也不要判定为“相同”而把文件写到错的地方。
 */
export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (p) => p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return norm(a).toLowerCase() === norm(b).toLowerCase()
}

/** 规范化展示用路径（不改写大小写，只统一分隔符、去掉结尾分隔符）。 */
export function normalizeDisplayPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p
  return p.replace(/[\\/]+/g, '\\').replace(/(?!^[A-Za-z]:)\\+$/, '')
}

/**
 * 校验一个候选目标路径是否可以安全作为导入落点。
 * 只做语法与包含关系检查，不触碰文件系统。
 */
export function assertSafeRelative(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('空路径')
  if (rel.startsWith('/') || rel.startsWith('\\')) throw new Error(`拒绝绝对路径：${rel}`)
  if (/^[A-Za-z]:/.test(rel)) throw new Error(`拒绝盘符路径：${rel}`)
  const parts = rel.split(/[\\/]+/)
  if (parts.includes('..')) throw new Error(`路径含危险段 '..'：${rel}`)
  if (parts.includes('')) return parts.filter(Boolean).join('/')
  return parts.join('/')
}
