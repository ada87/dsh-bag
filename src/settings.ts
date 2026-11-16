import { isPlainObject } from './util.js'

/**
 * dsh only accepts live settings writes for fields beneath a `volatile`
 * schema node. These helpers mirror `volatileForm` / `projectForm` from
 * `@deepseek-ai/dsh-settings` without importing it at runtime.
 */

interface SchemaNode {
  type?: string
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
  meta?: { volatile?: boolean }
}

function node(schema: unknown): SchemaNode | undefined {
  return isPlainObject(schema) ? (schema as SchemaNode) : undefined
}

/** Whether this namespace has at least one live-editable field. */
export function hasVolatile(schema: unknown): boolean {
  const root = node(schema)
  if (root === undefined) return false
  if (root.meta?.volatile === true) return true
  if (root.type !== 'object') return false
  return Object.values(root.dict ?? {}).some(child => hasVolatile(child))
}

/**
 * Keep only the live-editable subtree of a user layer. A non-volatile key is
 * dropped, so a write never addresses a field the Host would refuse.
 */
export function projectVolatile(schema: unknown, value: unknown): unknown {
  const root = node(schema)
  if (root === undefined) return undefined
  return projectNode(root, value)
}

function projectNode(schema: SchemaNode, value: unknown): unknown {
  if (schema.meta?.volatile === true) return value
  if (schema.type !== 'object' || !isPlainObject(value)) return undefined
  const out: Record<string, unknown> = {}
  let any = false
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    if (!Object.hasOwn(value, key)) continue
    const projected = projectNode(child, value[key])
    if (projected === undefined) continue
    out[key] = projected
    any = true
  }
  return any ? out : undefined
}
