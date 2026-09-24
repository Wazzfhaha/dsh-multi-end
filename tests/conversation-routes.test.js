import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerConversations } from '../src/index.js'

test('conversation routes use the authenticated Connection registry and suppress remote error details', async () => {
  const routes = new Map(), effects = []
  let disposed = 0
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route); return () => { disposed++ } } } }, effect(factory) { effects.push(factory()) } }
  await registerConversations(ctx, { close() { disposed++ }, async command() { throw Error('secret-cookie remote stack trace') } })
  assert.equal(routes.size, 6)
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  }
  const response = await routes.get('/api/ssh-workspaces/command').fetch(new Request('http://localhost/api/ssh-workspaces/command', { method: 'POST', body: '{}' }))
  assert.equal(response.status, 400)
  assert.equal((await response.text()).includes('secret-cookie'), false)
  for (const effect of effects) await effect()
  assert.equal(disposed, 7)
})

test('a cancelled connect request releases its opaque handle instead of orphaning the connection', async () => {
  const routes = new Map(), abort = new AbortController()
  let released
  await registerConversations({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } }, effect() {} }, {
    async connect() { abort.abort(); return { connectionId: 'private-handle' } },
    disconnect(id) { released = id }, close() {}
  })
  const response = await routes.get('/api/ssh-workspaces/connect').fetch(new Request('http://localhost/api/ssh-workspaces/connect', { method: 'POST', body: '{}', signal: abort.signal }))
  assert.equal(response.status, 400)
  assert.equal(released, 'private-handle')
})

test('connection failure reports only the safe stage, not the remote error', async () => {
  const routes = new Map()
  await registerConversations({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } }, effect() {} }, {
    async connect() { throw Object.assign(Error('private token and remote stack'), { connectStage: 'events' }) }, close() {}
  })
  const response = await routes.get('/api/ssh-workspaces/connect').fetch(new Request('http://localhost/api/ssh-workspaces/connect', { method: 'POST', body: '{}' }))
  const body = await response.text()
  assert.equal(response.status, 400)
  assert.match(body, /事件流未建立/)
  assert.doesNotMatch(body, /private token|remote stack/)
})
