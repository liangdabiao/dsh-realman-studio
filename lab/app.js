// 真人剧工坊工作台 · 页面逻辑（无框架，hash 路由 + fetch /api/*）
// 布局对齐「分镜导演台」：左侧 rail 导航，右侧改由路由决定；
// 点「新建真人剧 / 继续创作」这类动作时，postMessage 给宿主开新对话并填好指令。
// 分界线：创作（剧本/分镜/提示词）由模型按随包 skill 完成，页面只管发起、执行与回看。
const app = document.getElementById('app')
const navProjects = document.getElementById('nav-projects')
const navHistory = document.getElementById('nav-history')
const railFoot = document.getElementById('rail-foot')
const viewer = document.getElementById('viewer')
const viewerTitle = document.getElementById('viewer-title')
const viewerBody = document.getElementById('viewer-body')
const viewerCopy = document.getElementById('viewer-copy')
const toastEl = document.getElementById('toast')

// 页面挂在 /realman-studio/ 下，接口也在同一前缀下。
// 不能用 '/api/...' 这种根绝对路径——那会打到宿主自己的 API 上。
const BASE = location.pathname.replace(/\/+$/, '') || '/realman-studio'

const state = {
  catalog: null,
  health: null,
  error: '',
  q: '',
  kind: 'all',
  status: 'all',
  project: '',
  current: null,
  job: null,
  jobs: {}
}

const KIND = { asset: '出图', episode: '出片', assemble: '拼接' }
const STEPS = [
  ['01', '文', '剧本 / 弧线 / 资产清单', '模型按随包真人感 skill 把故事写成 剧本.md（△镜头 + 角色名（情绪）：台词）与 资产提示词.md；每集先定一句弧线（从…到…最后…）'],
  ['02', '资', '资产图 C/S/P', '角色（全身+纯白底+皮肤细节）、场景（无人+正打/反打/侧面）、道具先出图锁形象；一致性靠参考图，不靠文字禁令'],
  ['03', '视', '每集出片', '写 E0X_分镜提示词.md（存档）+ E0X_prompt.txt（纯正文，只喂模型这份）；资产节点作参考（m2v）出片，第 2 集起 refs 可写上一集集号做抽帧接力'],
  ['04', '剪', '拼接成片', 'ffmpeg 按集序拼成 out/final.mp4，可选贴一条旁白音轨']
]
const MODELS = [
  ['资产图', 'seedream_5.5 · 2K', '约 6 / 张（实测）'],
  ['单集 15s', 'seedance_2.5_flash · 480p（默认）', '约 105 / 集'],
  ['单集 15s', 'seedance_2.5_flash · 720p', '约 285 / 集'],
  ['单集 15s', 'seedance_2.5 · 720p', '约 300 / 集'],
  ['单集 15s', 'seedance_2.0_mini · 720p', '约 90 / 集（无原生口型，真人剧不推荐）']
]

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0)
const date = (iso) => (iso ? String(iso).slice(0, 10) : '')
const shortTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const joinPath = (dir, rel) => `${String(dir).replace(/[\\/]+$/, '')}\\${String(rel).replace(/^[\\/]+/, '')}`
const mediaUrl = (abs) => `${BASE}/media?path=${encodeURIComponent(abs)}`
const kindLabel = (k) => KIND[k] || k || ''
const mb = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '')
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || '新真人剧'

async function api(path, opts) {
  const res = await fetch(BASE + path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.error || `请求失败（${res.status}）`)
  return body
}

async function post(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
}

// ---------------------------------------------------------------- 主题 / 宿主通信

addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const m = e.data
  if (m && m.type === 'realman-studio:scheme' && m.scheme) document.documentElement.dataset.scheme = m.scheme
  if (m && m.type === 'realman-studio:start-failed') toast('开新对话失败：' + (m.message || ''))
})

// 通知宿主开一个新对话，并把指令填进输入框（不自动发送）。
function start(prompt) {
  try {
    parent.postMessage({ type: 'realman-studio:start', prompt }, location.origin)
    toast('已把任务填进新对话，确认后发送即可')
  } catch {
    toast('当前环境开不了新对话，请手动复制：\n' + prompt)
  }
}

let toastTimer
function toast(text) {
  toastEl.textContent = text
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3600)
}

// ---------------------------------------------------------------- viewer

let viewerCopyText = ''
function openViewer({ title, copy = '', html = '', media = null }) {
  viewer.hidden = false
  viewerTitle.textContent = title || ''
  viewerBody.className = media ? 'viewer-body media' : 'viewer-body'
  viewerBody.innerHTML = media
    ? media
    : html
  viewerCopy.hidden = !copy
  viewerCopyText = copy
}
function closeViewer() {
  viewer.hidden = true
  viewerBody.innerHTML = ''
  viewerBody.className = 'viewer-body'
}
document.getElementById('viewer-close').addEventListener('click', closeViewer)
viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer() })
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !viewer.hidden) closeViewer() })
viewerCopy.addEventListener('click', () => {
  if (!viewerCopyText) return
  navigator.clipboard?.writeText(viewerCopyText)
  toast('路径已复制')
})

// ---------------------------------------------------------------- 路由

