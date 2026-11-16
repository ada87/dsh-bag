/**
 * Minimal structural view of the dsh Host services this plugin consumes.
 *
 * The plugin deliberately does not import dsh implementation modules at
 * runtime: the Host owns their instances. These shapes document exactly what
 * the plugin needs and keep the bundle free of dsh sources.
 */

export interface HostRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string; remotePort?: number }
  on(event: 'close' | 'aborted', listener: () => void): void
  off?(event: 'close' | 'aborted', listener: () => void): void
  resume?(): void
}

export interface HostResponse {
  statusCode: number
  headersSent: boolean
  setHeader(name: string, value: string | string[]): void
  writeHead(status: number, headers?: Record<string, string | string[]>): void
  write(chunk: string): boolean
  end(chunk?: string): void
  readonly writableEnded: boolean
  readonly destroyed?: boolean
  on(event: 'close' | 'error', listener: () => void): void
  flushHeaders?(): void
}

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: HostRequest, res: HostResponse) => void | Promise<void>
}

export interface WebServerService {
  register(route: WebRoute): () => void
  readonly host?: string
  readonly port?: number
  readonly protocol?: 'http:' | 'https:'
  getOrigin?(): string
}

export interface ConnectionService {
  admit(request: { headers: Record<string, string | string[] | undefined> }): {
    peer?: unknown
    rejection?: number
  }
}

/** One path-addressed edit to a settings namespace's user section. */
export type SettingsPathOpLike =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export interface SettingsDescriptorLike {
  ns: string
  autoGenerate?: boolean
  schema?: unknown
  value?: unknown
  revision: number
  base?: unknown
  user?: unknown
  applies?: 'live'
  secrets?: Array<{ path: string[]; set: boolean }>
}

export interface SettingsService {
  readonly writable?: boolean
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[]
  mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision?: number): Promise<void>
}

export interface HostContext {
  webServer?: WebServerService
  settings?: SettingsService
  effect(fn: () => void | (() => void), label?: string): unknown
  get(name: string): unknown
}
