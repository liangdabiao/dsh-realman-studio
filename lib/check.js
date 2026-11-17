// realman_check 的检查内核：只做「机械事故安检」。
// 写剧本/分镜/提示词是 LLM 基于随包 skill 的创作，程序不评判内容好坏；
// 这里只拦两类问题：
//   1. 直接导致白烧积分/废片的机械事故 —— 纯净性破坏（发错内容给模型）、
//      缺【声音】段或口型声明（成片全哑）、台词抄第二遍、时间轴格式解析不了
//   2. 文件格式约定（skill 声明的产出格式）—— 只提示，不阻塞出片
// 纯文本统计、零联网、零生成、零创作评判。
import { readdirSync, readFileSync } from 'node:fs'

function push(list, severity, message) {
  list.push({ severity, message })
}

export function severityLabel(s) {
  return s === 'error' ? '❌' : s === 'warn' ? '⚠️' : 'ℹ️'
}

// ---------------------------------------------------------------- 词表

// 台词引用：兼容「」、弯双引号和 ASCII 直引号（LLM 输出常混用）。注意：引号也可能包「黑板上的字」，
// 所以重复检测只报「同一句出现多次」，不假设引号必是台词。
const QUOTE_RE = /[「“"]([^「」“”"]{2,120})[」”"]/g
// 时间轴段：[00.0-03.0s]，0.1 秒精度
const SEG_RE = /\[(\d{1,2})\.(\d)\s*[-–—~至到]\s*(\d{1,2})\.(\d)\s*s\]/g

function extractQuotes(text) {
  const list = []
  let m
  QUOTE_RE.lastIndex = 0
  while ((m = QUOTE_RE.exec(text))) list.push(m[1].trim())
  return list
}

function countSeconds(text) {
  const m = text.match(/生成一段\s*(\d{1,2})\s*秒/)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------- 纯正文 txt（发给模型的那份）

export function checkRealmanPrompt(text, file = 'E01_prompt.txt') {
  const warnings = []
  const stats = {}
  const body = String(text || '').replace(/\r\n/g, '\n').trim()

  // —— 纯净性（机械事故：cat 出来的就是发给模型的一切，混入任何别的都是事故）
  stats.字数 = body.length
  if (!/^生成一段/.test(body)) push(warnings, 'error', '正文必须以「生成一段…」开头——这份 txt 是直接喂给模型的，混入了标题/文档头')
  if (/^#{1,6}\s/m.test(body)) push(warnings, 'error', '正文里有 Markdown 标题——.txt 只能是纯提示词正文')
  if (/^---+\s*$/m.test(body)) push(warnings, 'error', '正文里有「---」分隔线——存档版的分隔符不要带进 .txt')
  if (/【连续性】|【一致性】|【参考】|台词表|检查记录|尾帧描述|生成配置|弧线：/.test(body)) push(warnings, 'error', '正文里混入了存档版文档头元素（台词表/检查记录/尾帧描述/【参考】段…）——这些只进 .md，喂给模型就是事故')
  if (/@图片|@\s*图片/.test(body)) push(warnings, 'error', '正文里有 @图片 引用——真人感的参考图由工具走 CLI --ref 挂节点，写进正文会当成画面描述')

  // —— 时间轴格式（机械事故：解析不了就没法和 --duration 对上）
  stats.秒数 = countSeconds(body) || 0
  const segs = []
  let m
  SEG_RE.lastIndex = 0
  while ((m = SEG_RE.exec(body))) segs.push({ start: Number(`${m[1]}.${m[2]}`), end: Number(`${m[3]}.${m[4]}`) })
  stats.时间轴段 = segs.length
  if (stats.秒数) {
    if (!segs.length) push(warnings, 'error', '没有解析到任何 [00.0-03.0s] 时间轴段——分镜的时间轴骨架缺失')
    else {
      if (segs[0].start !== 0) push(warnings, 'warn', `第一段从 ${segs[0].start}s 开始，应从 00.0s 起`)
      const gaps = []
      for (let i = 1; i < segs.length; i += 1) {
        if (Math.abs(segs[i].start - segs[i - 1].end) > 0.11) gaps.push(`第${i}段结束 ${segs[i - 1].end}s ≠ 第${i + 1}段开始 ${segs[i].start}s`)
      }
      if (gaps.length) push(warnings, 'warn', `时间轴不连续：${gaps.join('；')}`)
      if (Math.abs(segs[segs.length - 1].end - stats.秒数) > 0.11) push(warnings, 'warn', `时间轴收在 ${segs[segs.length - 1].end}s，与「生成一段${stats.秒数}秒」不符（CLI 会按声明的秒数出片）`)
    }
  }
  const looseSegs = (body.match(/\[\s*\d{1,2}\s*[-–—~至到]\s*\d{1,2}\s*(?:秒|s\b)\s*\]/g) || []).filter((s) => !/\.\d/.test(s))
  if (looseSegs.length) push(warnings, 'warn', `有 ${looseSegs.length} 处时间轴没写 0.1 秒精度（如 [0-3秒]）——格式为 [00.0-03.0s]`)

  // —— 对白红线（机械事故：防全哑 + 台词重复）
  const soundIdx = body.indexOf('【声音】')
  const timeline = soundIdx >= 0 ? body.slice(0, soundIdx) : body
  const sound = soundIdx >= 0 ? body.slice(soundIdx) : ''
  const timelineQuotes = extractQuotes(timeline)
  const uniqueQuotes = [...new Set(timelineQuotes)]
  if (!sound) {
    push(warnings, 'error', '缺【声音】段——Seedance 靠这段的统一声明出语音口型，没有它成片全哑')
  } else {
    if (!/口型/.test(sound)) push(warnings, 'error', '【声音】段没有「口型」声明——必须统一写一句「对白均由本人同期开口说出、口型与台词同步」之类的声明，否则可能全哑')
    const soundQuotes = extractQuotes(sound)
    // 声音段抄台词=error；但「在他说"工具箱"时」这类短词话题引用不算抄写：
    // 只有与时间轴台词完全相同、或重叠达 10 字以上才算把台词抄了第二遍。
    const copied = soundQuotes.filter((q) => uniqueQuotes.some((t) => {
      if (q === t) return true
      const overlap = t.includes(q) || q.includes(t)
      return overlap && Math.min(q.length, t.length) >= 10
    }))
    if (copied.length) push(warnings, 'error', `【声音】段把台词抄了第二遍（${copied.length} 句，如「${copied[0].slice(0, 20)}…」）——台词只在说话那一刻写一次，声音段只做统一声明（skill 血案红线）`)
    if (!/无旁白|没有旁白/.test(sound) || !/无字幕|没有字幕/.test(sound) || !/无水印|没有水印/.test(sound)) {
      push(warnings, 'warn', '【声音】段结尾没写全「无旁白、无字幕、无水印」——缺哪个模型就可能生成哪个')
    }
  }
  stats.引号句数 = timelineQuotes.length
  for (const q of uniqueQuotes) {
    const times = timelineQuotes.filter((x) => x === q).length
    if (times > 1) push(warnings, 'error', `同一句引号内容出现了 ${times} 次：「${q.slice(0, 24)}…」——台词逐字只写在说话那一刻（血案红线），同一信息只写一次`)
  }
  // 15 秒语音物理上限：中文口播约 3.5 字/秒，超了念不完
  const spokenChars = uniqueQuotes.join('').length
  stats.引号总字数 = spokenChars
  if (stats.秒数 === 15 && spokenChars > 70) push(warnings, 'warn', `引号内容共 ${spokenChars} 字——15 秒念不完（约 30-50 字）`)

  return { kind: 'prompt', file, ok: !warnings.some((w) => w.severity === 'error'), stats, warnings }
}

// ---------------------------------------------------------------- 剧本（skill 声明的产出格式约定）

export function checkScript(text, file = '剧本.md') {
  const warnings = []
  const stats = {}
  stats.镜头行 = (text.match(/^△\s*\S/gm) || []).length
  stats.场景切分 = (text.match(/\d+\s*-\s*\d+\s*[日夜昼夜]\s*[内外]/g) || []).length
  stats.情绪对白 = (text.match(/^[\u4e00-\u9fa5A-Za-z0-9·]{1,12}（[^）]{1,16}）：\S/gm) || []).length

  if (!stats.镜头行) push(warnings, 'warn', '整篇没有以「△ 」开头的镜头行——skill 的剧本正文格式是每个镜头以 △ 开头（文学剧本也能用，但下游分镜对不上格式）')
  if (stats.镜头行 && !stats.场景切分) push(warnings, 'warn', '没有场景切分行——约定写在集号下（X-X 日/夜 内/外 场景名，列道具与出场人物）')
  if (!stats.情绪对白 && !/[：:]/.test(text)) push(warnings, 'warn', '没有任何对白——约定格式为「角色名（情绪）：台词」')

  return { kind: 'script', file, ok: !warnings.some((w) => w.severity === 'error'), stats, warnings }
}

// ---------------------------------------------------------------- 资产提示词（skill 声明的产出格式约定）

// 兼容 `### C01 — 费曼·正面全身` 标题 + 下附提示词块的写法（realman 示例即此格式）
export function parseAssets(text) {
  const assets = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^#{2,5}\s*\[?([CSP]\d{1,2})[a-z]?\]?\s*[—–-]\s*(.+)$/)
    if (!m) continue
    const promptLines = []
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,5}\s/.test(lines[j]) || /^#{0,5}\s*-{3,}\s*$/.test(lines[j])) break
      if (lines[j].trim()) promptLines.push(lines[j].trim())
    }
    assets.push({ id: m[1], name: m[2].trim(), prompt: promptLines.join('\n') })
  }
  return assets
}