const route = () => location.hash.replace(/^#\/?/, '').split('?')[0]

function render() {
  const r = route()
  document.querySelectorAll('.nav a').forEach((a) => {
    const v = a.dataset.view
    const on = (v === 'home' && r === '') || (v === 'projects' && (r.startsWith('projects') || r.startsWith('p/'))) ||
      (v === 'history' && r.startsWith('history')) || (v === 'new' && r === 'new') || (v === 'guide' && r === 'guide')
    if (on) a.setAttribute('aria-current', 'true')
    else a.removeAttribute('aria-current')
  })
  if (r === '') return renderHome()
  if (r === 'projects' || r.startsWith('projects')) return renderProjects()
  if (r.startsWith('p/')) return renderDetail(decodeURIComponent(r.slice(2)))
  if (r.startsWith('history')) return renderHistory()
  if (r === 'new') return renderNew()
  if (r === 'guide') return renderGuide()
  return renderHome()
}

function wrap(html) {
  app.innerHTML = `<div class="wrap">${html}</div>`
}

// ---------------------------------------------------------------- 概览

function renderHome() {
  const d = state.catalog
  const hp = d.stats.projects
  const hs = d.stats.history
  const health = state.health || d.health || {}
  const auth = health.auth || {}
  wrap(`
    <header class="head">
      <span class="eyebrow">Seedance 2.5 Flash · Realman Studio</span>
      <h1>真人剧工坊</h1>
      <p>一句话故事 → 剧本 / 资产图 / 每集 15 秒真人感分镜 → 在即梦画布上出图出片 → 拼成一部片。
         默认真人实拍质感 + 35 毫米胶片；出片前 realman_check 只拦机械事故（防全哑/纯净性/时间轴），创作本身交给模型和 skill。</p>
    </header>

    <div class="stats">
      <div class="stat accent"><b>${hp.count}</b><small>在做的真人剧</small></div>
      <div class="stat"><b>${hp.doneAssets}<span style="font-size:13px;color:var(--ink-3)">/${hp.assets}</span></b><small>资产图</small></div>
      <div class="stat jade"><b>${hp.doneEpisodes}<span style="font-size:13px;color:var(--ink-3)">/${hp.episodes}</span></b><small>已出片集</small></div>
      <div class="stat gold"><b>${hs.credits}</b><small>历史累计积分</small></div>
      <div class="stat"><b>${hs.total}</b><small>生成记录</small></div>
    </div>

    ${auth.loggedIn === false ? `
      <div class="sec-head"><h2>先登录即梦</h2></div>
      <div class="note warn">即梦 CLI 还没登录，出图出片会失败。在对话里说一句「跑 realman_project action=login」拿授权链接，扫码后再说「action=login-check」。
        <div style="margin-top:8px"><button class="btn small" data-act="login">把登录指令填进新对话</button></div>
      </div>` : ''}

    <div class="sec-head"><h2>最近在做</h2><a class="more" href="#/projects">全部真人剧 →</a></div>
    ${d.projects.length ? `<div class="grid">${d.projects.slice(0, 3).map(projectCard).join('')}</div>`
      : `<div class="empty-box"><b>还没有真人剧项目</b>
          在「新建真人剧」填个剧名和故事，会打开新对话并带上完整制作指令；<br>
          模型建好 project.json、写好分镜并登记资产后，这里就会出现项目卡。</div>`}

    <div class="sec-head"><h2>最近生成</h2><a class="more" href="#/history">全部记录 →</a>
      <span class="sub">出图 / 出片 / 拼接各算一条</span></div>
    ${d.history.length ? `<div class="panel" id="recent-history">${d.history.slice(0, 6).map((r) => historyRow(r)).join('')}</div>`
      : `<div class="empty-box"><b>还没有生成记录</b>跑一次 realman_asset / realman_episode / realman_assemble，这里会自动记账。</div>`}

    <div class="sec-head"><h2>下一步</h2></div>
    <div class="grid">
      <div class="card" data-go="#/new">
        <div class="card-top"><span class="dot" style="background:var(--accent)"></span><span class="card-title">新建一部真人剧</span></div>
        <div class="card-sub">填剧名、集数、质感，打开新对话并带上「文-资-视-剪」全流程指令</div>
      </div>
      <div class="card" data-go="#/projects">
        <div class="card-top"><span class="dot" style="background:var(--jade)"></span><span class="card-title">接着做手上的</span></div>
        <div class="card-sub">资产墙、分集播放、出图出片按钮都在项目页</div>
      </div>
      <div class="card" data-go="#/history">
        <div class="card-top"><span class="dot" style="background:var(--gold)"></span><span class="card-title">翻生成历史</span></div>
        <div class="card-sub">看每次花了多少积分、哪张图失败、产物的路径</div>
      </div>
      <div class="card" data-go="#/guide">
        <div class="card-top"><span class="dot" style="background:var(--ink-3)"></span><span class="card-title">工作流与积分</span></div>
        <div class="card-sub">真人感四步怎么走、模型报价、常见问题</div>
      </div>
    </div>
  `)
  bindCards()
  bindHistory()
  const login = app.querySelector('[data-act="login"]')
  if (login) login.addEventListener('click', () => start('请用 realman_project action=login 拿即梦授权链接，我扫码后再 action=login-check。'))
}

// ---------------------------------------------------------------- 项目卡

function projectCard(p) {
  const cover = p.cover ? mediaUrl(joinPath(p.path, p.cover)) : ''
  return `<div class="card pcard" data-go="#/p/${encodeURIComponent(p.path)}">
    <div class="thumb">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : '无资产图'}</div>
    <div class="body">
      <div class="card-top">
        <span class="dot" style="background:${p.doneEpisodes ? 'var(--jade)' : 'var(--grey)'}"></span>
        <span class="card-title">${esc(p.title || '未命名')}</span>
        ${p.hasFinal ? '<span class="badge ok">成片</span>' : ''}
        ${p.failedAssets ? `<span class="badge bad">${p.failedAssets} 失败</span>` : ''}
      </div>
      <div class="card-sub muted">${esc(p.aspect)} · ${p.episodeSeconds}s × ${p.episodes} 集 · ${esc(p.styleDescription || p.palette || '风格未填')}</div>
      <div class="card-foot">
        <span>资产 ${p.doneAssets}/${p.assets}</span>
        <div class="bar" style="flex:1;min-width:40px"><i style="width:${pct(p.doneAssets, p.assets)}%"></i></div>
        <span>出片 ${p.doneEpisodes}/${p.episodes}</span>
        <span>${date(p.updatedAt)}</span>
      </div>
    </div>
  </div>`
}

function bindCards() {
  app.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = el.dataset.go })
  })
}

// ---------------------------------------------------------------- 历史行

function historyRow(r, showProject = true) {
  return `<div class="hrow" data-rec="${esc(r.id)}">
    <span class="when">${esc(shortTime(r.at))}</span>
    <span class="badge ${r.status === 'ok' ? 'ok' : 'bad'}">${esc(kindLabel(r.kind))}</span>
    <span class="what">
      <b>${esc(showProject ? (r.projectTitle || '未命名') : r.summary)}</b>
      <div>${esc(showProject ? r.summary : r.project)}</div>
    </span>
    <span class="credits">${r.credits ? `${r.credits} 分` : ''}</span>
  </div>`
}

