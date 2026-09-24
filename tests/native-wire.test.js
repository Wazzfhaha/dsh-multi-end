import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeGateway } from '../src/native-gateway.js'
import { bridgeNativeWire } from '../src/native-wire.js'

test('0.1.7 Web carrier receives remote list, search and workspace feed; disposer restores it', async () => {
  const make = label => ({
    async invoke({ namespace, method, peer }) {
      if (label === 'Local') assert.equal(peer, browserPeer)
      if (namespace === 'session' && ['list', 'search'].includes(method)) return { items: [{ sessionId: 'same', cwd: '/' + label }] }
      throw Error('Unexpected request')
    },
    async *stream({ namespace }) {
      if (namespace === 'workspace') yield { type: 'baseline', value: { items: [{ workspaceId: 'same', title: label, path: '/' + label, sessionIds: ['same'] }], archivedSessionIds: [], pinnedSessionIds: [] } }
      else yield { type: 'baseline', value: { projections: {} } }
    }
  })
  const browserPeer = { id: 'browser' }, local = make('Local'), remote = make('Remote')
  const native = new NativeGateway(local, [{ id: 'box', name: 'Box', transport: remote }])
  const gateway = {
    async invokeRpc() { return { ok: true, value: { items: [{ sessionId: 'same', cwd: '/Local' }] } } },
    async *openWireStream() { yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } } }
  }
  const originalRpc = gateway.invokeRpc, originalStream = gateway.openWireStream
  const restore = bridgeNativeWire(gateway, native)
  for (const endpoint of ['session/list', 'session/search']) {
    const result = await gateway.invokeRpc(endpoint, { args: { _request: {} } }, undefined, browserPeer)
    assert.equal(result.ok, true)
    assert.equal(result.value.items.length, 2)
    assert.equal(result.value.items[1].sessionId, native.id('box', 'session', 'same'))
  }
  const frames = []
  for await (const frame of await gateway.openWireStream('workspace/follow', { args: {} }, undefined, browserPeer)) frames.push(frame)
  assert.deepEqual(frames[0].value.items.map(item => item.title), ['[本机] Local', '[Box] Remote'])
  restore()
  assert.equal(gateway.invokeRpc, originalRpc)
  assert.equal(gateway.openWireStream, originalStream)
})
