import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from './engine.js'
import type { HostContext, SettingsService, WebServerService } from './host.js'
import { BASE_PATH } from './protocol.js'
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