function bindHistory() {
  app.querySelectorAll('[data-rec]').forEach((el) => {
    el.addEventListener('click', () => openRecord(el.dataset.rec))
  })
}

function findRecord(id) {
  const fromCatalog = (state.catalog && state.catalog.history || []).find((r) => r.id === id)
  if (fromCatalog) return fromCatalog
  return null
}

async function openRecord(id) {
  let record = findRecord(id)
  if (!record) {
    try {
      const data = await api(`/api/history?limit=400`)
      record = (data.list || []).find((r) => r.id === id)
    } catch (err) { /* 忽略，下面统一提示 */ }
  }
  if (!record) { toast('找不到这条记录'); return }
  const items = record.items || []
  const outs = record.outputs || []
  openViewer({
    title: `${kindLabel(record.kind)} · ${record.projectTitle || '未命名'}`,
    copy: record.project,
    html: `
      <div class="detail-head" style="margin-bottom:8px">
        <h1 style="font-size:19px;margin:0">${esc(record.summary || kindLabel(record.kind))}</h1>
        <span class="badge ${record.status === 'ok' ? 'ok' : 'bad'}">${record.status === 'ok' ? '成功' : '失败'}</span>
        ${record.credits ? `<span class="badge grey">${record.credits} 积分</span>` : ''}
        ${record.model ? `<span class="badge grey">${esc(record.model)}</span>` : ''}
        ${record.resolution ? `<span class="badge grey">${esc(record.resolution)}</span>` : ''}
        ${record.duration ? `<span class="badge grey">${record.duration}s</span>` : ''}
      </div>
      <div class="card-sub muted" style="margin-bottom:10px">
        ${esc(shortTime(record.at))} 开始 · ${esc(shortTime(record.finishedAt))} 结束
      </div>
      ${record.error ? `<div class="note warn" style="margin-bottom:10px">${esc(record.error)}</div>` : ''}
      ${items.length ? `<div class="card-sub" style="margin-bottom:2px"><b>这次动了 ${items.length} 个对象</b></div>
        <ul class="rec-items">${items.map((it) => `
          <li>
            <span style="font-weight:600;min-width:44px">${esc(it.id)}</span>
            <span class="badge ${it.status === 'ok' ? 'ok' : 'bad'}" style="min-width:34px;justify-content:center">${it.status === 'ok' ? '成功' : '失败'}</span>
            <span class="grow">${esc(it.name || '')}${it.error ? ` · <span style="color:var(--bad)">${esc(it.error)}</span>` : ''}</span>
            <span style="color:var(--gold)">${it.credits ? `${it.credits} 分` : ''}</span>
          </li>`).join('')}</ul>` : ''}
      ${outs.length ? `<div class="card-sub" style="margin:10px 0 4px"><b>产物</b></div>
        <div class="card-sub" style="font-family:Consolas,monospace;font-size:11.5px;line-height:1.9">
          ${outs.map((o) => `<div>${esc(joinPath(record.project, o))}</div>`).join('')}
        </div>` : ''}
      ${record.kind === 'episode' && outs.length ? `
        <div style="margin-top:12px">${videoOf(joinPath(record.project, outs[0]))}</div>` : ''}
    `
  })
}

// 视频播放器：有文件才嵌，避免一堆空壳
function videoOf(abs) {
  return `<video src="${esc(mediaUrl(abs))}" controls preload="metadata" style="width:100%;max-width:420px;border-radius:10px;background:#000"></video>`
}

// ---------------------------------------------------------------- 我的真人剧

