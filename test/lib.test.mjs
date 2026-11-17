// 数据层与机械安检内核单测（离线，零依赖）。
// 运行：node test/lib.test.mjs  （Windows 下比 node --test 更稳，无 async 资源误报）
// 另有一组「金标准」用例：直接跑随包 skill 的费曼示例，安检不应对它报 error。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rms-test-'))

const { checkAssets, checkPromptSync, checkRealmanArchive, checkRealmanPrompt, checkScript, discoverFiles, parseAssets } = await import('../lib/check.js')
const { initProject, readProject, updateProject, listProjects, projectSummary, resolveDir, ProjectError, DEFAULT_STYLE, DEFAULT_VIDEO_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION } = await import('../lib/project.js')
const { readHistory, recordGeneration, filterHistory, summarize, clearHistory, normalizePath } = await import('../lib/history.js')

const EXAMPLE_DIR = fileURLToPath(new URL('../skills/seedance-storyboard-generator-realman/example/', import.meta.url))

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

// ---------------------------------------------------------------- check.js · 剧本

test('checkScript：真人感剧本（△行+场景切分+情绪对白）通过', () => {
  const text = [
    '# 《自检》剧本', '## 第一集 推门', '', '1-1 日 内 大学黑板教室', '道具：长黑板、粉笔', '出场人物：费曼', '',
    '△ 特写：空黑板上的一道算式，粉笔灰浮动。', '△ 中景：门被推开，年轻人走进教室。', '费曼（轻声）：让我试试。',
    '△ 近景：他站定黑板前，抬头看那道算式。', '△ 【空镜】粉笔灰缓缓落下。'
  ].join('\n')
  const r = checkScript(text, '剧本.md')
  assert.equal(r.ok, true)
  assert.equal(r.stats.镜头行, 4)
  assert.equal(r.stats.场景切分, 1)
  assert.equal(r.stats.情绪对白, 1)
})

test('checkScript：缺 △ 行/场景切分/对白给 warn（格式约定，不硬拦）', () => {
  const r = checkScript('他走进教室。他很紧张。', '剧本.md')
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.message.includes('△')))
  assert.ok(r.warnings.some((w) => w.message.includes('对白')))
})

// ---------------------------------------------------------------- check.js · 资产

test('parseAssets：解析 ### C01 — 写法（含 C01b 变体）', () => {
  const a = parseAssets(['### C01 — 费曼·正面全身', '真人实拍质感 prompt 一段', '', '### C01b — 费曼·四视图', '四视图 prompt', '', '### S01 — 教室·正打', '场景 prompt'].join('\n'))
  assert.deepEqual(a.map((x) => x.id), ['C01', 'C01', 'S01'])
  assert.ok(a[0].prompt.includes('真人实拍'))
})

test('checkAssets：缺提示词 error；缺全身/纯白底 warn；场景带人 warn', () => {
  const text = [
    '### C01 — 甲', '真人实拍质感，35毫米胶片观感，半身构图，灰色墙面为底',
    '### C02 — 乙', '',
    '### S01 — 教室', '真人实拍质感，35毫米胶片观感，教室场景，画面中站着几个人物听课',
    '### P01 — 粉笔', '真人实拍质感，特写画面，一个人物手持白色粉笔'
  ].join('\n')
  const r = checkAssets(text, '资产提示词.md')
  assert.equal(r.ok, false) // C02 无提示词
  assert.ok(r.warnings.some((w) => w.message.includes('C01') && w.message.includes('全身')))
  assert.ok(r.warnings.some((w) => w.message.includes('S01') && w.message.includes('人物')))
  assert.ok(r.warnings.some((w) => w.message.includes('P01') && w.message.includes('人物')))
})

