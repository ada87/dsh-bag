import { HttpError, messageOf } from './errors.js'
import type { SyncEngine } from './engine.js'
import type { HostContext, HostRequest, HostResponse } from './host.js'
import { assertTrusted, readJson, sendJson } from './http.js'
import { BASE_PATH } from './protocol.js'
import { FILE_SPECS } from './policy.js'

export interface RouteDeps {
  ctx: HostContext
  engine: SyncEngine
  version: string
}

/** One prefix handler owning every `/dsh-bag/*` route. */
export function createHandler(deps: RouteDeps): (req: HostRequest, res: HostResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(BASE_PATH)) throw new HttpError(404, 'not-found', 'not found')
      const segments = url.pathname
        .slice(BASE_PATH.length)
        .split('/')
        .filter(segment => segment.length > 0)
        .map(segment => decodeURIComponent(segment))

      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, name: 'dsh-bag', version: deps.version, protocol: 1 })
        return
      }

      assertTrusted(deps.ctx, req)

      if (segments[0] !== 'api') throw new HttpError(404, 'not-found', 'not found')
      const route = segments.slice(1)

      if (method === 'GET' && route.length === 1 && route[0] === 'status') {
        sendJson(res, 200, await deps.engine.status())
        return
      }
      if (method === 'GET' && route.length === 1 && route[0] === 'config') {
        sendJson(res, 200, await deps.engine.config())
        return
      }
      if (method === 'PUT' && route.length === 1 && route[0] === 'config') {
        const body = (await readJson(req)) as { patch?: unknown } | undefined
        sendJson(res, 200, await deps.engine.updateConfig(body?.patch))
        return
      }
      if (method === 'GET' && route.length === 1 && route[0] === 'namespaces') {
        sendJson(res, 200, { namespaces: await deps.engine.namespaces() })
        return
      }
      if (method === 'GET' && route.length === 1 && route[0] === 'files') {
        sendJson(res, 200, { files: FILE_SPECS.map(spec => ({ id: spec.id, label: spec.label, cls: spec.cls })) })
        return
      }
      if (method === 'POST' && route.length === 1 && route[0] === 'plan') {
        sendJson(res, 200, await deps.engine.plan())
        return
      }
      if (method === 'POST' && route.length === 1 && route[0] === 'apply') {
        const body = (await readJson(req)) as Record<string, unknown> | undefined
        if (body === undefined) throw new HttpError(400, 'bad-body', 'apply expects a JSON body')
        sendJson(res, 200, await deps.engine.apply({
          planId: String(body.planId ?? ''),
          ...(Array.isArray(body.ids) ? { ids: body.ids.filter((id): id is string => typeof id === 'string') } : {}),
          ...(Array.isArray(body.decisions)
            ? {
              decisions: body.decisions.flatMap(decision => {
                if (decision === null || typeof decision !== 'object') return []
                const value = decision as Record<string, unknown>
                if (typeof value.id !== 'string' || typeof value.decision !== 'string') return []
                if (value.decision !== 'keep-local' && value.decision !== 'take-remote') return []
                return [{
                  id: value.id,
                  path: Array.isArray(value.path) ? value.path.filter((part): part is string => typeof part === 'string') : [],
                  decision: value.decision,
                }]
              }),
            }
            : {}),
          allowExecutable: body.allowExecutable === true,
        }))
        return
      }
      if (method === 'POST' && route.length === 1 && route[0] === 'push') {
        sendJson(res, 200, await deps.engine.push())
        return
      }
      if (method === 'POST' && route.length === 1 && route[0] === 'doctor') {
        sendJson(res, 200, await deps.engine.doctor())
        return
      }
      if (method === 'POST' && route.length === 1 && route[0] === 'recover') {
        sendJson(res, 200, await deps.engine.recover())
        return
      }

      throw new HttpError(404, 'not-found', `no route for ${method} ${url.pathname}`)
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // The client is gone.
        }
        console.warn('[dsh-bag] response failed:', messageOf(error))
        return
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      const code = (error as { code?: string }).code
      const status = code === 'validation' || code === 'config'
        ? 400
        : code === 'plan-stale' || code === 'executable' || code === 'verify'
          ? 409
          : code === 'secret'
            ? 422
            : 500
      if (status === 500) console.warn('[dsh-bag] request failed:', messageOf(error))
      sendJson(res, status, {
        error: {
          code: typeof code === 'string' ? code : 'internal',
          message: messageOf(error),
        },
      })
    }
  }
}
