// 真人剧工坊 · Host 半边
// 1. 把随包的 skill（skills/seedance-storyboard-generator-realman）注册进 ctx.skills，模型和 /skill 都能用
// 2. 注册六个工具（lib/tools.js）：项目管理、真人感格式自检、批量出图、单集出片、拼接、生成历史
// 3. /realman-studio 工作台：静态页面（lab/）+ 数据接口（lib/api.js）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerApi } from './lib/api.js'
import { createSkillProvider } from './lib/skills.js'
import { TOOLS } from './lib/tools.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const SKILL_DIRS = [join(ROOT, 'skills')]

export const name = 'realman-studio'
export const inject = ['webServer', 'skills', 'tools']

export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(SKILL_DIRS, ROOT)))
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() => registerApi(ctx))
}