test('checkAssets：合规清单通过且统计正确', () => {
  const text = [
    '### C01 — 年轻学者·正面全身', '真人实拍质感，全身站立正面，从头到脚完整入镜，纯白背景',
    '### S01 — 教室·正打', '真人实拍质感，大学教室，画面中没有任何人物',
    '### P01 — 粉笔', '纯白背景，单独展示一截使用过的白色粉笔，断裂边缘有粉笔灰，无人物'
  ].join('\n')
  const r = checkAssets(text, '资产提示词.md')
  assert.equal(r.ok, true)
  assert.equal(r.stats['C类'], 1)
  assert.equal(r.stats['S类'], 1)
  assert.equal(r.stats['P类'], 1)
})

// ---------------------------------------------------------------- check.js · 纯正文 txt

const GOOD_PROMPT = [
  '生成一段15秒的学术悬疑短片，16:9横屏，真人实拍质感，35毫米胶片摄影观感。故事围绕空教室里的一道算式展开：从空无一人的黑板，到门被推开，最后停在他落笔的侧脸。', '',
  '【镜头与时间轴】',
  '[00.0-03.0s] 特写空黑板上的一道算式，粉笔灰在光柱里浮动。', '',
  '[03.0-06.0s] 中景：门被推开，年轻人走进教室，脚步落在旧木地板上。', '',
  '[06.0-09.0s] 近景：他站定黑板前，嘴部清楚。他轻声说："让我试试。"', '',
  '[09.0-12.0s] 特写粉笔接触黑板，划出第一道线。', '',
  '[12.0-15.0s] 中景缓缓前推，停在他落笔的侧脸上。', '',
  '【声音】开场是空教室的安静与日光灯的细微嗡鸣；推门声与脚步声贴着画面出现；他开口那句由本人同期说出、口型与台词同步、声线清晰；粉笔触板声干净利落。无配乐。无旁白、无字幕、无水印。'
].join('\n')

test('checkRealmanPrompt：合规纯正文通过，时间轴解析 5 段', () => {
  const r = checkRealmanPrompt(GOOD_PROMPT, 'E01_prompt.txt')
  assert.equal(r.ok, true)
  assert.equal(r.stats.时间轴段, 5)
  assert.equal(r.stats.秒数, 15)
  assert.equal(r.stats.引号句数, 1)
})

test('checkRealmanPrompt：纯净性破坏报 error', () => {
  const cases = [
    ['不是「生成一段」开头', checkRealmanPrompt('标题：E01\n生成一段15秒的短片')],
    ['markdown 标题', checkRealmanPrompt('# E01\n生成一段15秒的短片')],
    ['--- 分隔线', checkRealmanPrompt('生成一段15秒的短片\n---\n正文')],
    ['文档头元素混入', checkRealmanPrompt('生成一段15秒的短片\n台词表：略\n【声音】口型同步。')],
    ['@图片 引用', checkRealmanPrompt('生成一段15秒的短片。@图片1 是主角参考。【声音】口型同步。无旁白、无字幕、无水印。')]
  ]
  for (const [name, r] of cases) {
    assert.ok(r.warnings.some((w) => w.severity === 'error'), `应报 error：${name}`)
  }
})

test('checkRealmanPrompt：防全哑红线（缺【声音】/缺口型声明）报 error', () => {
  const noSound = checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他走向黑板。')
  assert.ok(noSound.warnings.some((w) => w.severity === 'error' && w.message.includes('【声音】')))
  const noLip = checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他走向黑板。【声音】教室安静。无旁白、无字幕、无水印。')
  assert.ok(noLip.warnings.some((w) => w.severity === 'error' && w.message.includes('口型')))
})

