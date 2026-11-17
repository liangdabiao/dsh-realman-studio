// 注册给模型的六个工具。Host 进程执行，调用即梦官方 CLI（dreamina-canvas）。
// 生成走「画布节点」：资产 = 图片节点，每集 = 视频节点（m2v，引用资产节点），产物下载回项目目录。
// 分界线：写剧本/分镜/提示词是 LLM 基于随包 skill 的创作，工具只负责执行与记账；
// realman_check 是出片前的机械事故安检（纯净性/口型声明/时间轴格式），不评判内容好坏。
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { checkAssets, checkPromptSync, checkRealmanArchive, checkRealmanPrompt, checkScript, discoverFiles, readText, severityLabel } from './check.js'
import { concatEpisodes, ffmpegInfo, probeDuration, resolveFfmpeg } from './ffmpeg.js'
import { clearHistory, filterHistory, getRecord, normalizePath, readHistory, recordGeneration, summarize } from './history.js'
import {
  authAccount, authStatus, createImageNode, createVideoNode, downloadResource, ensureCanvas, listModels, pickResource,
  readPendingLogin, resolveCli, resolveModel, savePendingLogin, startLogin, waitLogin, DreaminaError, nodeShow
} from './dreamina.js'
import {
  assertInside, fileSummary, initProject, listProjects, ProjectError, readProject, resolveDir, saveProject, updateProject
} from './project.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const arr = (description) => ({ type: 'array', description, items: { type: 'string' } })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      data: { type: 'string' }
    }
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary)
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

function failSummary(err) {
  return err instanceof ProjectError || err instanceof DreaminaError ? err.message : String(err && err.message || err)
}