export function checkAssets(text, file = '资产提示词.md') {
  const warnings = []
  const assets = parseAssets(text)
  const stats = { 资产总数: assets.length }
  for (const prefix of ['C', 'S', 'P']) stats[`${prefix}类`] = assets.filter((a) => a.id.startsWith(prefix)).length

  if (!assets.length) {
    push(warnings, 'error', '没有解析到任何 C/S/P 编号资产——约定格式为「### C01 — 名称 + 提示词块」')
    return { kind: 'assets', file, ok: false, stats, warnings }
  }
  for (const prefix of ['C', 'S', 'P']) {
    const noPrompt = assets.filter((a) => a.id.startsWith(prefix) && a.prompt.length < 20)
    if (noPrompt.length) push(warnings, 'error', `这些 ${prefix} 类资产缺提示词（<20 字）：${noPrompt.map((a) => a.id).join('、')}`)
  }
  // 只查「缺了参考图就失效」的硬要求：角色全身+纯白底（否则视频换脸）、场景/道具无人物（否则参考污染）。
  // 其余真人感细节由 skill 指导 LLM 写，程序不评判。
  const characters = assets.filter((a) => a.id.startsWith('C') && a.prompt.length >= 20)
  const noLock = characters.filter((a) => !/全身|从头到脚|full body/i.test(a.prompt) || !/纯白背景|白底|white background/i.test(a.prompt))
  if (characters.length && noLock.length) push(warnings, 'warn', `这些角色资产没写全「全身 + 纯白背景」（锁形象用，缺了视频阶段容易换脸）：${noLock.map((a) => a.id).join('、')}`)
  const scenes = assets.filter((a) => a.id.startsWith('S') && a.prompt.length >= 20)
  const scenePeople = scenes.filter((a) => /人物|person|character/i.test(a.prompt) && !/没有.{0,6}人物|无人物|不见人物|no person/i.test(a.prompt))
  if (scenePeople.length) push(warnings, 'warn', `场景资产提示词里出现「人物」又没声明无人——场景参考图必须没有任何人物：${scenePeople.map((a) => a.id).join('、')}`)
  const props = assets.filter((a) => a.id.startsWith('P') && a.prompt.length >= 20)
  const propPeople = props.filter((a) => /人物|person|character/i.test(a.prompt) && !/没有.{0,6}人物|无人物|不见人物/i.test(a.prompt))
  if (propPeople.length) push(warnings, 'warn', `道具提示词里出现「人物」——道具参考图要单独展示、不含任何人物：${propPeople.map((a) => a.id).join('、')}`)

  return { kind: 'assets', file, ok: !warnings.some((w) => w.severity === 'error'), stats, warnings }
}

