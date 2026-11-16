import assert from 'node:assert/strict'
import test from 'node:test'
import { hasVolatile, projectVolatile } from '../lib/settings.js'

const schema = {
  type: 'object',
  dict: {
    theme: { meta: { volatile: true } },
    density: { meta: { volatile: true } },
    model: {},
    nested: {
      type: 'object',
      dict: {
        live: { meta: { volatile: true } },
        restart: {},
      },
    },
  },
}

test('a namespace with a volatile field is selectable', () => {
  assert.equal(hasVolatile(schema), true)
  assert.equal(hasVolatile({ type: 'object', dict: { model: {} } }), false)
  assert.equal(hasVolatile({ type: 'object', meta: { volatile: true } }), true)
})

test('projectVolatile drops non-volatile fields', () => {
  const value = {
    theme: 'dark',
    density: 'cozy',
    model: 'x',
    nested: { live: 1, restart: 2 },
  }
  assert.deepEqual(projectVolatile(schema, value), {
    theme: 'dark',
    density: 'cozy',
    nested: { live: 1 },
  })
})

test('an all-volatile root keeps the whole layer', () => {
  const root = { type: 'object', meta: { volatile: true }, dict: {} }
  assert.deepEqual(projectVolatile(root, { a: 1 }), { a: 1 })
})

test('a namespace without volatile fields projects to nothing', () => {
  const none = { type: 'object', dict: { model: {} } }
  assert.equal(projectVolatile(none, { model: 'x' }), undefined)
})
