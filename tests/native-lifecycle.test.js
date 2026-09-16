import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeGateway } from '../src/native-gateway.js'
import { NativeConnections } from '../src/native-connections.js'
import { setTimeout as delay } from 'node:timers/promises'

test('new session with a client-allocated ID is created in the selected remote workspace', async () => {
  const calls = []
  const gateway = new NativeGateway({ invoke() { throw Error('Must not use primary') } }, [{ id: 'remote', transport: { async invoke(request) {
    calls.push(request); return { sessionId: request.args.request.sessionId }
  } } }])
  const workspaceId = gateway.id('remote', 'workspace', 'workspace-1')
  const result = await gateway.invoke({ namespace: 'session', method: 'create', args: { request: { workspaceId, sessionId: 'session-new' } } })
  assert.equal(calls[0].args.request.workspaceId, 'workspace-1')
  assert.equal(calls[0].args.request.sessionId, 'session-new')
  assert.equal(gateway.owners.get(result.sessionId).host, 'remote')
  assert.equal(gateway.owners.get(result.sessionId).raw, 'session-new')
})

test('manual reconnect retains the host identity, closes the old carrier, and does not repeat failed prompts', async () => {
  let connects = 0, sends = 0, closed = 0
  const registry = new NativeConnections(async () => {
    connects++
    return { close() { closed++ }, native: { async invoke(request) {
      if (request.method === 'prompt') { sends++; throw Error('Lost response') }
      return { items: [{ sessionId: 's' }] }
    } } }
  }, new NativeGateway({}, []), { retryDelays: [] })
  const first = await registry.connect({ host: 'remote' })
  await assert.rejects(registry.hosts()[0].transport.invoke({ namespace: 'session', method: 'prompt', args: {} }))
  await registry.reconnect(first.connectionId)
  assert.equal(connects, 2)
  assert.equal(sends, 1)
  assert.equal(closed, 1)
  assert.equal(registry.list()[0].connectionId, first.connectionId)
  assert.equal(registry.list()[0].revision, 1)
  assert.equal(registry.list()[0].status, 'connected')
  registry.close()
})

test('disconnect during reconnect closes the late carrier and never restores the deleted host', async () => {
  let release, count = 0, closed = 0
  const client = () => ({ close() { closed++ }, native: { invoke: async () => ({ items: [] }) } })
  const registry = new NativeConnections(() => ++count === 1 ? client() : new Promise(resolve => { release = resolve }), new NativeGateway({}, []), { retryDelays: [] })
  const first = await registry.connect({ host: 'remote' })
  const pending = registry.reconnect(first.connectionId)
  registry.disconnect(first.connectionId)
  release(client())
  await assert.rejects(pending)
  assert.equal(registry.list().length, 0)
  assert.equal(closed, 2)
})

test('business rejection does not trigger connection recovery', async () => {
  const registry = new NativeConnections(async () => ({ close() {}, native: { async invoke(request) {
    if (request.method === 'list') return { items: [] }
    throw Object.assign(Error('Rejected'), { remoteBusinessError: true })
  } } }), new NativeGateway({}, []), { retryDelays: [] })
  await registry.connect({ host: 'remote' })
  await assert.rejects(registry.hosts()[0].transport.invoke({ namespace: 'session', method: 'rename', args: {} }))
  assert.equal(registry.list()[0].status, 'connected')
  registry.close()
})

test('carrier loss automatically reconnects once without replaying the mutation', async () => {
  let connects = 0, mutations = 0
  const registry = new NativeConnections(async () => { connects++; return { close() {}, native: { async invoke(request) {
    if (request.method !== 'list') { mutations++; throw Error('Socket lost') }
    return { items: [] }
  } } } }, new NativeGateway({}, []), { retryDelays: [0] })
  try {
    await registry.connect({ host: 'remote' })
    await assert.rejects(registry.hosts()[0].transport.invoke({ namespace: 'session', method: 'create', args: {} }))
    for (let i = 0; i < 100 && registry.list()[0].revision === 0; i++) await delay(10)
    assert.equal(registry.list()[0].revision, 1)
    assert.equal(connects, 2)
    assert.equal(mutations, 1)
  } finally { registry.close() }
})