test('checkRealmanPrompt：台词重复抄第二遍报 error', () => {
  const dup = checkRealmanPrompt('生成一段15秒的短片。他说："让我试试。"\n【声音】他说："让我试试。"口型同步。无旁白、无字幕、无水印。')
  assert.ok(dup.warnings.some((w) => w.severity === 'error' && w.message.includes('抄了第二遍')))
  const twice = checkRealmanPrompt('生成一段15秒的短片。他说："让我试试。"他又说："让我试试。"【声音】口型同步。无旁白、无字幕、无水印。')
  assert.ok(twice.warnings.some((w) => w.severity === 'error' && w.message.includes('2 次')))
  // 声音段短词话题引用（如 在他说"工具箱"时）不算抄写
  const topic = checkRealmanPrompt('生成一段15秒的短片。[00.0-15.0s] 他说："因为我脑子里的工具箱，跟你们不是一套。"【声音】在费曼坦白"工具箱"时添进一缕弦乐，口型同步。无旁白、无字幕、无水印。')
  assert.equal(topic.ok, true, JSON.stringify(topic.warnings.filter((w) => w.severity === 'error')))
})

test('checkRealmanPrompt：时间轴问题分级（缺骨架=error，不连续/不符=warn）', () => {
  const missing = checkRealmanPrompt('生成一段15秒的短片。他走向黑板。【声音】口型同步。无旁白、无字幕、无水印。')
  assert.ok(missing.warnings.some((w) => w.severity === 'error' && w.message.includes('时间轴')))
  const mismatch = checkRealmanPrompt('生成一段15秒的短片。[00.0-09.0s] 他走向黑板。【声音】口型同步。无旁白、无字幕、无水印。')
  assert.equal(mismatch.ok, true)
  assert.ok(mismatch.warnings.some((w) => w.severity === 'warn' && w.message.includes('不符')))
  const gap = checkRealmanPrompt('生成一段15秒的短片。[00.0-06.0s] 他走向黑板。[09.0-15.0s] 他提笔写字。【声音】口型同步。无旁白、无字幕、无水印。')
  assert.ok(gap.warnings.some((w) => w.severity === 'warn' && w.message.includes('不连续')))
})

test('checkRealmanPrompt：15 秒台词超量 warn；三件套缺失 warn', () => {
  const longLine = '这是一句特别长的台词用来撑字数'.repeat(5)
  const r = checkRealmanPrompt(`生成一段15秒的短片。他说："${longLine}"【声音】口型同步。`)
  assert.ok(r.warnings.some((w) => w.severity === 'warn' && w.message.includes('念不完')))
  const r2 = checkRealmanPrompt('生成一段15秒的短片。【声音】口型同步、同期声。')
  assert.ok(r2.warnings.some((w) => w.severity === 'warn' && w.message.includes('无旁白')))
})

// ---------------------------------------------------------------- check.js · 存档 md + 一致性

const GOOD_ARCHIVE = [
  '# E01《推门》· 分镜提示词（存档版）', '',
  '- 弧线：从空无一人的黑板，到门被推开，最后停在他落笔的侧脸。',
  '- 台词表：费曼（轻声）：让我试试。',
  '- 检查记录：口型声明✓ 台词一次✓ 时间轴连续✓',
  '- 尾帧描述：他落笔的侧脸近景。', '',
  '---', '',
  GOOD_PROMPT
].join('\n')

test('checkRealmanArchive：文档头四件套 + 正文复检通过', () => {
  const r = checkRealmanArchive(GOOD_ARCHIVE, 'E01_分镜提示词.md')
  assert.equal(r.ok, true)
  assert.equal(r.stats.文档头有弧线, 1)
  assert.equal(r.stats.文档头有台词表, 1)
  assert.equal(r.stats.文档头有检查记录, 1)
  assert.equal(r.stats.文档头有尾帧, 1)
})

test('checkRealmanArchive：--- 后无正文报 error', () => {
  const r = checkRealmanArchive(['# E01', '- 弧线：x', '- 台词表：y', '', '---'].join('\n'), 'E01_分镜提示词.md')
  assert.equal(r.ok, false)
  assert.ok(r.warnings.some((w) => w.severity === 'error' && w.message.includes('正文')))
})

