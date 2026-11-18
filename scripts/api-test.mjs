// 临时验收脚本：不连宿主，起一个本地 http 服务挂上 registerApi 的 handler，
// 用真实 fetch 打各个接口，检查 catalog / project / history / 静态页面 / 生成任务。
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:\\dsh-research\\.tmp\\realman-studio-api-test'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
process.env.DSH_HOME = join(ROOT, 'home')

const { initProject, updateProject } = await import('../lib/project.js')
const { registerApi } = await import('../lib/api.js')
const { readHistory } = await import('../lib/history.js')

const projectDir = join(ROOT, 'projects', '不一样的工具箱')
const project = initProject({ path: projectDir, title: '不一样的工具箱', aspect: '16:9', episodes: 2, resolution: '480p', paletteZh: '暖褐、烟灰、旧木色' })
updateProject(projectDir, {
  assets: [
    { id: 'C01', kind: 'character', name: '年轻学者·正面全身', ratio: '3:4', prompt: '真人实拍质感，35毫米胶片观感，全身站立正面，纯白背景，皮肤有毛孔与细小瑕疵' },
    { id: 'S01', kind: 'scene', name: '黑板教室·正打', ratio: '16:9', prompt: '真人实拍质感，大学黑板教室，午后高窗暖光，画面中没有任何人物' }
  ],
  episodes: project.episodes.map((e, i) => ({ ...e, refs: ['C01', 'S01'], prompt: `生成一段15秒的真人短片（第${i + 1}集）` }))
})
// 真人感约定：每集一份纯正文 txt（出片时工具直接读）
for (const e of project.episodes) {
  writeFileSync(join(projectDir, `${e.id}_prompt.txt`), `生成一段15秒的真人短片（第${e.id}集纯正文）。`, 'utf8')
}

// 造两条历史：一条成功出图、一条失败出片
const { recordGeneration } = await import('../lib/history.js')
recordGeneration({
  kind: 'asset', project: projectDir, projectTitle: '不一样的工具箱', status: 'ok',
  summary: '已出图 2 张（6 积分）', credits: 6, model: 'seedream_5.5', resolution: '2K',
  items: [
    { id: 'C01', name: '年轻学者·正面全身', status: 'ok', file: 'assets/C01.png', credits: 3 },
    { id: 'S01', name: '黑板教室·正打', status: 'ok', file: 'assets/S01.png', credits: 3 }
  ]
})
recordGeneration({
  kind: 'episode', project: projectDir, projectTitle: '不一样的工具箱', status: 'failed',
  summary: 'E01 出片失败', error: '积分上限 150，报价 285', model: 'seedance_2.5_flash', resolution: '720p', duration: 15,
  items: [{ id: 'E01', status: 'failed', error: '积分上限 150，报价 285' }]
})

let handler = null
const ctx = { webServer: { register(cfg) { handler = cfg.handler; return () => {} } } }
registerApi(ctx)
if (!handler) throw new Error('registerApi 没注册 handler')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function get(path) {
  const res = await fetch(base + path)
  const text = await res.text()
  return { status: res.status, type: res.headers.get('content-type'), text }
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const ping = await get('/realman-studio/api/ping')
  check('ping', ping.status === 200 && JSON.parse(ping.text).version === '0.1.0', ping.text)

  const catalog = JSON.parse((await get('/realman-studio/api/catalog')).text)
  check('catalog: 项目已列出', catalog.ok && catalog.projects.length === 1, `projects=${catalog.projects.length} title=${catalog.projects[0]?.title}`)
  check('catalog: 历史 2 条', catalog.history.length === 2, `total=${catalog.stats.history.total} credits=${catalog.stats.history.credits}`)
  check('catalog: 统计正确', catalog.stats.projects.doneAssets === 0 && catalog.stats.projects.count === 1, JSON.stringify(catalog.stats.projects))
  check('catalog: 封面可算', catalog.projects[0].cover === null && catalog.projects[0].assets === 2, `assets=${catalog.projects[0].assets}`)

  const detail = JSON.parse((await get(`/realman-studio/api/project?path=${encodeURIComponent(projectDir)}`)).text)
  check('project: 元信息', detail.meta.title === '不一样的工具箱' && detail.meta.style.paletteZh.includes('暖褐'), detail.meta.style.paletteZh)
  check('project: 默认模型', detail.meta.video.model === 'seedance_2.5_flash' && detail.meta.video.resolution === '480p', `${detail.meta.video.model}/${detail.meta.video.resolution}`)
  check('project: 资产摘要', detail.files.assets.length === 2 && detail.files.assets[0].promptChars > 0, `promptChars=${detail.files.assets[0].promptChars}`)
  check('project: promptFile 识别', detail.files.episodes.every((e) => e.hasPromptFile), detail.files.episodes.map((e) => e.promptFile).join(','))
  // 详情页要能看剧本/分镜：docs 必须把每集 txt 列出来，且带 kind 与大小
  check('project: 文档列表', Array.isArray(detail.files.docs) && detail.files.docs.some((d) => d.kind === 'prompt' && d.bytes > 0), `docs=${(detail.files.docs || []).map((d) => `${d.kind}:${d.name}`).join(' ')}`)
  check('project: 历史按项目过滤', detail.history.length === 2 && detail.stats.credits === 6, `history=${detail.history.length}`)

  const hist = JSON.parse((await get('/realman-studio/api/history?kind=episode&status=failed')).text)
  check('history: 过滤 kind+status', hist.list.length === 1 && hist.list[0].kind === 'episode', hist.list[0]?.summary)

  const jobs = JSON.parse((await get('/realman-studio/api/jobs')).text)
  check('jobs: 空列表 ok', jobs.ok && jobs.list.length === 0)

  const page = await get('/realman-studio/')
  check('静态页面: index.html', page.status === 200 && page.text.includes('真人剧工坊'), `${page.status} ${page.type}`)
  const css = await get('/realman-studio/app.css')
  check('静态页面: app.css', css.status === 200 && css.type.includes('css'), css.type)
  const js = await get('/realman-studio/app.js')
  check('静态页面: app.js', js.status === 200 && js.text.includes('renderHistory'), js.type)
  const traversal = await get('/realman-studio/..%2f..%2fpackage.json')
  check('静态页面: 越界被拒', traversal.status === 404, String(traversal.status))

  // 生成接口：/api/generate 在没登录/没提示词时会走工具并失败 —— 这里只验证参数校验分支
  const bad = await fetch(base + '/realman-studio/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'nope', project: projectDir }) })
  check('generate: 非法 kind 拒绝', bad.status === 400, await bad.text())
  const missing = await fetch(base + '/realman-studio/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'asset', project: join(ROOT, '不存在') }) })
  check('generate: 不存在的目录拒绝', missing.status === 400, await missing.text())

  // 清空历史
  const cleared = await fetch(base + '/realman-studio/api/history/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
  const clearedBody = JSON.parse(await cleared.text())
  check('history/clear', clearedBody.removed === 2 && readHistory().length === 0, JSON.stringify(clearedBody))
} finally {
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exit(1)
