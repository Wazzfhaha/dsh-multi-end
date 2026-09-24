import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeGateway } from '../src/native-gateway.js'
import { NativeConnections } from '../src/native-connections.js'
import { checkNativeContract } from '../src/native-contract.js'

test('attachment, queue, skills and file operations retain their owner and opaque payloads', async () => {
  let calls = []
  const gateway = new NativeGateway({ invoke() { throw Error('Must not reach primary') } }, [{ id: 'box', transport: { invoke(r) { calls.push(r); return { accepted: true } } } }])
  const sessionId = gateway.id('box', 'session', 'raw')
  for (const [namespace, method, args] of [
    ['session', 'attachment', { request: { sessionId, attachmentId: 'image' } }],
    ['session', 'updateQueue', { request: { sessionId, itemId: 'queued', action: 'remove' } }],
    ['skills', 'list', { request: { sessionId } }],
    ['fileReferences', 'list', { agentId: sessionId, query: 'file' }],
    ['fileUploads', 'upload', { agentId: sessionId, request: { sessionId: 'opaque', data: 'bytes' } }]
  ]) await gateway.invoke({ namespace, method, args })
  assert.equal(calls.length, 5)
  assert.equal(calls[0].args.request.sessionId, 'raw')
  assert.equal(calls[4].args.agentId, 'raw')
  assert.equal(calls[4].args.request.sessionId, 'opaque')
})

test('archived manager entries are marked from the native workspace archive set', async () => {
  const gateway = new NativeGateway({}, [])
  const registry = new NativeConnections(async () => ({ native: { invoke: async () => ({ items: [{ sessionId: 's' }] }) }, close() {} }), gateway)
  await registry.connect({ host: 'box' })
  gateway.workspaceStates.set('box', { items: [], archivedSessionIds: [gateway.id('box', 'session', 's')] })
  assert.equal(registry.list()[0].sessions[0].archived, true)
  registry.close()
})

test('unsupported remote file scope never falls through to the primary backend', async () => {
  const gateway = new NativeGateway({ invoke() { throw Error('Must not reach primary') } }, [{ id: 'box', transport: {} }])
  const workspaceFileScopeId = gateway.id('box', 'session', 'raw')
  await assert.rejects(gateway.invoke({ namespace: 'workspaceFiles', method: 'read', args: { workspaceFileScopeId, path: '/file' } }), /Unsupported remote/)
})

test('contract check closes both probe streams and rejects malformed baseline', async () => {
  let closed = 0
  const transport = { async *stream({ namespace }) { try { yield { type: 'baseline', value: namespace === 'workspace' ? { items: [], archivedSessionIds: [], pinnedSessionIds: [] } : { queues: {}, jobs: {}, projections: {} } } } finally { closed++ } } }
  assert.match((await checkNativeContract(transport)).label, /0\.1\.7-rc\.1/)
  assert.equal(closed, 2)
  await assert.rejects(checkNativeContract({ async *stream() { yield { type: 'changed-contract' } } }))
})

test('remote workspace creation and browsing use only the explicitly selected connection', async () => {
  const calls = []
  const gateway = new NativeGateway({}, [])
  const registry = new NativeConnections(async () => ({ native: { invoke: async r => { calls.push(r); return r.namespace === 'session' ? { items: [] } : r.namespace === 'directoryPicker' ? { path: 'C:\\Projects', entries: [], crumbs: [] } : { workspace: { workspaceId: 'w', title: 'Project', sessionIds: [] } } } }, close() {} }), gateway)
  const connection = await registry.connect({ host: 'box' })
  const listing = await registry.workspace({ connectionId: connection.connectionId, action: 'browse', path: 'C:\\Projects' })
  assert.equal(listing.path, 'C:\\Projects')
  const created = await registry.workspace({ connectionId: connection.connectionId, action: 'create', path: 'C:\\Projects' })
  assert.equal(created.workspace.workspaceId, gateway.id('box', 'workspace', 'w'))
  assert.equal(calls[1].args.path, 'C:\\Projects')
  await assert.rejects(registry.workspace({ connectionId: 'unknown', action: 'create', path: '/tmp' }))
  registry.close()
})
