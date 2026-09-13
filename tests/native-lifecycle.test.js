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
