import path from 'node:path'
import fsp from 'node:fs/promises'

export const COURSE_DIRS = Object.freeze({ outline: '01_课程大纲', learning: '02_讲解与记录', code: '03_我的代码' })
export const COURSE_META = 'course.json'
export const CHAT_DIR = `${COURSE_DIRS.learning}/聊天记录`

export function validateCourseName(value) {
  if (typeof value !== 'string') throw new Error('请填写课程名称')
  const name = value.trim()
  if (!name || name.length > 100 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('课程名称必须是有效的文件夹名（不能含斜杠、冒号等字符）')
  }
  return name
}

export async function readCourseMetadata(root) {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(root, COURSE_META), 'utf8'))
    if (meta.format !== 'dsh-course' || meta.version !== 1) throw new Error('不支持的课程目录版本')
    return meta
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