function renderProjects() {
  const d = state.catalog
  const projects = d.projects.filter((p) => {
    if (!state.q) return true
    const hay = `${p.title} ${p.palette} ${p.path}`.toLowerCase()
    return hay.includes(state.q.toLowerCase())
  })
  wrap(`
    <header class="head">
      <h1>我的真人剧</h1>
      <p>共 ${d.projects.length} 部。点开看资产墙和分集，出图出片按钮直接调即梦。</p>
    </header>
    <div class="toolbar">
      <input class="search" id="q" placeholder="搜索剧名 / 风格 / 目录" value="${esc(state.q)}">
      <span class="badge grey">扫描：${d.roots.length ? d.roots.map(esc).join(' · ') : '默认目录 ' + esc(d.defaultRoot)}</span>
      <button class="btn ghost small" id="add-root">换个目录…</button>
      <button class="btn ghost small" id="rescan">重新扫描</button>
    </div>
    ${projects.length ? `<div class="grid">${projects.map(projectCard).join('')}</div>`
      : `<div class="empty-box"><b>${state.q ? '没有匹配的真人剧' : '这个目录下还没有项目'}</b>
          ${state.q ? '换个关键词试试。' : '先「新建真人剧」，或让模型用 realman_project action=init 建一个。'}</div>`}
  `)
  const q = document.getElementById('q')
  q.addEventListener('input', (e) => {
    state.q = e.target.value
    renderProjects()
    setTimeout(() => { const n = document.getElementById('q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length) } }, 0)
  })
  document.getElementById('rescan').addEventListener('click', () => boot().then(() => toast('已重新扫描')))
  document.getElementById('add-root').addEventListener('click', async () => {
    const dir = prompt('要扫描哪个目录？（绝对路径，扫的是它的下一级含 project.json 的文件夹）', d.roots[0] || d.defaultRoot)
    if (!dir) return
    try {
      await post('/api/roots', { add: dir })
      await boot()
      toast('已加入扫描目录')
    } catch (err) { toast('加目录失败：' + err.message) }
  })
  bindCards()
}

// ---------------------------------------------------------------- 项目详情

async function renderDetail(path) {
  app.innerHTML = '<div class="loading">读取项目…</div>'
  let data
  try {
    data = await api(`/api/project?path=${encodeURIComponent(path)}`)
  } catch (err) {
    wrap(`<div class="empty-box"><b>读不到这个项目</b>${esc(err.message)}</div>`)
    return
  }
  state.current = data
  const { meta, files, summary } = data
  const assets = files.assets || []
  const episodes = files.episodes || []
  const doneAssets = assets.filter((a) => a.status === 'done')
  const nextEpisode = episodes.find((e) => e.video.status !== 'done') || null
  // 报价直接写在按钮上：480p 约 105 分 / 720p 约 285 分（2026-11 实测），点之前就知道要花多少
  const episodeCredits = meta.video.resolution === '720p' ? 285 : 105
  const recs = data.history || []
  const running = Object.values(state.jobs).find((j) => j.project === data.path && j.status === 'running')

  wrap(`
    <header class="head">
      <a class="card-sub" href="#/projects">← 我的真人剧</a>
      <div class="detail-head" style="margin-top:6px">
        <h1>${esc(meta.title || '未命名')}</h1>
        <span class="badge">${esc(meta.video.aspect)} · ${meta.video.episodeSeconds}s × ${episodes.length} 集</span>
        ${meta.video.resolution ? `<span class="badge grey">${esc(meta.video.resolution)}</span>` : ''}
        ${meta.style.description ? `<span class="badge grey">${esc(meta.style.description)}</span>` : ''}
        ${meta.style.paletteZh ? `<span class="badge grey">色盘：${esc(meta.style.paletteZh)}</span>` : ''}
        ${summary.hasFinal ? '<span class="badge ok">已拼成片</span>' : ''}
      </div>
      <p style="margin-top:6px">
        图片 ${esc(meta.image.model)} · 视频 ${esc(meta.video.model)} ·
        ${meta.canvas ? `<a href="${esc(meta.canvas.url)}" target="_blank" rel="noreferrer">打开即梦画布 ↗</a>` : '还没建画布（生成时自动建）'} ·
        <span style="color:var(--ink-3);font-size:11.5px">${esc(data.path)}</span>
        <button class="btn ghost small" id="copy-path" style="margin-left:6px">复制路径</button>
      </p>
    </header>

    <div class="actions" style="margin-bottom:14px">
      <button class="btn" id="gen-assets" ${assets.length === doneAssets.length ? 'disabled' : ''}>
        ${running && running.kind === 'asset' ? '出图中…' : `全部出图（${assets.length - doneAssets.length}）`}
      </button>
      <button class="btn jade" id="gen-episode" ${nextEpisode ? '' : 'disabled'}>
        ${running && running.kind === 'episode' ? '出片中…' : nextEpisode ? `出下一集（${nextEpisode.id}）· 约 ${episodeCredits} 分` : '已全部出片'}
      </button>
      <button class="btn ghost" id="assemble" ${summary.doneEpisodes ? '' : 'disabled'}>
        ${running && running.kind === 'assemble' ? '拼接中…' : '拼接成片'}
      </button>
      <button class="btn ghost" id="refresh">刷新</button>
      <button class="btn ghost" id="continue">在对话里继续</button>
    </div>

    ${running ? jobBar(running) : ''}

    <div class="sec-head"><h2>资产</h2><span class="sub">${doneAssets.length}/${assets.length} 完成 · 出图约 6 积分 / 张（实测）</span></div>
    ${assets.length ? `<div class="assets">${assets.map((a) => assetCard(a, data.path)).join('')}</div>`
      : `<div class="empty-box"><b>还没有登记资产</b>让模型用 realman_project action=update 把 C/S/P 资产和 prompt 写进 project.json。</div>`}

    <div class="sec-head"><h2>分集</h2><span class="sub">${summary.doneEpisodes}/${episodes.length} 出片</span></div>
    ${episodes.length ? episodes.map((e) => episodeCard(e, data.path, running, meta.video.aspect)).join('')
      : `<div class="empty-box"><b>还没有分集</b>登记 episodes（prompt + refs）之后就能逐集出片。</div>`}

    <div class="sec-head"><h2>这个项目的生成记录</h2><a class="more" href="#/history">全部 →</a></div>
    ${recs.length ? `<div class="panel">${recs.map((r) => historyRow(r, false)).join('')}</div>`
      : `<div class="empty-box"><b>还没跑过生成</b>出图 / 出片 / 拼接跑完会自动记一条。</div>`}
  `)

  bindHistory()

  document.getElementById('copy-path').addEventListener('click', () => {
    navigator.clipboard?.writeText(data.path)
    toast('项目路径已复制')
  })
  document.getElementById('refresh').addEventListener('click', () => renderDetail(data.path))
  document.getElementById('continue').addEventListener('click', () => start(
    `继续做《${meta.title}》（项目目录 ${data.path}）。先用 realman_project action=read 看当前进度（path=${data.path}），` +
    `再按缺什么补什么：缺资产就 realman_asset action=generate，缺片子就 realman_episode action=generate（提示词读该集 E0X_prompt.txt），` +
    `都齐了用 realman_assemble 拼成片。每次跑完在侧栏「真人剧工坊 · 生成历史」里核对积分和产物。`))
  const genAssets = document.getElementById('gen-assets')
  if (genAssets) genAssets.addEventListener('click', () => generate(data.path, 'asset'))
  document.getElementById('gen-episode').addEventListener('click', () => {
    if (!nextEpisode) return toast('所有集都已出片；要重出某一集，点那一集的「重出本集」')
    generate(data.path, 'episode', { episode: nextEpisode.id })
  })
  document.getElementById('assemble').addEventListener('click', () => generate(data.path, 'assemble'))

  app.querySelectorAll('[data-ep]').forEach((el) => el.addEventListener('click', () => {
    generate(data.path, 'episode', { episode: el.dataset.ep })
  }))
  app.querySelectorAll('[data-asset-zoom]').forEach((el) => el.addEventListener('click', () => {
    openViewer({ title: el.dataset.id, media: `<img src="${esc(el.dataset.assetZoom)}" alt="">` })
  }))
}

// 「16:9」这类画幅串 → CSS aspect-ratio + 缩略图宽窄档位（场景资产是横的，人物是竖的）
function ratioOf(value) {
  const m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(String(value || '').trim())
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? { w, h, css: `${w} / ${h}`, value: w / h } : null
}

function ratioClass(r) {
  if (!r) return ''
  if (r.value > 1.15) return 'wide'
  if (r.value > 0.92) return 'square'
  return ''
}

function assetCard(a, projectPath) {
  const img = a.file ? mediaUrl(joinPath(projectPath, a.file)) : ''
  const tone = a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : 'grey'
  const label = a.status === 'done' ? '完成' : a.status === 'failed' ? '失败' : a.status === 'running' ? '生成中' : '待办'
  const ratio = ratioOf(a.ratio)
  return `<div class="asset">
    <div class="shot ${ratioClass(ratio)}" ${ratio ? `style="aspect-ratio:${ratio.css}"` : ''} ${img ? `data-asset-zoom="${esc(img)}" data-id="${esc(a.id)}"` : ''}>
      ${img ? `<img src="${esc(img)}" alt="${esc(a.id)}" loading="lazy">` : (a.status === 'failed' ? '失败' : '未出图')}
    </div>
    <div class="row"><b>${esc(a.id)}</b>
      <span class="card-sub muted" style="font-size:11px">${esc(a.name || '')}</span>
      <span class="badge ${tone}">${label}</span></div>
    ${a.error ? `<div style="color:var(--bad);font-size:10.5px;line-height:1.5;margin-top:4px">${esc(a.error)}</div>` : ''}
    ${a.prompt ? `<details><summary>prompt ${a.promptChars} 字${a.credits ? ` · ${a.credits} 分` : ''}</summary><p>${esc(a.prompt)}</p></details>` : ''}
  </div>`
}

function episodeCard(e, projectPath, running, aspect) {
  const file = e.video.file ? joinPath(projectPath, e.video.file) : ''
  const tone = e.video.status === 'done' ? 'ok' : e.video.status === 'failed' ? 'bad' : 'grey'
  const label = e.video.status === 'done' ? '已出片' : e.video.status === 'failed' ? '失败' : e.video.status === 'running' ? '生成中' : '待办'
  const busy = running && running.kind === 'episode' && running.args && running.args.episode === e.id
  const ratio = ratioOf(aspect)
  // 真人感约定：提示词正文在 E0X_prompt.txt 里，project.json 的 prompt 常为空——别显示成「0 字」
  const promptLine = e.promptChars
    ? `提示词 ${e.promptChars} 字`
    : e.hasPromptFile ? `正文见 ${esc(e.promptFile)}` : '提示词未登记'
  return `<div class="episode">
    <div class="scene ${ratioClass(ratio)}" ${ratio ? `style="aspect-ratio:${ratio.css}"` : ''}>${file ? videoOf(file) : '未出片'}</div>
    <div class="meta">
      <div class="row">
        <b>${esc(e.id)}</b>
        <span class="card-sub" style="font-size:12.5px">${esc(e.title || '')}</span>
        <span class="badge ${tone}">${label}</span>
        ${e.video.duration ? `<span class="badge grey">${e.video.duration}s</span>` : ''}
        ${e.video.credits ? `<span class="badge grey">${e.video.credits} 分</span>` : ''}
        ${e.hasPromptFile ? '<span class="badge ok">txt✓</span>' : ''}
        <span class="badge grey">参考 ${(e.refs || []).join(' → ') || '无'}</span>
      </div>
      <div class="desc">${promptLine}${e.video.finishedAt ? ` · ${esc(shortTime(e.video.finishedAt))} 出片` : ''}</div>
      ${e.video.error ? `<div style="color:var(--bad);font-size:11.5px;margin-top:4px">${esc(e.video.error)}</div>` : ''}
      <div style="margin-top:8px">
        <button class="btn ghost small" data-ep="${esc(e.id)}" ${busy ? 'disabled' : ''}>
          ${busy ? '出片中…' : (e.video.status === 'done' ? '重出本集' : '出本集')}
        </button>
      </div>
      ${e.prompt ? `<details><summary>Seedance 纯正文</summary><p>${esc(e.prompt)}</p></details>` : ''}
    </div>
  </div>`
}

function jobBar(job) {
  const tone = job.status === 'running' ? '' : job.status === 'failed' ? 'failed' : ''
  const icon = job.status === 'running' ? '<span class="spin"></span>' : ''
  const text = job.status === 'running'
    ? `${kindLabel(job.kind)}进行中 · ${job.summary || '提交中…'}`
    : `${job.status === 'done' ? '完成' : '失败'} · ${job.summary || job.error || ''}`
  return `<div class="jobbar ${tone}" style="margin-bottom:12px">${icon}<span style="flex:1;min-width:0;white-space:pre-wrap;word-break:break-word">${esc(text)}</span></div>`
}

// ---------------------------------------------------------------- 发起生成

async function generate(project, kind, extra = {}) {
  try {
    const body = { kind, project, maxCredits: kind === 'asset' ? 10 : kind === 'episode' ? 150 : undefined, ...extra }
    if (!body.maxCredits) delete body.maxCredits
    const data = await post('/api/generate', body)
    const running = { id: data.job, kind, status: 'running', project, summary: '提交中…', args: { episode: extra.episode } }
    state.jobs[data.job] = running
    state.job = running
    toast(`${kindLabel(kind)}任务已提交，进度会自己刷新`)
    if (state.current && state.current.path === project) renderDetail(project)
    trackJob(data.job, project)
  } catch (err) {
    toast('提交失败：' + err.message)
  }
}

let pollTimer = null
function trackJob(id, project) {
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    let job
    try {
      const data = await api(`/api/job?id=${encodeURIComponent(id)}`)
      job = data.job
    } catch {
      clearInterval(pollTimer)
      return
    }
    state.jobs[id] = { ...state.jobs[id], ...job, project }
    state.job = state.jobs[id]
    const running = job.status === 'running'
    if (state.current && state.current.path === project) {
      // 跑的时候只换任务条，跑完整体刷新一次
      if (running) {
        const bar = app.querySelector('.jobbar')
        if (bar) bar.outerHTML = jobBar(state.jobs[id])
      } else {
        clearInterval(pollTimer)
        toast(`${kindLabel(job.kind)}${job.status === 'done' ? '完成' : '失败'}：${job.summary || job.error || ''}`)
        await boot()
      }
      return
    }
    if (!running) {
      clearInterval(pollTimer)
      toast(`${kindLabel(job.kind)}${job.status === 'done' ? '完成' : '失败'}：${job.summary || job.error || ''}`)
      await boot()
    }
  }, 2000)
}

// ---------------------------------------------------------------- 生成历史

async function renderHistory() {
  app.innerHTML = '<div class="loading">读取生成历史…</div>'
  let data
  try {
    const params = new URLSearchParams({
      kind: state.kind, status: state.status, limit: '200'
    })
    if (state.project) params.set('project', state.project)
    if (state.q) params.set('q', state.q)
    data = await api(`/api/history?${params}`)
  } catch (err) {
    wrap(`<div class="empty-box"><b>读不到历史</b>${esc(err.message)}</div>`)
    return
  }
  const list = data.list || []
  const projects = (state.catalog && state.catalog.projects) || []
  wrap(`
    <header class="head">
      <h1>生成历史</h1>
      <p>${data.total} 条记录 · 累计 ${data.stats.credits} 积分 · 成功 ${data.stats.ok} / 失败 ${data.stats.failed}。
         点任意一行看当时动了哪些资产、产物路径和失败原因。</p>
    </header>
    <div class="toolbar">
      ${['all', 'asset', 'episode', 'assemble'].map((k) => `
        <button class="pill" data-kind="${k}" aria-pressed="${state.kind === k}">${k === 'all' ? '全部' : KIND[k]}</button>`).join('')}
      <span style="width:8px"></span>
      ${['all', 'ok', 'failed'].map((s) => `
        <button class="pill" data-status="${s}" aria-pressed="${state.status === s}">${s === 'all' ? '不限状态' : s === 'ok' ? '成功' : '失败'}</button>`).join('')}
      <select id="f-project" style="max-width:240px">
        <option value="">全部项目</option>
        ${projects.map((p) => `<option value="${esc(p.path)}" ${state.project === p.path ? 'selected' : ''}>${esc(p.title || p.path)}</option>`).join('')}
      </select>
      <input class="search" id="h-q" placeholder="搜摘要 / 模型 / 剧名" value="${esc(state.q)}">
    </div>
    ${list.length ? `<div class="panel">${list.map((r) => historyRow(r)).join('')}</div>`
      : `<div class="empty-box"><b>没有匹配的记录</b>换个筛选条件，或先去出几张图。</div>`}
    <div class="toolbar" style="margin-top:16px">
      <button class="btn ghost small" id="clear-history">清空历史</button>
      <span class="card-sub muted" style="font-size:11px">只删记录，不动 project.json 和已经生成的图片/视频。</span>
    </div>
  `)
  app.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.kind = b.dataset.kind; renderHistory() }))
  app.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; renderHistory() }))
  document.getElementById('f-project').addEventListener('change', (e) => { state.project = e.target.value; renderHistory() })
  const q = document.getElementById('h-q')
  q.addEventListener('input', (e) => {
    state.q = e.target.value
    if (q._t) clearTimeout(q._t)
    q._t = setTimeout(() => renderHistory(), 260)
  })
  document.getElementById('clear-history').addEventListener('click', async () => {
    if (!confirm('清空全部生成历史记录？（项目文件和产物不会删）')) return
    try {
      const r = await post('/api/history/clear', {})
      await boot()
      toast(`已清空 ${r.removed || 0} 条记录`)
      renderHistory()
    } catch (err) { toast('清空失败：' + err.message) }
  })
  bindHistory()
}