function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${key}`)
  return value.trim()
}

function optionalString(args, key) {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bounded(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// 保证项目有画布：直接在同一份 project 对象上挂 canvas 再落盘，避免读两次盘出现两份对象。
async function attachCanvas(dir, project) {
  const canvas = await ensureCanvas(dir, project, project.title)
  project.canvas = canvas
  saveProject(dir, project)
  return canvas
}

// ---------- 工具 1：项目 ----------

const STUDIO_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: str('init 建项目；read 读状态；update 合并 patch；list 列项目；env 查即梦登录/积分/模型；login 取登录链接；login-check 检查登录；canvas 建/绑定画布', { enum: ['init', 'read', 'update', 'list', 'env', 'login', 'login-check', 'canvas'] }),
    path: str('项目目录绝对路径（init 时可尚不存在）'),
    parent: str('list 时扫描的父目录绝对路径'),
    title: str('剧名 / 画布名'),
    aspect: str('画幅，默认 16:9（短视频竖屏用 9:16）', { enum: ['9:16', '16:9', '21:9', '1:1', '3:4', '4:3'] }),
    episodes: num('集数，默认 5'),
    episodeSeconds: num('每集秒数，默认 15'),
    styleDescription: str('视觉风格描述，默认「真人实拍质感，35毫米胶片摄影观感」；非真人题材按指南 §5 换（二维/水墨/广告微距…）'),
    tone: str('整体情感基调，如：智性悬疑 / 温暖收束 / 紧张压迫'),
    hook: str('一句话卖点（核心梗）'),
    paletteZh: str('色盘中文串（可选但强烈建议，防风格漂移）'),
    paletteEn: str('色盘英文串（可选）'),
    resolution: str('视频分辨率，默认 480p（约 105 积分/15s；720p 约 285）', { enum: ['480p', '720p'] }),
    model: str('视频模型，默认 seedance_2.5_flash（原生语音+口型）'),
    imageModel: str('图片模型，默认 seedream_5.5'),
    patch: str('update 时的 JSON 字符串；assets/episodes 数组整体替换，其余对象浅合并')
  }
}

export const studioTool = {
  name: 'realman_project',
  description: '真人剧工坊项目入口（真人实拍质感）：建项目、读进度、把资产/分镜登记进 project.json；也负责即梦登录（官方 dreamina-canvas CLI）、查积分、建画布。所有 path 都要绝对路径。',
  parameters: STUDIO_PARAMS,
  timeoutMs: 6 * 60_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')

    if (action === 'login') {
      const pending = readPendingLogin()
      if (pending && pending.expiresAt && Date.parse(pending.expiresAt) > Date.now() + 30_000) {
        return result(true, '已有一个待授权的登录链接', [`打开：${pending.verificationUriComplete}`, `授权后调用 realman_project action=login-check。`, `链接 ${pending.expiresAt} 过期。`].join('\n'))
      }
      const { already, challenge } = await startLogin()
      if (already) return result(true, '已经登录', '可以直接开始生成。')
      const record = {
        deviceCode: challenge.deviceCode,
        verificationUriComplete: challenge.verificationUriComplete || challenge.verificationUri,
        expiresAt: challenge.expiresAt,
        createdAt: new Date().toISOString()
      }
      // 官方 CLI 还会落一份本地待授权记录；这里只存非敏感字段
      savePendingLogin(record)
      return result(true, '需要你在浏览器里授权', [
        `打开这个链接并扫码/确认：${record.verificationUriComplete}`,
        `授权完成后调用 realman_project action=login-check（链接 ${record.expiresAt} 过期）。`,
        '如果已经登录过，action=login-check 会直接读出账号。'
      ].join('\n'))
    }

    if (action === 'login-check') {
      const pending = readPendingLogin()
      if (pending && pending.deviceCode) {
        try {
          const data = await waitLogin(pending.deviceCode, { timeoutMs: 120_000 })
          if (data && data.status === 'logged_in') savePendingLogin(null)
        } catch (err) {
          const status = await authStatus().catch(() => null)
          if (!status || !status.loggedIn) {
            return result(false, '还没授权完成', `${failSummary(err)}\n链接：${pending.verificationUriComplete}`)
          }
        }
      }
      const status = await authStatus()
      if (!status.loggedIn) return result(false, '当前未登录', '先 realman_project action=login 拿授权链接。')
      const account = await authAccount().catch(() => null)
      return result(true, '已登录', `账号：${account ? account.displayName : '（未知）'}｜可用积分：${account ? account.availableCredits : '?'}${account && account.isVip ? `｜会员 ${account.vipLevel}` : ''}`)
    }

    if (action === 'env') {
      const lines = []
      let loggedIn = false
      try {
        const cli = await resolveCli()
        const status = await authStatus()
        loggedIn = Boolean(status.loggedIn)
        lines.push(`即梦 CLI：dreamina-canvas v${cli.version || status.version || '?'}（官方版）`)
        lines.push(loggedIn ? '登录：是' : '登录：否 —— 用 action=login 取授权链接')
        if (loggedIn) {
          const account = await authAccount().catch(() => null)
          if (account) lines.push(`账号：${account.displayName}｜积分：${account.availableCredits}${account.isVip ? `｜会员 ${account.vipLevel}` : ''}`)
        }
      } catch (err) {
        lines.push(`即梦 CLI：不可用 — ${failSummary(err)}`)
      }
      try {
        const models = await listModels()
        lines.push(`模型：图片 ${models.image.length} 个（${models.image.slice(0, 4).map((m) => m.model).join('、')}…），视频 ${models.video.length} 个（${models.video.slice(0, 4).map((m) => m.model).join('、')}…）`)
      } catch (err) {
        lines.push(`模型列表：不可用 — ${failSummary(err)}`)
      }
      try {
        await resolveFfmpeg()
        lines.push(`ffmpeg：${ffmpegInfo().ffmpeg}`)
      } catch (err) {
        lines.push(`ffmpeg：不可用 — ${failSummary(err)}`)
      }
      return result(loggedIn, loggedIn ? '环境就绪' : '还没登录', lines.join('\n'))
    }

    if (action === 'init') {
      const dir = resolveDir(requireString(args, 'path'), { mustExist: false })
      const project = initProject({
        path: dir,
        title: optionalString(args, 'title'),
        aspect: optionalString(args, 'aspect'),
        episodes: args.episodes,
        styleDescription: optionalString(args, 'styleDescription'),
        tone: optionalString(args, 'tone'),
        hook: optionalString(args, 'hook'),
        paletteZh: optionalString(args, 'paletteZh'),
        paletteEn: optionalString(args, 'paletteEn'),
        episodeSeconds: args.episodeSeconds,
        model: optionalString(args, 'model'),
        imageModel: optionalString(args, 'imageModel'),
        resolution: optionalString(args, 'resolution')
      })
      return result(true, `已建项目：${project.title}（${dir}）`, [
        `画幅 ${project.video.aspect}，${project.episodes.length} 集 × ${project.video.episodeSeconds}s · ${project.video.resolution} · ${project.video.model}`,
        `风格：${project.style.description}`,
        project.style.hook ? `卖点：${project.style.hook}` : '',
        '下一步：按 skill 写 剧本.md / 资产提示词.md / 每集 E0X_分镜提示词.md（存档）+ E0X_prompt.txt（纯正文），用 realman_check 做出片前安检，再 update 登记 assets 和 episodes；生成前会自动建即梦画布。第 2 集起 episode 的 refs 可写上一集集号（如 "E01"）做抽帧接力。'
      ].filter(Boolean).join('\n'))
    }

    if (action === 'list') {
      const parent = resolveDir(optionalString(args, 'parent') || requireString(args, 'path'))
      const projects = listProjects(parent)
      const lines = projects.map((p) => `- ${p.title || '(未命名)'} — ${p.doneEpisodes}/${p.episodes} 集，资产 ${p.doneAssets}/${p.assets}｜${p.path}`)
      return result(true, `${parent} 下有 ${projects.length} 个项目`, lines.join('\n') || '（空）')
    }

    const dir = resolveDir(requireString(args, 'path'))

    if (action === 'canvas') {
      const project = readProject(dir)
      const canvas = await attachCanvas(dir, project)
      return result(true, `画布已就绪：${project.title}`, `projectId：${canvas.id}\n画布链接：${canvas.url}\n（所有图片/视频节点都建在这张画布上，方便在即梦里继续改）`)
    }

    if (action === 'read') {
      const project = readProject(dir)
      const files = fileSummary(dir, project)
      const lines = [
        `《${project.title}》${project.video.aspect} · ${project.video.episodeSeconds}s × ${project.episodes.length} 集 · ${project.video.resolution}`,
        `风格：${project.style.description || '（未填）'}${project.style.tone ? `｜基调：${project.style.tone}` : ''}`,
        `色盘：${project.style.palette.zh || '（未填，可选）'}`,
        `画布：${project.canvas ? project.canvas.url : '（还没建，生成时自动建）'}`,
        `资产 ${files.assets.length}：${files.assets.map((a) => `${a.id}=${a.status}`).join(' ') || '（空）'}`,
        `集数：${files.episodes.map((e) => `${e.id}[${e.video.status}${e.hasPromptFile ? '·txt✓' : ''}]`).join(' ')}`
      ]
      return result(true, '已读取', lines.join('\n'))
    }

    if (action === 'update') {
      const raw = requireString(args, 'patch')
      let patch
      try { patch = JSON.parse(raw) } catch (err) { throw new Error(`patch 不是合法 JSON：${err.message}`) }
      const project = updateProject(dir, patch)
      const files = fileSummary(dir, project)
      const noPrompt = files.assets.filter((a) => !a.promptChars).map((a) => a.id)
      return result(true, '已更新 project.json', [`资产 ${files.assets.length}｜集 ${files.episodes.length}`, noPrompt.length ? `缺 prompt 的资产：${noPrompt.join('、')}` : ''].filter(Boolean).join('\n'))
    }

    throw new Error(`未知 action：${action}`)
  }
}

// ---------- 工具 2：机械事故安检 ----------

const CHECK_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'project'],
  properties: {
    action: str('检查哪类文档：script 剧本 / assets 资产提示词 / prompt 纯正文txt / storyboard 存档md / sync txt与md一致性 / all 全部', { enum: ['script', 'assets', 'prompt', 'storyboard', 'sync', 'all'] }),
    project: str('项目目录绝对路径（按约定文件名 *剧本*.md / *资产提示词*.md / E??_prompt.txt / *分镜提示词*.md 自动发现）'),
    file: str('可选：显式指定单个文件的绝对路径（覆盖自动发现）')
  }
}

export const checkTool = {
  name: 'realman_check',
  description: '出片前的机械事故安检（只读、不联网、不花积分，不评判创作内容）：纯正文 txt 查纯净性（从「生成一段」起、无文档头混入）、时间轴格式（可解析、连续、与声明秒数一致）、防全哑（缺【声音】段/口型声明）、台词重复；资产查 C/S/P 编号与锁形象硬要求；剧本/存档 md 查格式约定；并比对每集 txt 与存档 md 正文是否同步。error 修完再出片，warn/info 自行斟酌。',
  parameters: CHECK_PARAMS,
  timeoutMs: 30_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')
    const dir = resolveDir(requireString(args, 'project'))
    const readOne = (file) => readText(assertInside(dir, resolve(dir, file)))

    const report = (label, checks) => {
      const lines = []
      for (const c of checks) {
        lines.push(`## ${label}｜${c.file}${c.ok ? ' ✅' : ' ❌'}`)
        const statLine = Object.entries(c.stats || {})
          .filter(([k, v]) => typeof v !== 'object')
          .map(([k, v]) => `${k}=${v}`).join('　')
        lines.push(statLine || '（无统计）')
        for (const w of c.warnings || []) lines.push(`${severityLabel(w.severity)} ${w.message}`)
        if (!(c.warnings || []).length) lines.push('✓ 没有机械事故')
        lines.push('')
      }
      return lines.join('\n')
    }

    const found = discoverFiles(dir)
    const explicit = optionalString(args, 'file')
    const outputs = []

    const runFor = (kind, files, checker) => {
      const list = explicit ? [explicit] : files
      if (action !== 'all' && action !== kind) return
      if (!list.length) {
        outputs.push(`## ${kind}｜（没找到对应文件）\n跳过。项目目录里要有按 skill 约定命名的文件（如 剧本.md / 资产提示词.md / E01_prompt.txt / E01_分镜提示词.md）。\n`)
        return
      }
      const checks = list.map((f) => checker(readOne(f), f))
      outputs.push(report(kind, checks))
    }

    runFor('script', found.scripts, checkScript)
    runFor('assets', found.assets, checkAssets)
    runFor('prompt', found.prompts, checkRealmanPrompt)
    runFor('storyboard', found.storyboards, checkRealmanArchive)

    // sync：每集 E0X_prompt.txt ↔ E0X 分镜提示词 md 的正文比对
    if (action === 'sync' || action === 'all') {
      const pairs = []
      for (const txt of found.prompts) {
        const ep = txt.match(/^(E\d{1,3})_prompt\.txt$/i)
        if (!ep) continue
        const md = found.storyboards.find((n) => n.toUpperCase().startsWith(`${ep[1].toUpperCase()}_`))
        pairs.push({ ep: ep[1], txt, md })
      }
      const lines = []
      for (const pair of pairs) {
        if (!pair.md) { lines.push(`## sync｜${pair.ep} ⚠️\n有 ${pair.txt} 但没找到对应的分镜提示词 md（${pair.ep}_分镜提示词.md）\n`); continue }
        const verdict = checkPromptSync(readOne(pair.txt), readOne(pair.md))
        lines.push(`## sync｜${pair.ep} ${verdict.synced === true ? '✅' : verdict.synced === false ? '⚠️' : 'ℹ️'}\n${verdict.message}\n`)
      }
      if (!pairs.length) lines.push('## sync｜（没有可比对的 E0X_prompt.txt）\n')
      outputs.push(lines.join('\n'))
    }

    if (!outputs.length) throw new Error(`未知 action：${action}`)
    const textOut = outputs.join('\n')
    const errors = (textOut.match(/❌/g) || []).length
    return result(errors === 0, errors ? `发现 ${errors} 个机械事故（error 修完再出片；warn/info 自行斟酌）` : '安检通过，没有机械事故（详见报告）', textOut)
  }
}