test('an aborted reader does not initiate recovery', async () => {
  const registry = new NativeConnections(async () => ({ close() {}, native: {
    invoke: async () => ({ items: [] }), async *stream({ signal }) { signal.throwIfAborted() }
  } }), new NativeGateway({}, []), { retryDelays: [] })
  await registry.connect({ host: 'remote' })
  for await (const _frame of registry.hosts()[0].transport.stream({ namespace: 'workspace', method: 'follow', signal: AbortSignal.abort() })) {}
  assert.equal(registry.list()[0].status, 'connected')
  registry.close()
})


test('restores only opted-in hosts and explicit disconnect survives a new backend', async () => {
  const remembered = new Map([['one', true], ['two', false]])
  const calls = []
  const connect = async host => { calls.push(host); return { close() {}, native: { invoke: async () => ({ items: [] }) } } }
  const options = { remember: async (host, enabled) => remembered.set(host, enabled), retryDelays: [] }
  let registry = new NativeConnections(connect, new NativeGateway({}, []), options)
  await registry.restore([...remembered].map(([id, autoConnect]) => ({ id, autoConnect })))
  assert.deepEqual(calls, ['one'])
  registry.close()
  registry = new NativeConnections(connect, new NativeGateway({}, []), options)
  await registry.restore([...remembered].map(([id, autoConnect]) => ({ id, autoConnect })))
  assert.equal(registry.list().length, 1)
  await registry.disconnectSaved(registry.list()[0].connectionId)
  registry.close()
  registry = new NativeConnections(connect, new NativeGateway({}, []), options)
  await registry.restore([...remembered].map(([id, autoConnect]) => ({ id, autoConnect })))
  assert.equal(registry.list().length, 0)
  registry.close()
})

test('manual login URLs are never sent to reconnect persistence', async () => {
  const remembered = []
  const registry = new NativeConnections(async () => ({ close() {}, native: { invoke: async () => ({ items: [] }) } }), new NativeGateway({}, []), { remember: async (...args) => remembered.push(args) })
  await registry.connect({ host: 'one', loginUrl: 'http://localhost/?token=private' })
  assert.deepEqual(remembered, [['one', false]])
  registry.close()
})


test('startup retries a temporarily unavailable host without touching other hosts', async () => {
  let attempts = 0
  const registry = new NativeConnections(async () => {
    if (++attempts === 1) throw Error('Not ready')
    return { close() {}, native: { invoke: async () => ({ items: [] }) } }
  }, new NativeGateway({}, []), { retryDelays: [0] })
  try {
    await registry.restore([{ id: 'remote', autoConnect: true }])
    for (let i = 0; i < 100 && !registry.list().length; i++) await delay(10)
    assert.equal(registry.list().length, 1)
    assert.equal(attempts, 2)
  } finally { registry.close() }
})

test('cancelled startup cannot resurrect a removed host', async () => {
  let release, closed = 0
  const registry = new NativeConnections(() => new Promise(resolve => { release = resolve }), new NativeGateway({}, []))
  const pending = registry.restore([{ id: 'remote', autoConnect: true }])
  registry.cancelRestore('remote')
  release({ close() { closed++ }, native: { invoke: async () => ({ items: [] }) } })
  await pending
  assert.equal(registry.list().length, 0)
  assert.equal(closed, 1)
  registry.close()
})

test('notifications from a replaced carrier cannot change session state', async () => {
  const watchers = [], events = []
  const registry = new NativeConnections(async () => ({ close() {},
    subscribeEvents: async accept => { watchers.push(accept) },
    native: { invoke: async () => ({ items: [{ sessionId: 's', running: false }] }) }
  }), new NativeGateway({}, []), { onEvent: event => events.push(event) })
  const connected = await registry.connect({ host: 'remote' })
  await registry.reconnect(connected.connectionId)
  const frame = { type: 'emit', event: 'api-session/status', args: ['s', true] }
  watchers[0](frame)
  assert.equal(events.length, 0)
  watchers[1](frame)
  assert.equal(events.length, 1)
  registry.close()
})