// ---------------------------------------------------------------- 新建真人剧

// 质感预设：只是往「视觉风格」输入框里填一句可改的起始描述（指南 §5 各题材质感落点），不是硬约束。
const LOOK_PRESETS = {
  realman: '真人实拍质感，35毫米胶片摄影观感，低饱和自然色，真实皮肤与衣料纹理，细腻胶片颗粒',
  fantasy: '真人实拍质感 + 奇幻重量感：布料回摆、接触受力、翼膜承风，35毫米胶片观感',
  ad: '真人广告微距质感：材质光学（透射/折射/拉丝/哑光）、浅景深、实体前景遮挡',
  anime2d: '二维手绘动画：纸面颗粒、平涂、关键姿势，真实感来自运动规律与空间比例',
  ink: '国风水墨动画：墨色浓淡、留白呼吸、笔触入纸'
}

function renderNew() {
  const d = state.catalog
  const roots = d.roots.length ? d.roots : [d.defaultRoot]
  const lastProject = d.projects[0]
  wrap(`
    <header class="head">
      <span class="eyebrow">文 · 资 · 视 · 剪</span>
      <h1>新建真人剧</h1>
      <p>填好之后会打开一个新对话，指令已经写全（建项目 → 写剧本/分镜 → 出图 → 出片 → 拼接），你可以再改。</p>
    </header>
    <div class="panel">
      <div class="form">
        <label class="fld">剧名<input id="f-title" placeholder="如 不一样的工具箱"></label>
        <label class="fld">项目根目录
          <select id="f-root">${roots.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
        </label>
        <label class="fld">集数<input id="f-episodes" type="number" min="1" max="50" value="5"></label>
        <label class="fld">每集秒数<input id="f-seconds" type="number" min="4" max="30" value="15"></label>
        <label class="fld">画幅
          <select id="f-aspect">
            <option value="16:9" selected>16:9 横屏</option>
            <option value="9:16">9:16 竖屏（短视频）</option>
            <option value="21:9">21:9 宽银幕</option>
            <option value="1:1">1:1 方屏</option>
            <option value="3:4">3:4</option>
            <option value="4:3">4:3</option>
          </select>
        </label>
        <label class="fld">分辨率
          <select id="f-resolution">
            <option value="480p" selected>480p（约 105 积分 / 15s）</option>
            <option value="720p">720p（约 285 积分 / 15s）</option>
          </select>
        </label>
        <label class="fld">质感预设
          <select id="f-look">
            <option value="realman" selected>真人写实 · 35毫米胶片（默认）</option>
            <option value="fantasy">真人奇幻 · 重量感</option>
            <option value="ad">真人广告 · 微距材质</option>
            <option value="anime2d">二维手绘动画</option>
            <option value="ink">国风水墨</option>
          </select>
        </label>
        <label class="fld full">故事 / 梗概（可先写一句，让模型扩写）<textarea id="f-blurb" rows="4" placeholder="普林斯顿数学系一道攻不破的积分，被物理系的年轻费曼用「积分号下求导」当场解开…"></textarea></label>
      </div>
      <div class="actions" style="margin-top:14px">
        <button class="btn" id="f-go">打开新对话，指令已写好 →</button>
        <button class="btn ghost" id="f-skill">先看 skill 怎么用</button>
      </div>
      <div class="note" style="margin-top:12px">
        预算参考：资产图约 6 积分 / 张（实测）；单集 15 秒 480p 约 105 积分、720p 约 285 积分。
        模型会先 dryRun 报报价，再真跑；单次积分上限图片 10、视频 150，超了直接拒绝。
      </div>
    </div>

    ${lastProject ? `
      <div class="sec-head"><h2>或者接着上次</h2></div>
      <div class="grid">${projectCard(lastProject)}</div>` : ''}
  `)
  bindCards()
  document.getElementById('f-go').addEventListener('click', () => {
    const title = document.getElementById('f-title').value.trim()
    if (!title) return toast('先填个剧名')
    const root = document.getElementById('f-root').value
    const dir = joinPath(root, safeName(title))
    const episodes = Number(document.getElementById('f-episodes').value) || 5
    const seconds = Number(document.getElementById('f-seconds').value) || 15
    const aspect = document.getElementById('f-aspect').value
    const resolution = document.getElementById('f-resolution').value
    const look = document.getElementById('f-look').value
    const style = LOOK_PRESETS[look] || LOOK_PRESETS.realman
    const blurb = document.getElementById('f-blurb').value.trim()
    start(`帮我做一部真人剧《${title}》，视觉风格：${style}。

故事：${blurb || '（我只有剧名，先帮我把故事骨架和人物立起来，再往下做）'}

项目目录：${dir}
参数：${episodes} 集 × ${seconds}s，画幅 ${aspect}，分辨率 ${resolution}，风格：${style}
（基调、一句话卖点、色盘这些你没拿到，按故事自己定，写进 realman_project init 里即可。）

请按 seedance-storyboard-generator-realman 技能推进「文-资-视-剪」：
1. realman_project action=init（path=${dir}，title/aspect/episodes/episodeSeconds/resolution/styleDescription，tone/hook/palette 按故事自定）
2. 写 剧本.md（△镜头 + 角色名（情绪）：台词）与 资产提示词.md（C/S/P：角色全身+纯白底+皮肤细节、场景无人三机位、道具纯白底）；每集先定一句弧线
3. 逐集写 E01…E${String(episodes).padStart(2, '0')}_分镜提示词.md（存档版：弧线/台词表/检查记录/尾帧描述 + --- + 正文），并导出同名 E0X_prompt.txt 纯正文（从「生成一段」起，只含喂模型的正文；台词逐字写在说话那一刻、【声音】段统一口型声明、台词绝不重复第二遍）
4. realman_check action=all 机械事故安检（防全哑/纯净性/时间轴），error 修完再往下
5. realman_project action=update 登记 assets（C/S/P，带 ratio 和 prompt）与 episodes（prompt + refs）
6. realman_asset action=generate（先 dryRun 报积分，我确认后再真跑）
7. realman_episode action=generate（逐集出片；第 2 集起 refs 可写上一集集号做抽帧接力）
8. realman_assemble 拼成 out/final.mp4

每跑完一步，在侧栏「真人剧工坊」里能看到资产墙、分集和这次的生成记录（积分/产物/失败原因）。`)
  })
  document.getElementById('f-skill').addEventListener('click', () => {
    start('先带我过一遍 seedance-storyboard-generator-realman 技能：输出「文-资-视-剪」四步各自要产出的文件、真人感六根支柱怎么落进提示词、对白红线与【声音】段口型声明怎么写、纯正文 txt 与存档 md 的双文件约定，以及 references/真人感电影写实指南.md 的要点清单。再看 example/ 里费曼《不一样的工具箱》的完整范式。')
  })
}