// ---------- 工具 3：资产出图 ----------

const ASSET_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'project'],
  properties: {
    action: str('generate 按资产编号出图（会等待出图完成并下载）；retry 重出失败/指定的；status 看状态；collect 从画布补收已生成但没下载的', { enum: ['generate', 'retry', 'status', 'collect'] }),
    project: str('项目目录绝对路径'),
    ids: arr('要处理的资产编号，如 ["C01","S01"]；省略则处理所有待办'),
    ratio: str('覆盖画幅，如 3:4（角色）/ 16:9（场景）'),
    resolution: str('分辨率，默认 2K（seedream 支持 2K/4K）'),
    model: str('图片模型，默认 seedream_5.5'),
    maxCredits: num('单张图允许消耗的积分上限，默认 10；报价超过会拒绝执行'),
    dryRun: { type: 'boolean', description: '只演练：输出将要执行的命令，不建节点、不扣积分' }
  }
}

export const assetTool = {
  name: 'realman_asset',
  description: '用即梦官方 CLI 给项目里的 C/S/P 资产出图：在项目画布上建图片节点、等待生成、把图下载到 assets/。提示词取自 project.json 的 assets[].prompt（由 LLM 按 skill 写好后 update 登记）。',
  parameters: ASSET_PARAMS,
  timeoutMs: 15 * 60_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')
    const dir = resolveDir(requireString(args, 'project'))
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : null
    const project = readProject(dir)
    const selected = (predicate) => project.assets.filter((a) => (ids ? ids.includes(a.id) : true)).filter(predicate)

    if (action === 'status') {
      const lines = project.assets.map((a) => `${a.id} ${a.status || 'idle'}${a.nodeId ? ` node=${a.nodeId}` : ''}${a.file ? ` → ${a.file}` : ''}${a.error ? ` ⚠ ${a.error}` : ''}`)
      return result(true, `资产 ${project.assets.length} 个`, lines.join('\n') || '（还没有资产，先 update）')
    }

    if (action === 'collect') {
      const canvas = project.canvas ? project.canvas.id : null
      if (!canvas) return result(false, '还没有画布', '先出图或 realman_project action=canvas')
      const pending = selected((a) => a.nodeId && !a.file)
      const lines = []
      for (const asset of pending) {
        try {
          const data = await nodeShow(canvas, asset.nodeId)
          const node = (data.nodes || [data.node] || []).find(Boolean)
          const resources = (node && node.resources) || []
          const done = resources.find((r) => r.state === 'succeeded') || resources[0]
          if (!done) { lines.push(`${asset.id} 还没有产物`); continue }
          const file = join(dir, 'assets', `${asset.id}.png`)
          await downloadResource(canvas, done.resourceId, file)
          Object.assign(asset, { status: 'done', resourceId: done.resourceId, file: relative(dir, file), error: null })
          lines.push(`${asset.id} ✓ ${relative(dir, file)}`)
        } catch (err) {
          lines.push(`${asset.id} ⚠ ${failSummary(err)}`)
        }
        saveProject(dir, project)
      }
      return result(true, '补收完成', lines.join('\n') || '（没有待补收的资产）')
    }

    if (action !== 'generate' && action !== 'retry') throw new Error(`未知 action：${action}`)

    const modelName = optionalString(args, 'model') || project.image.model || 'seedream_5.5'
    const resolution = optionalString(args, 'resolution') || project.image.resolution || '2K'
    const maxCredits = bounded(args.maxCredits, 10, 1, 500)
    const targets = selected((a) => (action === 'retry' ? a.status !== 'done' || args.ids : a.status !== 'done'))
    const runnable = targets.filter((a) => String(a.prompt || '').trim())
    if (!runnable.length) return result(false, '没有可出图的资产', '（都已完成，或资产里没有 prompt）')

    const model = await resolveModel(modelName, 'image').catch((err) => { throw new Error(failSummary(err)) })

    if (args.dryRun) {
      const lines = runnable.map((a) => `${a.id}：node create image --model ${model.model} --ratio ${optionalString(args, 'ratio') || a.ratio || '3:4'} --resolution ${resolution} --mode t2i --run --wait（prompt ${String(a.prompt).length} 字）`)
      return result(true, `演练：${lines.length} 个图片节点（未创建、未扣积分）`, lines.join('\n'))
    }

    const canvas = await attachCanvas(dir, project)
    const lines = []
    const failures = []
    const items = []
    const startedAt = new Date().toISOString()
    let creditSum = 0
    for (const asset of runnable) {
      const ratio = optionalString(args, 'ratio') || asset.ratio || '3:4'
      try {
        const { data } = await createImageNode({
          projectId: canvas.id,
          model: model.model,
          prompt: String(asset.prompt),
          ratio,
          resolution,
          title: `${asset.id} ${asset.name || ''}`.trim().slice(0, 80),
          maxCredits
        })
        const nodeId = data.node && data.node.nodeId
        const credits = data.quote && data.quote.maxCredits
        const resource = pickResource(data)
        if (!resource) throw new Error('节点跑完但没有拿到资源')
        const file = join(dir, 'assets', `${asset.id}.png`)
        await downloadResource(canvas.id, resource.resourceId, file)
        Object.assign(asset, { status: 'done', nodeId, resourceId: resource.resourceId, file: relative(dir, file), credits, error: null })
        if (Number.isFinite(Number(credits))) creditSum += Number(credits)
        items.push({ id: asset.id, name: asset.name || '', status: 'ok', file: relative(dir, file), credits, nodeId })
        lines.push(`${asset.id} ✓ ${(credits ? `${credits} 积分，` : '')}${relative(dir, file)}`)
      } catch (err) {
        Object.assign(asset, { status: 'failed', error: failSummary(err).slice(0, 300) })
        failures.push(`${asset.id}：${asset.error}`)
        items.push({ id: asset.id, name: asset.name || '', status: 'failed', error: asset.error })
      }
      saveProject(dir, project)
    }
    const data = [lines.join('\n'), failures.length ? `失败：\n${failures.join('\n')}` : ''].filter(Boolean).join('\n\n')
    const okCount = items.filter((it) => it.status === 'ok').length
    const summary = failures.length
      ? `出图 ${okCount}/${items.length} 张成功，${failures.length} 张失败`
      : `已出图 ${okCount} 张（${creditSum} 积分）`
    recordGeneration({
      kind: 'asset',
      at: startedAt,
      project: dir,
      projectTitle: project.title,
      status: failures.length === 0 ? 'ok' : 'failed',
      summary,
      error: failures.join('；'),
      credits: creditSum || null,
      model: model.model,
      resolution,
      items
    })
    return result(failures.length === 0, failures.length ? '部分资产出图失败' : `已出图 ${lines.length} 张`, data)
  }
}