// ---------------------------------------------------------------- 存档 md（给人看的版本：文档头 + --- + 正文）

export function checkRealmanArchive(text, file = 'E01_分镜提示词.md') {
  const warnings = []
  const stats = {}
  const body = String(text || '').replace(/\r\n/g, '\n')

  const sepMatch = body.match(/^---+\s*$/m)
  const sepIdx = sepMatch ? body.indexOf(sepMatch[0]) : -1
  const head = sepIdx >= 0 ? body.slice(0, sepIdx) : body
  const promptBody = sepIdx >= 0 ? body.slice(body.indexOf('\n', sepIdx) + 1) : ''
  stats.文档头有弧线 = /弧线[：:]/.test(head) ? 1 : 0
  stats.文档头有台词表 = /台词表/.test(head) ? 1 : 0
  stats.文档头有检查记录 = /检查记录/.test(head) ? 1 : 0
  stats.文档头有尾帧 = /尾帧/.test(head) ? 1 : 0

  if (sepIdx < 0) push(warnings, 'warn', '没有「---」分隔线——存档版约定是文档头（弧线/台词表/检查记录/尾帧描述）+ --- + 纯正文')
  if (promptBody.trim() && !/^生成一段/.test(promptBody.trim())) push(warnings, 'warn', '「---」之后的正文不是以「生成一段」开头——分隔线后面应该直接是发给模型的纯正文')
  if (!promptBody.trim()) push(warnings, 'error', '「---」之后没有正文——存档版必须包含可导出的纯正文')

  // 正文部分复用纯正文检查
  if (promptBody.trim()) {
    const inner = checkRealmanPrompt(promptBody, `${file} · 正文`)
    warnings.push(...inner.warnings)
    stats.正文 = inner.stats
  }

  return { kind: 'storyboard', file, ok: !warnings.some((w) => w.severity === 'error'), stats, warnings }
}