// ---------------------------------------------------------------- 工作流

function renderGuide() {
  wrap(`
    <header class="head">
      <span class="eyebrow">Workflow</span>
      <h1>文 · 资 · 视 · 剪</h1>
      <p>四步走完一部真人剧。写剧本/分镜/提示词由模型按随包 skill（seedance-storyboard-generator-realman）完成：提示词是写给视频 AI 的电影小说，不是检查表；一致性靠资产参考图，不靠文字禁令。出片前 realman_check 只拦机械事故，不评判创作。</p>
    </header>
    <div class="steps">
      ${STEPS.map(([n, tag, title, desc]) => `<div class="step"><b>${n} · ${tag}</b><strong>${title}</strong><span>${desc}</span></div>`).join('')}
    </div>

    <div class="sec-head"><h2>三条红线（写完每集自查）</h2><span class="sub">完整规程以随包 SKILL.md 与真人感指南为准</span></div>
    <div class="panel">
      <dl class="kv">
        <dt>对白红线</dt><dd>台词逐字写在角色说话那一刻（他压着火说："…"），说话镜头写嘴部可见；【声音】段统一声明「同期声、口型同步、声线清晰」，台词绝不重复抄第二遍——只写音效会全哑。</dd>
        <dt>纯净性</dt><dd>发给模型的只有纯提示词正文（E0X_prompt.txt，从「生成一段」起）；存档版 md 里的弧线/台词表/检查记录绝不喂模型。</dd>
        <dt>一致性</dt><dd>靠资产参考图（m2v 挂节点），不靠「全程一致/禁止换脸」这类文字禁令；跨镜要维持的具体状态写进它所属的时间轴段。</dd>
      </dl>
    </div>

    <div class="sec-head"><h2>安装与准备（一次性）</h2><span class="sub">不装也能写剧本/分镜，只是不能真的出图出片</span></div>
    <div class="panel">
       <p>生成视频和图片用的是**即梦 CLI**（dreamina-canvas），需要先安装并登录：</p>

<p>- 官网：https://jimeng.jianying.com/ai-tool/install?from_page=explore</p>
<p>- 装好:全能画布CLI </p>
 <p>- 生图默认：Seedream 5.5（seedream5.5）</p>
<p>- 生视频默认：Seedance 2.5 flash</p>
    </div>

    <div class="sec-head"><h2>生图怎么走（资）</h2><span class="sub">seedream_5.5 · 2K · 实测约 6 积分/张</span></div>
    <div class="panel">
      
      <table>
        <thead><tr><th>资产</th><th>比例</th><th>硬要求</th></tr></thead>
        <tbody>
          <tr><td>角色 C0X</td><td>3:4</td><td>全身正面、纯白底、含鞋、不持物、中性表情、真实人体比例</td></tr>
          <tr><td>场景 S0X</td><td>16:9 / 9:16</td><td>画面里没有人；正打 / 反打 / 侧面全景各一张</td></tr>
          <tr><td>道具 P0X</td><td>1:1</td><td>纯白底单独展示</td></tr>
        </tbody>
      </table>
    </div>

    <div class="sec-head"><h2>模型与积分</h2><span class="sub">实测报价（2026-11，cn 区），以 model list 实时结果为准</span></div>
    <div class="panel">
      <table>
        <thead><tr><th>用途</th><th>模型 · 参数</th><th class="num">积分</th></tr></thead>
        <tbody>${MODELS.map(([use, model, credits]) => `<tr><td>${esc(use)}</td><td>${esc(model)}</td><td class="num">${esc(credits)}</td></tr>`).join('')}</tbody>
      </table>
    </div>

    <div class="sec-head"><h2>项目目录</h2></div>
    <div class="panel">
      <div class="pre">项目目录/
  project.json           画幅/分辨率/画布 id/资产表/每集状态（工具与页面都只读写这一份）
  剧本.md  资产提示词.md
  E01_分镜提示词.md …    存档版（给人看：弧线/台词表/检查记录/尾帧描述 + --- + 正文）
  E01_prompt.txt …       纯正文（给模型：出片时工具直接读这份）
  assets/                C01.png S01.png …
  videos/                E01.mp4 …
  out/                   final.mp4</div>
    </div>

    <div class="sec-head"><h2>常见问题</h2></div>
    <div class="panel">
      <dl class="kv">
        <dt>成片全哑</dt><dd>几乎都是【声音】段缺口型声明或台词没写在说话那一刻。realman_check 会把这类问题标成 error，修完再出片。</dd>
        <dt>人物换脸</dt><dd>资产图先出（全身+纯白底锁形象），每集用资产节点作参考（m2v）；跳过「资」直接拍必换脸。</dd>
        <dt>跨集衔接</dt><dd>第 2 集起 episode 的 refs 写上一集集号（如 "E01"），用已出片视频做抽帧接力/延长。</dd>
        <dt>产物有水印</dt><dd>即梦会在产物左上角打「AI生成」，是平台行为，CLI 侧去不掉；提示词结尾写「无字幕、无水印」能压掉生成字幕/水印。</dd>
        <dt>积分上限</dt><dd>图片默认 10 / 张，视频默认 150 / 集。报价超过上限会直接拒绝，不会静默扣费。</dd>
        <dt>历史在哪</dt><dd>侧栏「生成历史」和 realman_history 工具读的是同一份 $DSH_HOME/realman-studio/history.json。</dd>
      </dl>
    </div>

    <div class="sec-head"><h2>授权</h2></div>
    <div class="panel card-sub">
      插件代码与随包 skill（seedance-storyboard-generator-realman，含费曼示例）同作者同源，均 MIT（见 skills/seedance-storyboard-generator-realman/NOTICE.md；示例的资产参考图未随包携带）。
    </div>
  `)
}

