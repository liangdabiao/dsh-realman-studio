# 真人剧工坊（dsh-realman-studio）

把 [seedance-storyboard-generator-realman](https://github.com/liangdabiao/seedance-storyboard-generator-realman) 这套「真人实拍质感 Seedance 分镜」skill 搬进 DeepSeek Harness，并接上**即梦官方 CLI（dreamina-canvas）**：
一句话故事 → 剧本 / 资产图 / 每集 15 秒真人感分镜 → 在即梦画布上出图出片 → 拼成一部片，全程不用离开对话。
与「上美影短剧工坊」（动画风）、「分镜导演台」（题材通用）三足鼎立——这个专攻**真人实拍质感**：原生语音口型、35 毫米胶片感、费曼式学术悬疑也能拍。

## 装了什么

| 能力 | 说明 |
|---|---|
| skill `seedance-storyboard-generator-realman` | 随包快照：SKILL.md + 真人感电影写实指南 + apiz 备选通道 + 费曼《不一样的工具箱》完整案例（剧本/资产/五集分镜/成片抽帧） |
| `realman_project` | 建项目、读进度、登记资产/分镜；即梦登录、查积分、建画布 |
| `realman_check` | 出片前机械事故安检：纯净性（txt 只喂纯正文）、防全哑（缺【声音】/口型声明）、台词重复、时间轴格式、资产锁形象硬要求、txt↔md 一致性。**只拦事故，不评判创作** |
| `realman_asset` | 每个资产在画布上建图片节点 → 等待生成 → 下载到 `assets/` |
| `realman_episode` | 每集建视频节点（m2v，资产节点作参考；refs 可写上一集集号做抽帧接力）→ 等待 → 下载到 `videos/`；提示词默认读该集 `E0X_prompt.txt` |
| `realman_assemble` | ffmpeg 把各集拼成 `out/final.mp4`，可选贴旁白音轨 |
| `realman_history` | 查生成历史：列表 / 单条详情 / 积分汇总 / 清空 |
| 侧栏「真人剧工坊」 | 工作台：概览 · 我的真人剧 · 生成历史 · 新建真人剧 · 文-资-视-剪 |

**分界线**：写剧本/分镜/提示词是模型按随包 skill 的创作，插件不生成、不改写、不评判内容；工具只管执行生成与机械安检。

## 前置

即梦官方 CLI（带 OAuth 登录、画布、积分审批，和 npm 上的第三方 `jimeng-cli` 不是一回事）：

```powershell
irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex
dreamina-canvas --format json version
```

装完让模型跑 `realman_project action=login` 拿授权链接，扫码后 `action=login-check`。
拼接还需要 `ffmpeg`。

## 项目目录（真人感双文件约定）

```
<项目目录>/
  project.json           # 工具读写：风格/画幅/分辨率/画布 id/资产表/每集状态
  剧本.md  资产提示词.md  # △镜头 + 角色名（情绪）：台词；C/S/P 资产
  E01_分镜提示词.md …     # 存档版（给人看：弧线/台词表/检查记录/尾帧描述 + --- + 正文）
  E01_prompt.txt …       # 纯正文（给模型：从「生成一段」起；出片时工具直接读这份）
  assets/                # C01.png S01.png …
  videos/                # E01.mp4 …
  out/                   # final.mp4
```

生成会复用同一张即梦画布，`project.json` 里记着画布 id 和每个节点的 nodeId，随时能回画布继续改。

## 侧栏工作台（布局对齐「分镜导演台」）

装好后侧栏多一个「真人剧工坊」，主区域是一个完整页面：

| 页面 | 内容 |
|---|---|
| 概览 | 在做的真人剧 / 资产图 / 已出片集 / 累计积分 / 生成次数；即梦登录状态与积分；最近项目、最近生成 |
| 我的真人剧 | 项目卡（封面、画幅、质感、资产与分集进度）；可换扫描目录、搜索 |
| 项目详情 | 资产墙（点图看大图、看 prompt 与积分）、分集（内嵌播放、重出本集、txt✓ 标记）、这个项目的生成记录、出图/出片/拼接按钮 |
| 生成历史 | 每次生成一条：时间、类型、项目、摘要、积分、成功/失败；可按类型/状态/项目/关键词筛 |
| 新建真人剧 | 填剧名、集数、画幅、分辨率、质感预设、色盘、故事梗概 → 打开新对话并带上「文-资-视-剪」全流程指令 |
| 文-资-视-剪 | 四步工作流、三条红线摘要、模型报价表、项目目录结构、常见问题 |

页面按钮和工具走同一套代码：路径校验、积分上限（图片 10 / 视频 150）、错误文案完全一致；
点「新建真人剧 / 在对话里继续」不会自动发消息，只是把写好的指令填进新对话的输入框。

**生成历史存在哪**：`$DSH_HOME/realman-studio/history.json`（默认 `C:\Users\<你>\.dsh\realman-studio\`），
页面和 `realman_history` 工具读的是同一份。历史最多保留 400 条，只删记录不动产物。

首次装好或改了 `client.js` 后刷新一次页面（Ctrl+R）；**改了 Host 半边（`lib/`、`index.js`）需要重启一次 DeepSeek Harness**（会话记录不受影响）。

## 典型流程

1. `realman_project action=env`：CLI、登录、积分、模型一次看清
2. `action=init` → 模型按 skill 写 剧本/资产提示词/每集双文件 → `action=update` 登记 assets 与 episodes
3. `realman_check action=all`：出片前安检（error 修完再烧积分）
4. `realman_asset action=generate`（可先 `dryRun: true`）
5. `realman_episode action=generate`（逐集；第 2 集起 refs 写上一集集号做抽帧接力）
6. `realman_assemble` → `out/final.mp4`
7. `realman_history action=stats`：总共花了多少积分

## 限制与费用

实测报价（2026-11，cn 区）：

| 用途 | 模型 · 参数 | 积分 |
|---|---|---|
| 资产图 | `seedream_5.5` · 2K | 约 3/张 |
| 单集 15s | `seedance_2.5_flash` · 480p（默认） | 约 105 |
| 单集 15s | `seedance_2.5_flash` · 720p | 约 285 |
| 单集 15s | `seedance_2.5` · 720p | 约 300 |

- 默认模型选 `seedance_2.5_flash` 是因为它有**原生语音口型**——真人感的对白红线（台词写在说话那一刻+口型声明）只有 2.5 系能兑现；`seedance_2.0_*` 系没有原生口型，真人剧不要为省钱换过去。
- 生成消耗即梦积分；`maxCredits` 是单次上限（图片默认 10、视频默认 150），报价超过上限直接拒绝，不会静默扣费。
- Seedance 2.5 Flash m2v 参考上限：图片 10 张、接力视频 5 个。
- 出片是慢操作：一个视频节点通常几分钟，工具会等终态再下载。
- 即梦会在产物左上角打「AI生成」水印，这是平台行为，CLI 侧去不掉。

## 自检

```powershell
node test/lib.test.mjs     # 数据层 + 机械安检内核 25 项单测（含费曼金标准示例零 error 回归）
node scripts/api-test.mjs  # 起本地 http，打一遍 catalog / project / history / 静态页面（不花积分）
node scripts/client-smoke.mjs # 浏览器半边能否被 __ModuleLoader__ 接住、两个 slot 都注册
node scripts/selftest.mjs  # 数据层 + realman_check 正反例 + CLI 探活 + ffmpeg 拼接（不建节点、不花积分）
```

`api-test.mjs` 会把 `$DSH_HOME` 指到 `.tmp/` 下的临时目录，不碰你的真实历史。

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-realman-studio
```

## 许可

插件代码 MIT（见 `LICENSE`）。`skills/seedance-storyboard-generator-realman` 是同作者自有仓库的随包快照，同 MIT；
快照与上游的差异（未携带资产参考图大图等）记录在 `skills/seedance-storyboard-generator-realman/NOTICE.md`。

特别致谢社区支持： https://linux.do