// ---------- 工具 4：单集出片 ----------

const EPISODE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'project'],
  properties: {
    action: str('generate 出片并等待下载；status 看状态；collect 从画布补收', { enum: ['generate', 'status', 'collect'] }),
    project: str('项目目录绝对路径'),
    episode: str('集号，如 E01'),
    prompt: str('本集 Seedance 纯正文提示词；省略则依次读 project.json 里该集的 prompt、再读该集的 E0X_prompt.txt'),
    mode: str('auto 有参考走 m2v、没有走 t2v', { enum: ['auto', 'm2v', 't2v'] }),
    refs: arr('参考编号列表：资产编号（C01/S01…）按顺序作图片参考；也可写集号（E01）引用该集已出片的视频做抽帧接力/延长；省略用 project.json 该集的 refs'),
    duration: num('秒数，默认取项目设置（15）'),
    resolution: str('分辨率，默认 480p（约 105 积分/15s；720p 约 285）', { enum: ['480p', '720p'] }),
    model: str('视频模型，默认 seedance_2.5_flash（原生语音+口型）'),
    maxCredits: num('单集允许消耗的积分上限，默认 150'),
    dryRun: { type: 'boolean', description: '只演练：输出将要执行的命令，不建节点、不扣积分' }
  }
}

export const episodeTool = {
  name: 'realman_episode',
  description: '用即梦官方 CLI 出某一集视频（默认 Seedance 2.5 Flash，原生生成语音与口型）：参考图按顺序挂成 m2v 参考（refs 也可写上一集集号做跨集接力），出片后把 mp4 下载到 videos/。提示词默认读该集的 E0X_prompt.txt 纯正文。',
  parameters: EPISODE_PARAMS,
  timeoutMs: 20 * 60_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')
    const dir = resolveDir(requireString(args, 'project'))
    const project = readProject(dir)

    if (action === 'status') {
      const lines = project.episodes.map((e) => `${e.id} ${(e.video && e.video.status) || 'idle'}${e.video && e.video.nodeId ? ` node=${e.video.nodeId}` : ''}${e.video && e.video.file ? ` → ${e.video.file}` : ''}`)
      return result(true, `共 ${project.episodes.length} 集`, lines.join('\n'))
    }

    const episodeId = optionalString(args, 'episode') || (project.episodes[0] && project.episodes[0].id)
    if (!episodeId) throw new Error('项目里还没有集，先 update episodes')
    const index = project.episodes.findIndex((e) => e.id === episodeId)
    if (index < 0) throw new Error(`没有这一集：${episodeId}`)
    const episode = project.episodes[index]

    if (action === 'collect') {
      if (!project.canvas || !episode.video || !episode.video.nodeId) return result(false, '没有可补收的节点', '先 generate')
      const data = await nodeShow(project.canvas.id, episode.video.nodeId)
      const node = (data.nodes || [data.node] || []).find(Boolean)
      const resources = (node && node.resources) || []
      const done = resources.find((r) => r.state === 'succeeded') || resources[0]
      if (!done) return result(false, '节点还没有产物', '稍后再试')
      const file = join(dir, 'videos', `${episodeId}.mp4`)
      await downloadResource(project.canvas.id, done.resourceId, file)
      episode.video = { ...episode.video, status: 'done', resourceId: done.resourceId, file: relative(dir, file) }
      saveProject(dir, project)
      return result(true, `${episodeId} 已收片`, relative(dir, file))
    }

    if (action !== 'generate') throw new Error(`未知 action：${action}`)

    // 提示词取值链：args.prompt → project.json 该集 prompt → 该集 E0X_prompt.txt 纯正文
    let prompt = optionalString(args, 'prompt') || episode.prompt
    if (!prompt && episode.promptFile) {
      const pf = assertInside(dir, resolve(dir, episode.promptFile))
      if (existsSync(pf)) {
        prompt = readFileSync(pf, 'utf8').trim()
        if (prompt) episode.prompt = prompt // 回填，read/页面都能看到
      }
    }
    if (!prompt) throw new Error(`缺少 prompt：把 ${episode.id} 的纯正文传进来，或先写好 ${episode.id}_prompt.txt 再调用`)

    const modelName = optionalString(args, 'model') || project.video.model || 'seedance_2.5_flash'
    const resolution = optionalString(args, 'resolution') || project.video.resolution || '480p'
    const duration = bounded(args.duration, project.video.episodeSeconds, 4, 30)
    const maxCredits = bounded(args.maxCredits, 150, 1, 1000)
    const refIds = Array.isArray(args.refs) ? args.refs.map(String) : (episode.refs || [])

    // refs 解析：资产编号 → 图片节点；E0X 集号 → 该集视频节点（抽帧接力/延长）。
    // dryRun 只核对引用是否存在，不要求节点已生成（演练的意义就是出片前预览）。
    const dry = Boolean(args.dryRun)
    const refNodes = []
    const refImages = []
    const refVideos = []
    for (const id of refIds) {
      if (/^E\d{1,3}$/i.test(id)) {
        const refEp = project.episodes.find((e) => e.id.toLowerCase() === id.toLowerCase())
        if (!refEp) throw new Error(`项目里没有这一集：${id}`)
        if (!refEp.video || !refEp.video.nodeId) {
          if (!dry) throw new Error(`集 ${refEp.id} 还没出过片——接力参考要先出上一集`)
          refVideos.push(refEp.id)
          continue
        }
        refNodes.push(refEp.video.nodeId)
        refVideos.push(refEp.id)
        continue
      }
      const asset = project.assets.find((a) => a.id === id)
      if (!asset) throw new Error(`项目里没有这个资产：${id}`)
      if (!asset.nodeId && !dry) throw new Error(`资产 ${id} 还没有画布节点（先出图）`)
      if (asset.nodeId) refNodes.push(asset.nodeId)
      refImages.push(asset.id)
    }
    // Seedance 2.5 Flash m2v 上限：图片参考 10、视频参考 5
    if (refImages.length > 10) throw new Error(`图片参考最多 10 张（给了 ${refImages.length}：${refImages.join('、')}）`)
    if (refVideos.length > 5) throw new Error(`接力视频参考最多 5 个（给了 ${refVideos.length}）`)
    const modeArg = optionalString(args, 'mode') || 'auto'
    const mode = modeArg === 'auto' ? ((refNodes.length || (dry && refIds.length)) ? 'm2v' : 't2v') : modeArg
    if (mode === 'm2v' && !refNodes.length && !dry) throw new Error('m2v 至少要一个参考；纯文字请用 mode=t2v')

    if (dry) {
      const pendingNotes = []
      for (const id of refImages) if (!project.assets.find((a) => a.id === id).nodeId) pendingNotes.push(`${id}(待出图)`)
      for (const id of refVideos) {
        const refEp = project.episodes.find((e) => e.id === id)
        if (!refEp.video || !refEp.video.nodeId) pendingNotes.push(`${id}(待出片)`)
      }
      const refList = [...refImages, ...refVideos.map((v) => `${v}(视频接力)`)].join(' → ') || '（无）'
      return result(true, `演练：${episodeId} 的出片（未建节点、未扣积分）`, [
        `node create video --model ${modelPreview(modelName, 'video')} --mode ${mode} --ratio ${project.video.aspect} --resolution ${resolution} --duration ${duration}${refNodes.length ? ` --ref ${refNodes.map((n) => `node:${n}`).join(' ')}` : ''} --run --wait`,
        `参考：${refList}${pendingNotes.length ? `｜其中 ${pendingNotes.join('、')} 还没有节点，真跑前要先出图/出片` : ''}｜prompt ${String(prompt).length} 字${episode.promptFile && existsSync(assertInside(dir, resolve(dir, episode.promptFile))) ? `（读自 ${episode.promptFile}）` : ''}`
      ].join('\n'))
    }

    const model = await resolveModel(modelName, 'video')
    const canvas = await attachCanvas(dir, project)
    const startedAt = new Date().toISOString()
    try {
      const { data } = await createVideoNode({
        projectId: canvas.id,
        model: model.model,
        prompt: String(prompt),
        ratio: project.video.aspect,
        resolution,
        duration,
        refs: mode === 'm2v' ? refNodes : [],
        maxCredits,
        title: `${episodeId} ${episode.title || ''}`.trim()
      })
      const nodeId = data.node && data.node.nodeId
      const credits = data.quote && data.quote.maxCredits
      const resource = pickResource(data)
      if (!resource) throw new Error('视频节点跑完但没有拿到资源')
      const file = join(dir, 'videos', `${episodeId}.mp4`)
      await downloadResource(canvas.id, resource.resourceId, file)
      episode.video = {
        status: 'done',
        nodeId,
        submitId: data.submission && data.submission.submitId,
        resourceId: resource.resourceId,
        file: relative(dir, file),
        credits,
        mode,
        duration,
        error: null,
        finishedAt: new Date().toISOString()
      }
      if (!episode.prompt) episode.prompt = String(prompt)
      saveProject(dir, project)
      recordGeneration({
        kind: 'episode',
        at: startedAt,
        project: dir,
        projectTitle: project.title,
        status: 'ok',
        summary: `${episodeId}${episode.title ? ` ${episode.title}` : ''} 已出片（${duration}s · ${resolution} · ${mode}${credits ? ` · ${credits} 积分` : ''}）`,
        credits: Number.isFinite(Number(credits)) ? Number(credits) : null,
        model: model.model,
        resolution,
        duration,
        items: [{ id: episodeId, name: episode.title || '', status: 'ok', file: relative(dir, file), credits, nodeId }],
        outputs: [relative(dir, file)]
      })
      return result(true, `${episodeId} 已出片${credits ? `（${credits} 积分）` : ''}`, `${relative(dir, file)}\n画布：${canvas.url}`)
    } catch (err) {
      episode.video = { ...(episode.video || {}), status: 'failed', error: failSummary(err).slice(0, 300) }
      saveProject(dir, project)
      recordGeneration({
        kind: 'episode',
        at: startedAt,
        project: dir,
        projectTitle: project.title,
        status: 'failed',
        summary: `${episodeId} 出片失败`,
        error: failSummary(err),
        model: model.model,
        resolution,
        duration,
        items: [{ id: episodeId, name: episode.title || '', status: 'failed', error: failSummary(err) }]
      })
      return result(false, `${episodeId} 出片失败`, failSummary(err))
    }
  }
}