// ---------------------------------------------------------------- 启动

async function boot() {
  try {
    const catalog = await api('/api/catalog')
    state.catalog = catalog
    const p = catalog.stats.projects
    const h = catalog.stats.history
    navProjects.textContent = p.count || ''
    navHistory.textContent = h.total || ''
    const health = state.health || catalog.health
    renderRail(catalog, health)
  } catch (err) {
    state.error = String(err.message)
    app.innerHTML = `<div class="wrap"><div class="empty-box"><b>读不到工坊数据</b>${esc(err.message)}<br>
      插件可能刚装好，刷新页面再试；如果一直这样，看看 DSH 的插件日志。</div></div>`
    return
  }
  // 健康状态单独拉：后端缓存 20 秒，页面不用等它才能渲染
  api('/api/health').then((h) => {
    state.health = h
    renderRail(state.catalog, h)
    // 概览页要显示「即梦未登录」提示，拿到状态后补一次渲染
    if (route() === '') renderHome()
  }).catch(() => {})
  render()
}

function renderRail(catalog, health) {
  const auth = (health && health.auth) || (catalog.health && catalog.health.auth) || {}
  const cli = (health && health.cli) || {}
  const ff = (health && health.ffmpeg) || {}
  const acct = auth.loggedIn
    ? `即梦 <b>${esc(auth.displayName || '')}</b> · ${esc(String(auth.credits ?? '?'))} 分`
    : '即梦未登录'
  railFoot.innerHTML = `
    <div class="acct"><span class="dot" style="background:${auth.loggedIn ? 'var(--ok)' : 'var(--bad)'}"></span><span>${acct}</span></div>
    <span class="txt">${ff.ffmpeg ? 'ffmpeg 就绪' : 'ffmpeg 缺失'} · CLI ${esc(cli.version || '?')}</span>
    <span class="txt">${catalog.stats.projects.count} 个项目 · ${catalog.stats.history.total} 次生成</span>
    <span class="txt">v${esc(catalog.version || '')}</span>`
}

addEventListener('hashchange', () => { if (route() !== 'new') state.current = null; render() })
boot()
