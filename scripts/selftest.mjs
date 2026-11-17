// 本地自检：不建节点、不花积分，只验证数据层、realman_check 机械安检内核、官方 CLI 探活和 ffmpeg 拼接。
// 运行：node scripts/selftest.mjs [自检根目录]
// 默认落在系统临时目录，避免每次都在工作区里留一个样片工程。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concatEpisodes, probeDuration, resolveFfmpeg } from '../lib/ffmpeg.js'
import { authAccount, authStatus, resolveCli } from '../lib/dreamina.js'
import { checkAssets, checkPromptSync, checkRealmanArchive, checkRealmanPrompt, checkScript, discoverFiles } from '../lib/check.js'
import { fileSummary, initProject, listProjects, readProject, updateProject } from '../lib/project.js'

const ROOT = process.argv[2] || join(tmpdir(), 'dsh-realman-studio-selftest')
const dir = join(ROOT, '样片')

function step(name, fn) {
  process.stdout.write(`- ${name} … `)
  try {
    const value = fn()
    console.log('ok')
    return value
  } catch (err) {
    console.log('失败')
    throw err
  }
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

const project = step('建项目（真人感默认）', () => initProject({
  path: dir,
  title: '自检样片',
  aspect: '16:9',
  episodes: 2,
  tone: '智性悬疑',
  hook: '题解不开，常常是手里只有一把锤子',
  paletteZh: '暖褐、烟灰、旧木色'
}))
if (project.style.description !== '真人实拍质感，35毫米胶片摄影观感') throw new Error(`默认风格不对：${project.style.description}`)
if (project.video.model !== 'seedance_2.5_flash' || project.video.resolution !== '480p') throw new Error('默认模型/分辨率不对')

step('登记资产与分集（含 promptFile）', () => updateProject(dir, {
  assets: [
    { id: 'C01', kind: 'character', name: '年轻学者·正面全身', ratio: '3:4', prompt: '真人实拍质感，全身站立正面，从头到脚完整入镜，纯白背景，皮肤有毛孔与细小瑕疵' },
    { id: 'S01', kind: 'scene', name: '黑板教室·正打', ratio: '16:9', prompt: '真人实拍质感，大学黑板教室，午后高窗暖光，画面中没有任何人物' }
  ],
  episodes: project.episodes.map((e, i) => ({ ...e, refs: i === 0 ? ['C01', 'S01'] : ['C01', 'S01', 'E01'] }))
}))

const reread = step('读回 project.json', () => readProject(dir))
if (reread.style.hook !== '题解不开，常常是手里只有一把锤子') throw new Error('风格字段没读回来')
if (reread.episodes[1].refs[2] !== 'E01') throw new Error('接力 refs 没读回来')
const summary = fileSummary(dir, reread)
console.log(`  → ${reread.title}，资产 ${summary.assets.length}，集 ${summary.episodes.length}`)

// realman_check 内核：写真人感约定命名的样例文档，验证发现与检查逻辑
step('写样例文档（剧本/资产提示词/纯正文txt/存档md）', () => {
  writeFileSync(join(dir, '剧本.md'), [
    '# 自检样片 - 剧本', '', '## 第一集 推门', '', '1-1 日 内 大学黑板教室', '道具：长黑板、粉笔', '出场人物：费曼', '',
    '△ 特写：空黑板上的一道算式，粉笔灰在光柱里浮动。', '△ 中景：门被推开，年轻人走进教室。', '费曼（轻声）：让我试试。',
    '△ 【空镜】黑板前的粉笔灰缓缓落下。'
  ].join('\n'))
  writeFileSync(join(dir, '资产提示词.md'), [
    '# 自检样片 · 资产提示词', '',
    '> 禁止直接使用真实人物的照片或名人面孔，以下均为虚构的相似气质演员。', '',
    '### C01 — 年轻学者·正面全身',
    '真人实拍质感，35毫米胶片观感。全身站立，正面视角，从头到脚完整入镜，成人七头身真实比例。二十出头年轻男性，皮肤有自然的毛孔与细小瑕疵，衬衫有穿着的褶皱。表情中性，双手自然垂落，不持任何物件，纯白背景。', '',
    '### S01 — 黑板教室·正打',
    '真人实拍质感。大学黑板教室，长黑板占画面一侧，午后高窗暖光，浮尘在光柱里浮动。画面中没有任何人物。', '',
    '### P01 — 粉笔',
    '纯白背景，单独展示一截使用过的白色粉笔，无人物无环境背景。'
  ].join('\n'))
  const promptBody = [
    '生成一段15秒的学术悬疑短片，16:9横屏，真人实拍质感，35毫米胶片摄影观感。故事围绕空教室里的一道算式与一个推门而入的年轻人展开：从空无一人的黑板，到门被推开，最后停在他落笔的侧脸。', '',
    '整体画面：低饱和的暖褐与旧木色，午后日光从高窗斜射进来，浮尘清晰可见；皮肤有毛孔与细小瑕疵，衬衫有穿着褶皱；细腻胶片颗粒，近景轻微手持呼吸感。', '',
    '人物与空间：年轻学者二十出头，瘦高，浅色旧衬衫挽着袖口，从画面右侧的门走进，走向画面左侧的长黑板；黑板与课桌之间留出通道，中间没有别人。', '',
    '【镜头与时间轴】',
    '[00.0-03.0s] 特写空黑板上的一道算式，粉笔灰在光柱里浮动，镜头纹丝不动。', '',
    '[03.0-06.0s] 承接浮尘，切到中景：门被推开，年轻人走进教室，脚步落在旧木地板上。', '',
    '[06.0-09.0s] 近景：他站定黑板前，抬头看那道算式，嘴部清楚。他轻声说："让我试试。"', '',
    '[09.0-12.0s] 特写粉笔接触黑板，划出第一道线，粉笔灰簌簌落下。', '',
    '[12.0-15.0s] 中景缓缓前推，停在他落笔的侧脸上，粉笔在指间转了半圈，没有切空镜。', '',
    '【声音】开场是空教室的安静与日光灯的细微嗡鸣；推门声与脚步声贴着画面出现；他开口那句由本人同期说出、口型与台词同步、声线清晰；粉笔触板声干净利落；收尾教室安静退回，远处走廊人声渐起。无配乐。无旁白、无字幕、无水印。'
  ].join('\n')
  writeFileSync(join(dir, 'E01_prompt.txt'), promptBody)
  writeFileSync(join(dir, 'E01_分镜提示词.md'), [
    '# E01《推门》· 分镜提示词（存档版）', '',
    '- 弧线：从空无一人的黑板，到门被推开，最后停在他落笔的侧脸。',
    '- 台词表：费曼（轻声）：让我试试。',
    '- 检查记录：口型声明✓ 台词一次✓ 时间轴 00.0-15.0 连续✓ 纯净正文✓',
    '- 尾帧描述：他落笔的侧脸近景，粉笔灰未落，日光从右后高窗来。', '',
    '---', '',
    promptBody
  ].join('\n'))
})

step('realman_check 内核自检（正向样例应全过）', () => {
  const files = discoverFiles(dir)
  if (!files.scripts.length || !files.assets.length || !files.prompts.length || !files.storyboards.length) {
    throw new Error(`文件发现不全：${JSON.stringify(files)}`)
  }
  const script = checkScript(readFileSync(join(dir, files.scripts[0]), 'utf8'), files.scripts[0])
  const assets = checkAssets(readFileSync(join(dir, files.assets[0]), 'utf8'), files.assets[0])
  const prompt = checkRealmanPrompt(readFileSync(join(dir, files.prompts[0]), 'utf8'), files.prompts[0])
  const archive = checkRealmanArchive(readFileSync(join(dir, files.storyboards[0]), 'utf8'), files.storyboards[0])
  const sync = checkPromptSync(readFileSync(join(dir, files.prompts[0]), 'utf8'), readFileSync(join(dir, files.storyboards[0]), 'utf8'))
  const bad = { script: script.warnings, assets: assets.warnings, prompt: prompt.warnings, archive: archive.warnings, sync }
  if (!script.ok || !assets.ok || !prompt.ok || !archive.ok) throw new Error(`样例没过安检：${JSON.stringify(bad)}`)
  if (!sync.synced) throw new Error(`txt↔md 应一致：${sync.message}`)
  if (prompt.stats.时间轴段 !== 5) throw new Error(`时间轴应解析出 5 段：${prompt.stats.时间轴段}`)
  return { warns: [...script.warnings, ...assets.warnings, ...prompt.warnings, ...archive.warnings].length }
})

step('realman_check 反例拦截（机械事故必须报 error）', () => {
  const cases = [
    ['纯净性：markdown 标题混入', checkRealmanPrompt('# E01\n生成一段15秒的短片')],
    ['防全哑：缺【声音】段', checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他走向黑板。')],
    ['防全哑：【声音】无口型声明', checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他走向黑板。【声音】教室安静。无旁白、无字幕、无水印。')],
    ['台词重复抄第二遍', checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他说："让我试试。"【声音】他说："让我试试。"口型同步。无旁白、无字幕、无水印。')],
    ['文档头元素混入 txt', checkRealmanPrompt('生成一段15秒的短片\n弧线：从 A 到 B\n【声音】口型同步。无旁白、无字幕、无水印。')],
    ['时间轴骨架缺失', checkRealmanPrompt('生成一段15秒的短片。0-15秒他走向黑板。【声音】口型同步。无旁白、无字幕、无水印。')]
  ]
  const misses = cases.filter(([name, r]) => !r.warnings.some((w) => w.severity === 'error'))
  if (misses.length) throw new Error(`反例没被拦住：${misses.map(([n]) => n).join('、')}`)
  // 时间轴与声明秒数不符是 warn（提示修正，不当事故拦）
  const mismatch = checkRealmanPrompt('生成一段15秒的短片。[00.0-09.0s] 他走向黑板。【声音】口型同步。无旁白、无字幕、无水印。')
  if (!mismatch.warnings.some((w) => w.severity === 'warn' && w.message.includes('不符'))) throw new Error('时间轴与声明秒数不符没提示')
  // 资产反例：角色缺全身+纯白底 → warn（不阻塞但要点名）
  const noLock = checkAssets('### C01 — 某角色\n真人实拍质感，35毫米胶片观感，一个穿西装的男人，半身构图，灰色墙面为底。')
  if (!noLock.warnings.some((w) => w.severity === 'warn' && w.message.includes('全身'))) throw new Error('缺全身/纯白底没提示')
  return cases.length + 2
})

step('列项目', () => {
  const list = listProjects(ROOT)
  if (!list.length) throw new Error('列表为空')
  return list
})

const cli = await (async () => {
  process.stdout.write('- 定位即梦官方 CLI … ')
  try {
    const c = await resolveCli()
    console.log(`ok（${c.bin}，v${c.version || '?'}）`)
    return c
  } catch (err) {
    console.log(`失败：${err.message}`)
    return null
  }
})()

try {
  const status = await authStatus()
  const account = status.loggedIn ? await authAccount().catch(() => null) : null
  console.log(`- 即梦账号：${status.loggedIn ? `已登录 ${account ? account.displayName : ''}，积分 ${account ? account.availableCredits : '?'}` : '未登录（生成前需要 auth login）'}`)
} catch (err) {
  console.log(`- 即梦账号：查询失败 — ${err.message}`)
}

process.stdout.write('- ffmpeg … ')
const ff = await resolveFfmpeg()
console.log(`ok（${ff.ffmpeg}）`)

const clips = ['videos/E01.mp4', 'videos/E02.mp4'].map((rel, i) => {
  const file = join(dir, rel)
  execFileSync(ff.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${i === 0 ? '0xc8332a' : '0x2f6f63'}:s=640x360:d=2`,
    '-pix_fmt', 'yuv420p', '-r', '24', file
  ])
  if (!existsSync(file)) throw new Error(`造样片失败：${file}`)
  return file
})
process.stdout.write('- 拼接 … ')
const out = join(dir, 'out', 'final.mp4')
const { bytes } = await concatEpisodes(clips, out)
const duration = await probeDuration(out)
console.log(`ok（${(bytes / 1024).toFixed(0)} KB，${duration}s）`)
if (!duration || duration < 3.5) throw new Error(`拼接结果时长异常：${duration}`)

writeFileSync(join(dir, 'out', 'selftest.json'), JSON.stringify({ ok: true, duration, cli: Boolean(cli) }, null, 2))
console.log(`\n全部通过。产物：${out}`)
