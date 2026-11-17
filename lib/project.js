// project.json：一部真人剧一份状态。工具和页面都只读写这一份，
// 所以换会话、重启、隔天接着做都能恢复。
// 真人感约定：每集两个文件——E0X_分镜提示词.md（存档版，给人看）+ E0X_prompt.txt（纯正文，给模型）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export class ProjectError extends Error {}

export const ASPECTS = ['9:16', '16:9', '21:9', '1:1', '3:4', '4:3']

const FILE = 'project.json'

// 真人感默认（随包 skill 推荐，已对齐即梦 CLI 实测模型 ID）：
// 生图 Seedream 5.5、生视频 Seedance 2.5 Flash（原生语音+口型）、480p（15 秒约 105 积分，720p 约 285）。
export const DEFAULT_STYLE = '真人实拍质感，35毫米胶片摄影观感'
export const DEFAULT_VIDEO_MODEL = 'seedance_2.5_flash'
export const DEFAULT_IMAGE_MODEL = 'seedream_5.5'
export const DEFAULT_RESOLUTION = '480p'

export function projectFile(dir) {
  return join(dir, FILE)
}

export function isProjectDir(dir) {
  return existsSync(join(dir, FILE))
}

export function nowIso() {
  return new Date().toISOString()
}

// 所有来自模型的路径都必须是绝对路径，并且只能落在项目目录里。
export function resolveDir(input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new ProjectError('path 必须是项目目录的绝对路径')
  if (!isAbsolute(input)) throw new ProjectError(`path 要用绝对路径：${input}`)
  const dir = resolve(input)
  if (dirname(dir) === dir) throw new ProjectError('path 不能是盘符根目录')
  if (mustExist && !existsSync(dir)) throw new ProjectError(`目录不存在：${dir}`)
  return dir
}

export function assertInside(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  if (t !== r && !t.startsWith(r + sep)) throw new ProjectError(`路径越界：${target} 不在 ${root} 里`)
  return t
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw err
  }
}

function defaults(project) {
  const p = project || {}
  p.version = p.version || 1
  p.title = p.title || ''
  p.style = p.style || {}
  // 真人感版：默认风格「真人实拍质感 + 35 毫米胶片」，可整体换成二维/水墨/广告等（指南 §5）；
  // 色盘可选但强烈建议（防风格漂移）。
  p.style.description = p.style.description || DEFAULT_STYLE
  p.style.tone = p.style.tone || ''
  p.style.hook = p.style.hook || ''
  p.style.palette = p.style.palette || { zh: '', en: '' }
  p.style.styleBlock = p.style.styleBlock || ''
  p.video = p.video || {}
  p.video.aspect = p.video.aspect || '16:9'
  p.video.episodeSeconds = Number(p.video.episodeSeconds) || 15
  p.video.model = p.video.model || DEFAULT_VIDEO_MODEL
  p.video.resolution = p.video.resolution || DEFAULT_RESOLUTION
  p.video.region = p.video.region || 'cn'
  p.image = p.image || {}
  p.image.model = p.image.model || DEFAULT_IMAGE_MODEL
  p.image.resolution = p.image.resolution || '2K'
  p.canvas = p.canvas || null
  p.episodes = Array.isArray(p.episodes) ? p.episodes : []
  p.assets = Array.isArray(p.assets) ? p.assets : []
  // 真人感约定文件名由集号确定：patch 整体替换 episodes 时即使漏写也能自动回补
  for (const e of p.episodes) {
    if (!e.id) continue
    const id = String(e.id).toUpperCase().startsWith('E') ? String(e.id).toUpperCase() : `E${String(e.id).padStart(2, '0')}`
    e.id = id
    e.storyboard = e.storyboard || `${id}_分镜提示词.md`
    e.promptFile = e.promptFile || `${id}_prompt.txt`
  }
  return p
}

export function readProject(dir) {
  const file = projectFile(dir)
  if (!existsSync(file)) throw new ProjectError(`这里没有 project.json：${dir}。先用 realman_project action=init 建项目`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new ProjectError(`project.json 解析失败：${err.message}`)
  }
  return defaults(raw)
}

export function saveProject(dir, project) {
  project.updatedAt = nowIso()
  writeJsonAtomic(projectFile(dir), project)
  return project
}

export function initProject({ path, title, aspect, episodes, styleDescription, tone, hook, paletteZh, paletteEn, episodeSeconds, model, imageModel, resolution, imageResolution }) {
  const dir = resolveDir(path, { mustExist: false })
  if (isProjectDir(dir)) throw new ProjectError(`已经有项目了：${dir}（要改内容用 action=update）`)
  const count = Math.max(1, Math.min(50, Number(episodes) || 5))
  mkdirSync(dir, { recursive: true })
  for (const sub of ['assets', 'videos', 'out']) mkdirSync(join(dir, sub), { recursive: true })
  const project = defaults({
    title: title || basename(dir),
    createdAt: nowIso(),
    style: { description: styleDescription || DEFAULT_STYLE, tone: tone || '', hook: hook || '', palette: { zh: paletteZh || '', en: paletteEn || '' } },
    video: {
      aspect: ASPECTS.includes(aspect) ? aspect : '16:9',
      episodeSeconds: Number(episodeSeconds) || 15,
      model: model || DEFAULT_VIDEO_MODEL,
      resolution: resolution || DEFAULT_RESOLUTION
    },
    image: { model: imageModel || DEFAULT_IMAGE_MODEL, resolution: imageResolution || '2K' },
    episodes: Array.from({ length: count }, (_, i) => {
      const id = `E${String(i + 1).padStart(2, '0')}`
      return {
        id,
        title: '',
        storyboard: `${id}_分镜提示词.md`,
        promptFile: `${id}_prompt.txt`,
        prompt: '',
        refs: [],
        endingFrame: '',
        video: { status: 'idle', taskId: null, file: null, error: null }
      }
    }),
    assets: []
  })
  return saveProject(dir, project)
}