// dryRun 阶段只展示模型名，不做真实解析（resolveModel 要联网）
function modelPreview(name, type) {
  return name || (type === 'video' ? 'seedance_2.5_flash' : 'seedream_5.5')
}

// ---------- 工具 5：拼接 ----------

const ASSEMBLE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['project'],
  properties: {
    project: str('项目目录绝对路径'),
    episodes: arr('要拼接的集号，按顺序；省略则用所有已出片的集'),
    out: str('输出文件名，默认 out/final.mp4（相对项目目录）'),
    audio: str('可选旁白音轨路径（绝对，或相对项目目录）'),
    timeoutMs: num('ffmpeg 超时，默认 600000')
  }
}

export const assembleTool = {
  name: 'realman_assemble',
  description: '把已出片的各集用 ffmpeg 拼成一部片，可选贴一条旁白音轨。默认输出 out/final.mp4。',
  parameters: ASSEMBLE_PARAMS,
  timeoutMs: 15 * 60_000,
  output: OUTPUT,
  async execute(args) {
    const dir = resolveDir(requireString(args, 'project'))
    const project = readProject(dir)
    const wanted = Array.isArray(args.episodes) ? args.episodes.map(String) : null
    const episodes = project.episodes.filter((e) => (wanted ? wanted.includes(e.id) : true))
    const files = []
    const missing = []
    for (const e of episodes) {
      const rel = e.video && e.video.file
      const abs = rel ? assertInside(dir, resolve(dir, rel)) : null
      if (abs && existsSync(abs)) files.push(abs)
      else missing.push(e.id)
    }
    if (!files.length) return result(false, '没有可拼接的视频', `这些集还没出片：${missing.join('、')}`)
    const outRel = optionalString(args, 'out') || 'out/final.mp4'
    const outPath = assertInside(dir, resolve(dir, outRel))
    const audio = optionalString(args, 'audio')
    const audioPath = audio ? (isAbsolute(audio) ? audio : resolve(dir, audio)) : undefined
    const startedAt = new Date().toISOString()
    try {
      const { file, bytes } = await concatEpisodes(files, outPath, { audio: audioPath, timeoutMs: bounded(args.timeoutMs, 600_000, 30_000, 1_800_000) })
      const duration = await probeDuration(file).catch(() => null)
      const lines = [`${files.length} 集 → ${file}（${(bytes / 1024 / 1024).toFixed(1)} MB${duration ? `，${duration}s` : ''}）`]
      if (missing.length) lines.push(`跳过的集（未出片）：${missing.join('、')}`)
      const rel = relative(dir, file)
      recordGeneration({
        kind: 'assemble',
        at: startedAt,
        project: dir,
        projectTitle: project.title,
        status: 'ok',
        summary: `${files.length} 集拼成 ${rel}（${(bytes / 1024 / 1024).toFixed(1)} MB${duration ? `，${Math.round(duration)}s` : ''}）${missing.length ? `，跳过 ${missing.join('、')}` : ''}`,
        duration: duration ? Math.round(duration) : null,
        items: episodes.filter((e) => files.includes(resolve(dir, e.video.file))).map((e) => ({ id: e.id, name: e.title || '', status: 'ok', file: e.video.file })),
        outputs: [rel]
      })
      return result(true, '拼接完成', lines.join('\n'))
    } catch (err) {
      recordGeneration({
        kind: 'assemble',
        at: startedAt,
        project: dir,
        projectTitle: project.title,
        status: 'failed',
        summary: '拼接失败',
        error: failSummary(err)
      })
      return result(false, '拼接失败', failSummary(err))
    }
  }
}

