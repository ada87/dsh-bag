import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from './engine.js'
import type { CommandRuntimeLike, HostContext, SettingsService, WebServerService } from './host.js'
import { BASE_PATH, type SkillScan, type Status } from './protocol.js'
import { createHandler } from './routes.js'

export const name = 'dsh-bag'
export const inject = ['webServer']

const VERSION = readVersion()

/**
 * Portable config sync for DeepSeek Harness.
 *
 * Selected settings namespaces and profile files travel through any folder a
 * user already syncs (iCloud, OneDrive, Dropbox, Syncthing, a network share).
 * Each device writes its own snapshot file, so a dumb sync client cannot
 * clobber another machine's work.
 */
export async function apply(ctx: HostContext): Promise<void> {
  const webServer = ctx.webServer ?? (ctx.get('webServer') as WebServerService | undefined)
  if (webServer === undefined) throw new Error('dsh-bag: the webServer service is required')

  const settings = (ctx.get('settings') as SettingsService | undefined) ?? ctx.settings
  const home = resolveHome()
  const engine = new SyncEngine({
    home,
    ...(settings === undefined ? {} : { settings }),
    logger: {
      info: message => console.log(message),
      warn: message => console.warn(message),
    },
  })
  await engine.start()

  const handler = createHandler({ ctx, engine, version: VERSION })
  ctx.effect(() => {
    const dispose = webServer.register({ kind: 'prefix', path: BASE_PATH, handler })
    console.log(`[dsh-bag] listening at ${BASE_PATH} (sync state: ${join(home, 'state', 'dsh-bag')})`)
    return dispose
  }, 'dsh-bag: routes')

  const commands = ctx.get('commands') as CommandRuntimeLike | undefined
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'bag',
      description: 'Scan other agents for skills, import them, or show the pack status',
      input: { hint: 'scan | import <name...> | status' },
      handler: async ({ rawInput }) => {
        const [verb, ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
        try {
          if (verb === undefined || verb === 'scan') {
            return { kind: 'success', text: formatScan(await engine.scanSkills()) }
          }
          if (verb === 'import') {
            if (rest.length === 0) return { kind: 'error', text: '用法: /bag import <skill> [skill...]' }
            const result = await engine.importSkills(rest)
            const lines = [
              result.imported.length > 0 ? `已导入 ${result.imported.length} 个 skill 到 ${result.target}` : '没有导入任何 skill',
              ...result.imported.map(name => `  + ${name}`),
              ...result.skipped.map(entry => `  ! ${entry.name}: ${entry.reason}`),
              '下一步：Settings → 配置袋 → 比较 → 应用（skill 属于可执行变更，需要确认）',
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
          if (verb === 'status') {
            return { kind: 'success', text: formatStatus(await engine.status()) }
          }
          return { kind: 'error', text: '用法: /bag [scan | import <name...> | status]' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }), 'dsh-bag: command')
  }
}

function resolveHome(): string {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const value = JSON.parse(raw) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function formatScan(scan: SkillScan): string {
  const lines = [`Claude Code skills: ${scan.root}`]
  if (scan.found.length === 0) {
    lines.push('  没有找到可导入的 skill 目录（需要 <name>/SKILL.md）')
  } else {
    for (const item of scan.found) {
      lines.push(`  ${item.compatible ? '✓' : '!'} ${item.name}${item.description ? ` — ${item.description}` : ''}`)
      if (item.issues.length > 0) lines.push(`      ${item.issues.join('; ')}`)
    }
  }
  for (const warning of scan.warnings) lines.push(`  · ${warning}`)
  if (scan.found.length > 0) {
    lines.push('', '导入: /bag import <name...>，或在 Settings → 配置袋 多选。')
  }
  return lines.join('\n')
}

function formatStatus(status: Status): string {
  return [
    `设备: ${status.device.name}`,
    `同步目录: ${status.syncDir || '(未配置)'}`,
    `本地 ${status.counts.localItems} 项 · 远端 ${status.counts.remoteItems} 项 · ${status.counts.remoteDevices} 台设备`,
    `已选: ${status.counts.selectedNamespaces} 个设置命名空间 · ${status.counts.selectedFiles} 个文件 · ${status.counts.selectedSkills} 个 skill`,
    `上次写入: ${status.journal === 'incomplete' ? '未完成，需要修复' : '正常'}`,
    ...status.warnings.map(warning => `· ${warning}`),
  ].join('\n')
}
