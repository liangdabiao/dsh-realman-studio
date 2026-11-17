// skill 提供方：把随包的 skills/seedance-storyboard-generator-realman（真人感版）注册进 DSH 的 skill 目录。
// 用户自己在 ~/.dsh/skills 或项目里装了同名 skill 时，那一份优先（本提供方 rank 600，排在后面）。
// 加载正文时把 <SKILL_ROOT> 换成实际目录，并在末尾追加「在这个插件里怎么用」。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const field = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

export function readSkills(dirs) {
  return [].concat(dirs).flatMap(readDir)
}

function readDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
    .filter((s) => s.name)
}

// 原仓库是给 git clone 用的，插件里的这一份是快照：没有 .git，也不要自己更新。
export const REWRITES = {}

export function rewrite(skill) {
  let body = skill.body
  for (const [from, to] of REWRITES[skill.name] || []) body = body.replace(from, to)
  return body
}

function addendum(skill) {
  return [
    '',
    '---',
    '',
    '## 在「真人剧工坊」插件（DSH）里使用',
    '',
    `- 本 skill 的目录是 \`${skill.dir}\`；上文提到的 \`references/…\`（真人感电影写实指南 / apiz 备选通道）与 \`example/\`（费曼《不一样的工具箱》完整案例）都相对这个目录。`,
    '- 这是插件随包快照：不要运行 `git pull` / `npm install`，也不要向用户提更新。skill 随插件版本一起变。',
    '- 创作（剧本/分镜/提示词）完全按本 skill 写，工具不会替你补内容；插件只负责执行生成与机械安检。',
    '- 本插件默认真人实拍质感（init 默认 styleDescription「真人实拍质感，35毫米胶片摄影观感」）；用户点名二维/水墨/广告等题材时按指南 §5 换质感，分镜写法不变。',
    '- 不要只把提示词交给用户去平台粘贴：出图和出片走插件提供的工具，产物落在项目目录里。',
    '',
    '### 项目目录约定（双文件）',
    '',
    '每部真人剧一个目录，里面是文档 + `project.json` + 产物：',
    '',
    '```',
    '<项目目录>/',
    '  project.json            # 工具读写：风格/基调/卖点、画幅/分辨率、资产表、每集状态',
    '  剧本.md  资产提示词.md   # 按 skill 格式手写（△镜头 + 角色名（情绪）：台词；C/S/P 资产）',
    '  E01_分镜提示词.md …     # 存档版（给人看：弧线/台词表/检查记录/尾帧描述 + --- + 正文）',
    '  E01_prompt.txt …        # 纯正文（给模型：从「生成一段」起；出片时工具直接读这份）',
    '  assets/   C01.png S01.png P01.png …',
    '  videos/   E01.mp4 …',
    '  out/      final.mp4',
    '```',
    '',
    '### 标准执行顺序',
    '',
    '1. `realman_project`（action: env）确认即梦官方 CLI（dreamina-canvas）可用、是否已登录、积分多少。没登录就 `action=login` 拿授权链接给用户，授权后 `action=login-check`。',
    '2. `realman_project`（action: init）建项目：path 用绝对路径，写 title / aspect（默认 16:9）/ episodes / episodeSeconds（默认 15）/ resolution（默认 480p）/ styleDescription（默认真人写实+35毫米胶片）/ tone / hook / paletteZh（色盘，可选但建议）。',
    '3. 按 skill 的格式写 `剧本.md`、`资产提示词.md`，逐集写 `E0X_分镜提示词.md`（存档版）并导出同名 `E0X_prompt.txt`（纯正文）（用普通文件写入工具，不要用工具代写）。范式可参考 `example/` 费曼案例。',
    '4. `realman_check`（action: all）机械事故安检：纯净性（txt 从「生成一段」起、无文档头混入）、防全哑（缺【声音】段/口型声明=error）、台词重复（error）、时间轴格式（可解析/连续/与声明秒数一致）、资产 C/S/P 与锁形象硬要求、每集 txt↔md 正文一致性。**它只拦机械事故，不评判创作**；有 ❌ 修完再出片，⚠️/ℹ️ 自行斟酌。',
    '5. `realman_project`（action: update）把资产和分镜登记进 project.json：`patch` 传 JSON 字符串，填 `assets[]`（id/kind/name/ratio/prompt）和 `episodes[]`（id/refs/prompt 或 promptFile/storyboard）。提示词原样保留。',
    '6. `realman_asset`（action: generate）逐张出图：每张会在即梦画布上建一个图片节点、等待生成、下载到 `assets/`。失败或要换提示词的用 `action: retry`。',
    '7. `realman_episode`（action: generate）出某集视频：提示词取值链 args.prompt → project.json 该集 prompt → 该集 `E0X_prompt.txt`；资产图按 refs 顺序作参考（m2v）。**第 2 集起 refs 可直接写上一集集号（如 "E01"）**，用已出片视频做抽帧接力/延长。',
    '8. `realman_assemble` 把各集拼成 `out/final.mp4`（可选 `audio` 贴旁白音轨）。',
    '',
    '### 画布与积分',
    '',
    '- 每次生成都会在项目对应的即梦画布上落节点：`realman_project action=canvas` 会打印画布链接，用户可以在即梦里接着改、放大、再生成。',
    '- 生成要花积分：`maxCredits` 是单次上限（图片默认 10，视频默认 150），报价超过上限会被拒绝，不会静默扣费。批量前先 env 看余额。',
    '- 15 秒一集的报价差别很大（实测）：默认 `seedance_2.5_flash` 480p 约 105 分、720p 约 285 分；`seedance_2.5` 720p 约 300 分。余额少时保持 480p，满意后再考虑 720p 重出。',
    '- 图片 `seedream_5.5` 2K 实测约 3 分/张。注意 `seedance_2.0_*` 系列没有原生语音口型，真人剧的对白红线依赖 2.5 系，不要为省钱换到 2.0。',
    '- 先 `dryRun: true` 看要执行的命令和参考顺序，再真跑。',
    '',
    '### 纪律',
    '',
    '- 三条红线（skill 铁律，安检会拦前两条的机械面）：台词逐字写在说话那一刻且只写一次+【声音】段统一口型声明（防全哑）；纯正文 txt 纯净（文档头绝不喂模型）；一致性靠参考图不靠文字禁令。',
    '- 角色资产必须「全身正面 + 纯白背景」；场景无人、按正打/反打/侧面；道具白底单独展示（缺锁形象项安检会 warn）。',
    '- 一次不要同时开超过 4 个生成任务；即梦排队时 collect 返回 pending 是正常的。',
    '- 每集默认 15 秒；Seedance 2.5 Flash m2v 参考上限：图片 10 张、视频 5 个，超了工具会拒绝。',
    '- 禁止直接使用真实人物的照片或名人面孔，角色一律用「虚构的相似气质演员」设定（skill 真人红线）。',
    '- 生成会消耗用户即梦积分：批量出图前先用 env 看一眼积分，数量大时先跟用户确认。',
    '- 产物路径不要写到项目目录之外；工具会拒绝越界路径。',
    ''
  ].join('\n')
}

export function createSkillProvider(dir, pluginRoot) {
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'realman-studio',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir }
  })

  return {
    name: 'realman-studio',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const s = readSkills(dir).find((x) => x.dir === c.locator && x.name === c.name)
      if (!s) return undefined
      const content = rewrite(s).replaceAll('<SKILL_ROOT>', s.dir).replaceAll('<PLUGIN_ROOT>', pluginRoot) + addendum(s)
      const { rank, locator, ...summary } = candidate(s)
      return { ...summary, content }
    }
  }
}