// ---------- 工具 6：生成历史 ----------
// 页面「生成历史」和这里读的是同一份 $DSH_HOME/realman-studio/history.json：
// 每次 realman_asset / realman_episode / realman_assemble 跑完都会落一条。

const HISTORY_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: str('list 列历史；get 看单条详情；stats 汇总；clear 清空（project 给了就只清这个项目）', { enum: ['list', 'get', 'stats', 'clear'] }),
    project: str('只看/只清这个项目目录（绝对路径）'),
    kind: str('list：asset 出图 / episode 出片 / assemble 拼接', { enum: ['all', 'asset', 'episode', 'assemble'] }),
    status: str('list：ok 成功 / failed 失败', { enum: ['all', 'ok', 'failed'] }),
    q: str('list：关键词（剧名/摘要/模型）'),
    limit: num('list：最多几条，默认 20'),
    id: str('get：记录 id（list 里能看到）'),
    confirm: str('clear 必须传 "yes"', { enum: ['yes'] })
  }
}

const KIND_CN = { asset: '出图', episode: '出片', assemble: '拼接' }

function historyLine(r) {
  const when = String(r.at || '').replace('T', ' ').slice(0, 16)
  const mark = r.status === 'ok' ? '✓' : '✗'
  const credits = r.credits ? ` · ${r.credits} 分` : ''
  return `${mark} ${when} ${KIND_CN[r.kind] || r.kind}｜${r.projectTitle || '(未命名)'}｜${r.summary}${credits}｜id=${r.id}`
}