// txt ↔ md 正文一致性：发给模型的是 txt，两份不同步=发错版本
export function checkPromptSync(promptText, archiveText) {
  const normalize = (t) => String(t || '').replace(/\r\n/g, '\n').trim()
  const p = normalize(promptText)
  const a = normalize(archiveText)
  const sepMatch = a.match(/^---+\s*$/m)
  if (!sepMatch) return { synced: null, message: '存档版没有「---」分隔线，无法比对正文' }
  const md = a.slice(a.indexOf('\n', a.indexOf(sepMatch[0])) + 1).trim()
  if (!p || !md) return { synced: null, message: '有一份是空的' }
  if (p === md) return { synced: true, message: 'txt 与存档 md 正文逐字一致' }
  return { synced: false, message: 'txt 与存档 md 的正文不一致——改了正文要重新导出 .txt（发给模型的是 .txt）' }
}

// ---------------------------------------------------------------- 文件发现（真人感约定命名）

// 项目目录里的约定文件：*剧本*.md / *资产提示词*.md|*素材清单*.md / E??_prompt.txt / *分镜提示词*.md
// 排除「使用指南 / README / 好剧本」这类方法论文档。
export function discoverFiles(dir) {
  let names = []
  try { names = readdirSync(dir) } catch { return {} }
  const md = names.filter((n) => n.endsWith('.md') && !n.startsWith('使用指南') && !n.startsWith('README') && !n.startsWith('好剧本'))
  const rank = (n) => (/完整版/.test(n) ? 1 : 0)
  const pick = (re) => md.filter((n) => re.test(n)).sort((a, b) => rank(a) - rank(b) || a.length - b.length)
  const prompts = names.filter((n) => /^E\d{1,3}_prompt\.txt$/i.test(n)).sort()
  return {
    scripts: pick(/剧本/),
    assets: pick(/资产提示词|素材清单/),
    prompts,
    storyboards: pick(/分镜提示词|分镜/)
  }
}

// 便捷读文件（tools.js 的 realman_check 用）
export function readText(file) {
  return readFileSync(file, 'utf8')
}