// patch 只做一层合并（数组整体替换），避免模型写半截对象把已有字段抹掉。
export function updateProject(dir, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProjectError('patch 必须是一个 JSON 对象')
  const current = readProject(dir)
  const next = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'assets' || k === 'episodes') {
      if (!Array.isArray(v)) throw new ProjectError(`${k} 必须是数组`)
      next[k] = v.map((item) => ({ ...item }))
    } else if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object' && !Array.isArray(current[k])) {
      next[k] = { ...current[k], ...v }
    } else {
      next[k] = v
    }
  }
  return saveProject(dir, defaults(next))
}

// 页面卡片要的摘要（一个项目一行）。listProjects 和历史里额外出现的项目都走这里，
// 保证两边字段完全一致。
export function projectSummary(dir) {
  const project = readProject(dir)
  const doneEpisodes = project.episodes.filter((e) => e.video && e.video.file).length
  const credits = [...project.assets, ...project.episodes.map((e) => e.video || {})]
    .reduce((sum, item) => sum + (Number(item && item.credits) || 0), 0)
  const finalPath = join(dir, 'out', 'final.mp4')
  const cover = (() => {
    const hit = project.assets.find((a) => a.status === 'done' && a.file)
    return hit ? relativeFile(dir, hit.file) : null
  })()
  return {
    path: dir,
    title: project.title,
    aspect: project.video.aspect,
    episodeSeconds: project.video.episodeSeconds,
    episodes: project.episodes.length,
    assets: project.assets.length,
    doneAssets: project.assets.filter((a) => a.status === 'done').length,
    failedAssets: project.assets.filter((a) => a.status === 'failed').length,
    doneEpisodes,
    credits,
    palette: (project.style.palette || {}).zh || '',
    styleDescription: project.style.description || '',
    tone: project.style.tone || '',
    hook: project.style.hook || '',
    canvasUrl: (project.canvas || {}).url || '',
    hasFinal: existsSync(finalPath),
    finalBytes: existsSync(finalPath) ? statSync(finalPath).size : 0,
    cover,
    createdAt: project.createdAt || null,
    updatedAt: project.updatedAt || statSync(projectFile(dir)).mtime.toISOString()
  }
}

export function listProjects(parent) {
  const dir = resolveDir(parent)
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isProjectDir(join(dir, d.name)))
    .map((d) => {
      try { return projectSummary(join(dir, d.name)) } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function relativeFile(dir, file) {
  if (!file) return null
  const abs = resolve(dir, file)
  return existsSync(abs) ? normalize(relative(dir, abs)) : null
}

// 给页面用的摘要：文件路径一律相对项目目录，prompt 只留预览（页面要的是「写了什么」，
// 不是把整段分镜塞进接口返回）。
const PREVIEW_CHARS = 320

export function fileSummary(dir, project) {
  const assets = project.assets.map((a) => ({
    id: a.id,
    name: a.name || '',
    status: a.status || 'idle',
    file: relativeFile(dir, a.file),
    nodeId: a.nodeId || null,
    taskId: a.taskId || null,
    ratio: a.ratio || '',
    credits: Number.isFinite(Number(a.credits)) ? Number(a.credits) : null,
    promptChars: String(a.prompt || '').length,
    prompt: String(a.prompt || '').slice(0, PREVIEW_CHARS),
    error: a.error || null
  }))
  const episodes = project.episodes.map((e) => ({
    id: e.id,
    title: e.title || '',
    refs: e.refs || [],
    promptChars: String(e.prompt || '').length,
    prompt: String(e.prompt || '').slice(0, PREVIEW_CHARS),
    promptFile: relativeFile(dir, e.promptFile || ''),
    hasPromptFile: Boolean(e.promptFile && existsSync(join(dir, e.promptFile))),
    storyboard: relativeFile(dir, e.storyboard),
    video: {
      status: (e.video && e.video.status) || 'idle',
      file: relativeFile(dir, e.video && e.video.file),
      nodeId: (e.video && e.video.nodeId) || null,
      taskId: (e.video && e.video.taskId) || null,
      credits: e.video && Number.isFinite(Number(e.video.credits)) ? Number(e.video.credits) : null,
      duration: e.video && Number.isFinite(Number(e.video.duration)) ? Number(e.video.duration) : null,
      mode: (e.video && e.video.mode) || '',
      finishedAt: (e.video && e.video.finishedAt) || null,
      error: (e.video && e.video.error) || null
    }
  }))
  return { assets, episodes }
}