export const historyTool = {
  name: 'realman_history',
  description: '查这个插件的生成历史（出图/出片/拼接每次一条，和侧栏「真人剧工坊 · 生成历史」同一份数据）：list 列表、get 单条详情（含 prompt 范围、积分、产物路径）、stats 汇总积分与产出、clear 清空。想知道「上次出了几张、花了多少积分、哪张失败了」就用它。',
  parameters: HISTORY_PARAMS,
  timeoutMs: 30_000,
  output: OUTPUT,
  async execute(args) {
    const action = requireString(args, 'action')
    const all = readHistory()

    if (action === 'clear') {
      if (args.confirm !== 'yes') throw new Error('清空历史要传 confirm: "yes"')
      const removed = clearHistory({ project: optionalString(args, 'project') })
      return result(true, `已清空 ${removed} 条历史`, optionalString(args, 'project') ? `只清了 ${optionalString(args, 'project')} 的记录。` : '全部记录都删了（项目文件和产物没动）。')
    }

    if (action === 'stats') {
      const project = optionalString(args, 'project')
      const target = project ? normalizePath(project) : undefined
      const scoped = target ? all.filter((r) => normalizePath(r.project) === target) : all
      const s = summarize(scoped)
      return result(true, `${target ? '这个项目' : '全部'}共 ${s.total} 条生成记录`, [
        `成功 ${s.ok}｜失败 ${s.failed}｜累计 ${s.credits} 积分`,
        `出图 ${s.byKind.asset} 次（成功产出 ${s.outputs.asset} 张）｜出片 ${s.byKind.episode} 次（${s.outputs.episode} 集）｜拼接 ${s.byKind.assemble} 次`,
        s.lastAt ? `最近一次：${String(s.lastAt).replace('T', ' ').slice(0, 16)}` : ''
      ].filter(Boolean).join('\n'))
    }

    if (action === 'get') {
      const id = requireString(args, 'id')
      const record = getRecord(id)
      if (!record) return result(false, `没有这条记录：${id}`, '先用 action=list 看 id。')
      const lines = [
        `# ${record.kindLabel || KIND_CN[record.kind] || record.kind}｜${record.projectTitle || '(未命名)'}`,
        `状态：${record.status === 'ok' ? '成功' : '失败'}｜开始 ${String(record.at).replace('T', ' ').slice(0, 19)}｜结束 ${String(record.finishedAt || '').replace('T', ' ').slice(0, 19)}`,
        `项目：${record.project}`,
        record.summary ? `摘要：${record.summary}` : '',
        record.error ? `错误：${record.error}` : '',
        record.model ? `模型：${record.model}${record.resolution ? ` · ${record.resolution}` : ''}${record.duration ? ` · ${record.duration}s` : ''}` : '',
        record.credits ? `积分：${record.credits}` : '',
        record.items.length ? `对象：\n${record.items.map((it) => `  - ${it.id}${it.name ? ` ${it.name}` : ''} [${it.status}]${it.file ? ` → ${it.file}` : ''}${it.credits ? ` (${it.credits} 分)` : ''}${it.error ? ` ⚠ ${it.error}` : ''}`).join('\n')}` : '',
        record.outputs.length ? `产物：\n${record.outputs.map((o) => `  - ${o}`).join('\n')}` : ''
      ]
      return result(true, '记录详情', lines.filter(Boolean).join('\n'))
    }

    if (action !== 'list') throw new Error(`未知 action：${action}`)
    const project = optionalString(args, 'project')
    const target = project ? normalizePath(project) : undefined
    const list = filterHistory(all, {
      project: target,
      kind: optionalString(args, 'kind') || 'all',
      status: optionalString(args, 'status') || 'all',
      q: optionalString(args, 'q'),
      limit: bounded(args.limit, 20, 1, 100)
    })
    if (!list.length) return result(true, '还没有生成记录', '出图/出片/拼接跑完后会自动记一条，侧栏「真人剧工坊 · 生成历史」里也能看到。')
    const s = summarize(target ? all.filter((r) => normalizePath(r.project) === target) : all)
    return result(true, `最近 ${list.length} 条（共 ${s.total} 条，累计 ${s.credits} 积分）`, list.map(historyLine).join('\n'))
  }
}

export const TOOLS = [studioTool, checkTool, assetTool, episodeTool, assembleTool, historyTool]