test('checkPromptSync：一致/不一致/无分隔线', () => {
  assert.equal(checkPromptSync(GOOD_PROMPT, GOOD_ARCHIVE).synced, true)
  const drift = checkPromptSync(GOOD_PROMPT + '\n多了半句', GOOD_ARCHIVE)
  assert.equal(drift.synced, false)
  assert.ok(drift.message.includes('重新导出'))
  assert.equal(checkPromptSync(GOOD_PROMPT, '# 没有分隔线的存档').synced, null)
})

// ---------------------------------------------------------------- check.js · 文件发现

test('discoverFiles：真人感约定命名四类发现，排除使用指南', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rms-files-'))
  writeFileSync(join(dir, '不一样的工具箱_剧本.md'), 'x')
  writeFileSync(join(dir, '资产提示词.md'), 'x')
  writeFileSync(join(dir, 'E01_prompt.txt'), 'x')
  writeFileSync(join(dir, 'E01_分镜提示词.md'), 'x')
  writeFileSync(join(dir, 'E02_prompt.txt'), 'x')
  writeFileSync(join(dir, '使用指南.md'), 'x')
  const f = discoverFiles(dir)
  assert.equal(f.scripts.length, 1)
  assert.equal(f.assets.length, 1)
  assert.deepEqual(f.prompts, ['E01_prompt.txt', 'E02_prompt.txt'])
  assert.equal(f.storyboards.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 金标准：费曼示例全过

test('金标准：费曼示例五集纯正文 txt 零 error', () => {
  for (let i = 1; i <= 5; i += 1) {
    const id = `E${String(i).padStart(2, '0')}`
    const text = readFileSync(join(EXAMPLE_DIR, `${id}_prompt.txt`), 'utf8')
    const r = checkRealmanPrompt(text, `${id}_prompt.txt`)
    assert.equal(r.ok, true, `${id} 报了 error：${JSON.stringify(r.warnings.filter((w) => w.severity === 'error'))}`)
    assert.equal(r.stats.时间轴段 >= 4, true, `${id} 时间轴段异常：${r.stats.时间轴段}`)
  }
})

test('金标准：费曼示例存档 md 通过且与 txt 逐字一致', () => {
  for (let i = 1; i <= 5; i += 1) {
    const id = `E${String(i).padStart(2, '0')}`
    const md = readFileSync(join(EXAMPLE_DIR, `${id}_分镜提示词.md`), 'utf8')
    const txt = readFileSync(join(EXAMPLE_DIR, `${id}_prompt.txt`), 'utf8')
    const r = checkRealmanArchive(md, `${id}_分镜提示词.md`)
    assert.equal(r.ok, true, `${id} 存档报了 error：${JSON.stringify(r.warnings.filter((w) => w.severity === 'error'))}`)
    assert.equal(checkPromptSync(txt, md).synced, true, `${id} txt↔md 不一致`)
  }
})

test('金标准：费曼示例剧本与资产提示词通过', () => {
  const script = checkScript(readFileSync(join(EXAMPLE_DIR, '剧本_费曼.md'), 'utf8'), '剧本_费曼.md')
  assert.equal(script.ok, true)
  assert.ok(script.stats.镜头行 >= 20, `镜头行=${script.stats.镜头行}`)
  const assets = checkAssets(readFileSync(join(EXAMPLE_DIR, '资产提示词.md'), 'utf8'), '资产提示词.md')
  assert.equal(assets.ok, true, JSON.stringify(assets.warnings.filter((w) => w.severity === 'error')))
  assert.equal(assets.stats['C类'] >= 2, true)
  assert.equal(assets.stats['S类'] >= 1, true)
})

// ---------------------------------------------------------------- project.js

const ROOT = mkdtempSync(join(tmpdir(), 'rms-proj-'))

test('initProject：真人感默认（风格/模型/分辨率/双文件名）落盘', () => {
  const dir = join(ROOT, '不一样的工具箱')
  const p = initProject({ path: dir, title: '不一样的工具箱', aspect: '16:9', episodes: 3, tone: '智性悬疑', hook: '换个工具看题', paletteZh: '暖褐、烟灰' })
  assert.equal(p.style.description, DEFAULT_STYLE)
  assert.equal(p.video.model, DEFAULT_VIDEO_MODEL)
  assert.equal(p.image.model, DEFAULT_IMAGE_MODEL)
  assert.equal(p.video.resolution, DEFAULT_RESOLUTION)
  assert.equal(DEFAULT_VIDEO_MODEL, 'seedance_2.5_flash')
  assert.equal(DEFAULT_IMAGE_MODEL, 'seedream_5.5')
  assert.equal(DEFAULT_RESOLUTION, '480p')
  assert.equal(p.episodes[0].storyboard, 'E01_分镜提示词.md')
  assert.equal(p.episodes[0].promptFile, 'E01_prompt.txt')
  assert.equal(readProject(dir).video.model, 'seedance_2.5_flash')
  // 重复 init 要拒绝
  assert.throws(() => initProject({ path: dir }), ProjectError)
})

test('updateProject：数组和浅合并语义', () => {
  const dir = join(ROOT, '不一样的工具箱')
  updateProject(dir, { assets: [{ id: 'C01', name: '年轻学者', prompt: '真人实拍质感 全身 纯白背景' }] })
  updateProject(dir, { style: { tone: '温暖收束' }, title: '不一样的工具箱·完整版' })
  const p = readProject(dir)
  assert.equal(p.style.tone, '温暖收束')
  assert.equal(p.style.description, DEFAULT_STYLE) // 浅合并不丢
  assert.equal(p.assets.length, 1)
})

test('projectSummary：暴露 styleDescription/tone/hook', () => {
  const s = projectSummary(join(ROOT, '不一样的工具箱'))
  assert.equal(s.styleDescription, DEFAULT_STYLE)
  assert.equal(s.tone, '温暖收束')
  assert.equal(s.hook, '换个工具看题')
  assert.equal(s.episodes, 3)
})

test('listProjects：扫到项目且按更新时间排序', () => {
  const list = listProjects(ROOT)
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '不一样的工具箱·完整版')
})

test('resolveDir：拒绝相对路径与盘根', () => {
  assert.throws(() => resolveDir('relative/path'), ProjectError)
  assert.throws(() => resolveDir('D:\\'), ProjectError)
})

// ---------------------------------------------------------------- history.js

test('recordGeneration + filterHistory + summarize + clearHistory', () => {
  recordGeneration({ kind: 'asset', project: 'D:\\x\\a', projectTitle: 'A', status: 'ok', summary: '2 张', credits: 6 })
  recordGeneration({ kind: 'episode', project: 'D:\\x\\a', projectTitle: 'A', status: 'failed', summary: 'E01 失败', error: '报价超限' })
  recordGeneration({ kind: 'asset', project: 'D:\\x\\b', projectTitle: 'B', status: 'ok', summary: '1 张', credits: 3 })
  assert.equal(readHistory().length, 3)
  assert.equal(filterHistory(readHistory(), { project: 'D:/X/A/' }).length, 2) // 大小写与斜杠归一
  assert.equal(filterHistory(readHistory(), { kind: 'asset', status: 'ok' }).length, 2)
  assert.equal(filterHistory(readHistory(), { q: 'E01' }).length, 1)
  const s = summarize(readHistory())
  assert.equal(s.total, 3)
  assert.equal(s.credits, 9)
  assert.equal(s.failed, 1)
  assert.equal(clearHistory({ project: 'D:\\x\\a' }), 2)
  assert.equal(readHistory().length, 1)
})

test('normalizePath：Windows 大小写/斜杠归一', () => {
  assert.equal(normalizePath('D:/X/a'), normalizePath('d:\\x\\a'))
})

process.stdout.write(`\n${passed} 个单测全部通过\n`)
