import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SyncError, messageOf } from '../errors.js'
import type { ImportedSkill, SkillScan, SkillValue } from '../protocol.js'
import { assertClean, scanText } from '../secret-scan.js'
import {
  SKILL_NAME_RE,
  readSkillDir,
  skillBytes,
  skillHash,
  writeSkillDir,
} from '../skills.js'

/** User-level Claude Code skills directory. */
export function claudeSkillsRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR
  const base = configured !== undefined && configured.trim() !== '' ? configured.trim() : join(homedir(), '.claude')
  return join(base, 'skills')
}

const CLAUDE_ONLY = /\b(?:TodoWrite|WebFetch|NotebookEdit|AskUserQuestion|SlashCommand)\b|\bTask\s*\(/
const ABSOLUTE_PATH = /(?:^|[\s"'`])(?:\/Users\/|\/home\/|[A-Za-z]:\\|~\/)/m

/**
 * Read-only scan of user-level Claude Code skills. A skill is a directory
 * with SKILL.md; flat `<name>.md` files are reported but not imported in v1.
 */
export async function scanClaudeSkills(): Promise<SkillScan> {
  const root = claudeSkillsRoot()
  const warnings: string[] = []
  const found: ImportedSkill[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root, found, warnings: [`no Claude Code skills directory at ${root}`] }
    }
    return { root, found, warnings: [`could not read ${root}: ${messageOf(error)}`] }
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue
    if (entry.isSymbolicLink()) {
      warnings.push(`skipped symlink: ${entry.name}`)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      warnings.push(`flat skill ${entry.name} is not imported in v1; convert it to a directory with SKILL.md`)
      continue
    }
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (!SKILL_NAME_RE.test(name)) {
      warnings.push(`skipped directory with an invalid skill id: ${name}`)
      continue
    }
    try {
      const value = await readSkillDir(root, name)
      if (value === undefined) {
        warnings.push(`skipped ${name}: no SKILL.md`)
        continue
      }
      const instruction = instructionText(value)
      if (instruction === undefined) {
        warnings.push(`skipped ${name}: no readable SKILL.md`)
        continue
      }
      const meta = frontmatter(instruction)
      const issues: string[] = []
      if (typeof meta.name !== 'string' || meta.name.trim() === '') issues.push('frontmatter is missing name')
      if (typeof meta.description !== 'string' || meta.description.trim() === '') issues.push('frontmatter is missing description')
      if (typeof meta.name === 'string' && meta.name !== name) issues.push(`frontmatter name "${meta.name}" differs from the directory`)
      if (ABSOLUTE_PATH.test(instruction)) issues.push('contains an absolute path')
      if (CLAUDE_ONLY.test(instruction)) issues.push('references a Claude Code-only tool')
      if (meta['allowed-tools'] !== undefined) issues.push('uses allowed-tools, which dsh does not read')
      found.push({
        name,
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
        path: join(root, name),
        files: Object.keys(value.files).length,
        bytes: skillBytes(value),
        hash: skillHash(value),
        compatible: issues.length === 0,
        issues,
      })
    } catch (error) {
      warnings.push(`could not read ${name}: ${messageOf(error)}`)
    }
  }
  return { root, found, warnings }
}

/** Copy selected Claude Code skills into the dsh skills root. */
export async function importClaudeSkills(
  names: readonly string[],
  targetRoot: string,
): Promise<{ imported: string[]; skipped: Array<{ name: string; reason: string }> }> {
  if (names.length === 0) throw new SyncError('validation', 'select at least one skill')
  const sourceRoot = claudeSkillsRoot()
  const imported: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []

  for (const name of names) {
    if (!SKILL_NAME_RE.test(name)) {
      skipped.push({ name, reason: 'invalid skill id' })
      continue
    }
    const value = await readSkillDir(sourceRoot, name)
    if (value === undefined) {
      skipped.push({ name, reason: 'source skill no longer exists' })
      continue
    }
    for (const [rel, file] of Object.entries(value.files)) {
      if (file.encoding !== 'utf8') continue
      try {
        assertClean(scanText(rel, file.data))
      } catch (error) {
        skipped.push({ name, reason: messageOf(error) })
        break
      }
    }
    if (skipped.some(entry => entry.name === name)) continue
    const existing = await readSkillDir(targetRoot, name)
    if (existing !== undefined) {
      if (skillHash(existing) === skillHash(value)) {
        skipped.push({ name, reason: 'already present' })
      } else {
        skipped.push({ name, reason: 'a different skill with this name already exists' })
      }
      continue
    }
    const info = await stat(join(sourceRoot, name)).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      skipped.push({ name, reason: 'source skill no longer exists' })
      continue
    }
    const stamped: SkillValue = {
      ...value,
      source: { adapter: 'claude-code', path: join(sourceRoot, name), hash: skillHash(value) },
    }
    await writeSkillDir(targetRoot, stamped)
    imported.push(name)
  }

  return { imported, skipped }
}

function instructionText(value: SkillValue): string | undefined {
  const file = value.files['SKILL.md'] ?? value.files[`${value.name}.md`]
  return file !== undefined && file.encoding === 'utf8' ? file.data : undefined
}

/** Minimal YAML frontmatter reader: top-level scalar keys only. */
export function frontmatter(text: string): Record<string, string> {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return {}
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return {}
  const out: Record<string, string> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key === undefined) continue
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value.trim()
  }
  return out
}
