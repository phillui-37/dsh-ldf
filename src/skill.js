import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const roots = ['.agents', '.claude', '.codex', '.opencode']
const maxSkillBytes = 512 * 1024

function declaredName(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]
  const match = frontmatter?.match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*$/m)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

export function findInstalledSkill(expectedName) {
  let invalid = false
  let unreadable = false
  for (const root of roots) {
    const file = join(homedir(), root, 'skills', expectedName, 'SKILL.md')
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > maxSkillBytes) {
        invalid = true
        continue
      }
      const content = readFileSync(file, 'utf8')
      if (declaredName(content) === expectedName) return { status: 'found', path: file, content }
      invalid = true
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
      unreadable = true
    }
  }
  return { status: unreadable ? 'unreadable' : invalid ? 'invalid' : 'missing' }
}

export function warnSkillFallback(pluginName, result) {
  const reason = result.status === 'missing'
    ? 'no installed matching SKILL.md was found'
    : result.status === 'invalid'
      ? 'the installed SKILL.md was invalid or exceeded the size limit'
      : 'the installed SKILL.md could not be read'
  console.warn(`[${pluginName}] Upstream skill mode requested, but ${reason}; using plugin guidance.`)
}
