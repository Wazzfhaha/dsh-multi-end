import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeConnections } from '../src/native-connections.js'
import { NativeGateway } from '../src/native-gateway.js'

test('native connections expose no credentials and survive independent list reads; disconnect closes only carrier', async () => {
  let closed = 0
  const gateway = new NativeGateway({}, [])
  const registry = new NativeConnections(async () => ({ native: { invoke: async () => ({ items: [{ sessionId: 's' }] }) }, close() { closed++ } }), gateway)
  const result = await registry.connect({ host: 'host-a' })
  assert.notEqual(result.sessions[0].sessionId, 's')
  assert.equal(registry.list()[0].connectionId, result.connectionId)
  assert.equal(registry.hosts()[0].id, 'host-a')
  assert.equal(registry.list()[0].client, undefined)
  await assert.rejects(registry.connect({ host: 'host-a' }))
  registry.disconnect(result.connectionId)
  assert.equal(closed, 1)
  assert.equal(registry.hosts().length, 0)
})

test('unavailable remote aggregate stream falls back to an empty baseline without failing local feeds', async () => {
  const registry = new NativeConnections(async () => ({ native: {
    invoke: async () => ({ items: [] }), async *stream() { throw Error('offline') }
  }, close() {} }), new NativeGateway({}, []))
  await registry.connect({ host: 'host-a' })
  const frames = []
  for await (const frame of registry.hosts()[0].transport.stream({ namespace: 'workspace', method: 'follow' })) frames.push(frame)
  assert.deepEqual(frames, [{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }])
  assert(registry.list()[0].error)
  registry.close()
})
