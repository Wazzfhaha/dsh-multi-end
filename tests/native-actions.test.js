import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeGateway } from '../src/native-gateway.js'

function backend() {
  const calls = []
  const state = { items: [{ workspaceId: 'w', title: 'Project', path: '/project', sessionIds: ['s'] }], archivedSessionIds: ['old'], pinnedSessionIds: [] }
  return { calls, state,
    async *stream() { yield { type: 'baseline', value: structuredClone(state) } },
    async invoke(request) {
      calls.push(request)
      if (request.method === 'archiveSession') { state.archivedSessionIds.push(request.args.request.sessionId); return { archivedSessionIds: [...state.archivedSessionIds] } }
      if (request.method === 'unarchiveSession') { state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== request.args.request.sessionId); return { archivedSessionIds: [...state.archivedSessionIds] } }
      if (request.method === 'pinSession') { state.pinnedSessionIds.unshift(request.args.request.sessionId); return { pinnedSessionIds: [...state.pinnedSessionIds] } }
      if (request.method === 'unpinSession') { state.pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== request.args.request.sessionId); return { pinnedSessionIds: [...state.pinnedSessionIds] } }
      if (request.method === 'insertBefore') return { workspaceIds: ['w'] }
      if (request.namespace === 'workspace' && request.method === 'rename') { state.items[0].title = request.args.request.title; return { workspace: state.items[0] } }
      if (request.namespace === 'session' && request.method === 'rename') return { title: request.args.request.title, seq: 3 }
      throw Error('Unexpected test request')
    }
  }
}

test('archiving a remote session routes only to its owner and preserves all other archive sets', async () => {
  const local = backend(), remote = backend()
  const gateway = new NativeGateway(local, [{ id: 'remote', name: 'Agent Box', transport: remote }])
  const sessionId = gateway.id('remote', 'session', 's')
  const result = await gateway.invoke({ namespace: 'workspace', method: 'archiveSession', args: { request: { sessionId } } })
  assert.deepEqual(local.calls, [])
  assert.equal(remote.calls[0].args.request.sessionId, 's')
  assert.deepEqual(result.archivedSessionIds, ['old', gateway.id('remote', 'session', 'old'), sessionId])
  const second = await gateway.invoke({ namespace: 'workspace', method: 'archiveSession', args: { request: { sessionId: 's' } } })
  assert.deepEqual(second.archivedSessionIds, ['old', 's', gateway.id('remote', 'session', 'old'), sessionId])
})

test('0.1.7 pin and unarchive actions keep the other backend state', async () => {
  const local = backend(), remote = backend()
  local.state.pinnedSessionIds = ['s']
  remote.state.archivedSessionIds = ['s']
  const gateway = new NativeGateway(local, [{ id: 'remote', transport: remote }])
  const id = gateway.id('remote', 'session', 's')
  const pinned = await gateway.invoke({ namespace: 'workspace', method: 'pinSession', args: { request: { sessionId: id } } })
  assert.deepEqual(pinned.pinnedSessionIds, ['s', id])
  const unpinned = await gateway.invoke({ namespace: 'workspace', method: 'unpinSession', args: { request: { sessionId: id } } })
  assert.deepEqual(unpinned.pinnedSessionIds, ['s'])
  const unarchived = await gateway.invoke({ namespace: 'workspace', method: 'unarchiveSession', args: { request: { sessionId: id } } })
  assert.deepEqual(unarchived.archivedSessionIds, ['old'])
  assert.deepEqual(local.calls, [])
  assert.deepEqual(remote.calls.map(call => call.args.request.sessionId), ['s', 's', 's'])
})

test('workspace source labels are display-only and are not persisted by rename', async () => {
  const local = backend(), remote = backend()
  const gateway = new NativeGateway(local, [{ id: 'remote', name: 'Agent Box', transport: remote }])
  const stream = gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })
  const { value } = await stream.next(); await stream.return()
  assert.deepEqual(value.value.items.map(item => item.title), ['[本机] Project', '[Agent Box] Project'])
  assert.equal(local.state.items[0].title, 'Project')
  assert.equal(remote.state.items[0].title, 'Project')
  const updated = await gateway.invoke({ namespace: 'workspace', method: 'rename', args: { request: { workspaceId: value.value.items[1].workspaceId, title: '[Agent Box] Renamed' } } })
  assert.equal(remote.state.items[0].title, 'Renamed')
  assert.equal(updated.workspace.title, '[Agent Box] Renamed')
})

test('workspace ordering returns a combined order instead of removing the other backend from the sidebar', async () => {
  const local = backend(), remote = backend()
  const gateway = new NativeGateway(local, [{ id: 'remote', transport: remote }])
  const workspaceId = gateway.id('remote', 'workspace', 'w')
  const result = await gateway.invoke({ namespace: 'workspace', method: 'insertBefore', args: { request: { workspaceId } } })
  assert.deepEqual(result.workspaceIds, ['w', workspaceId])
  assert.equal(local.calls.length, 0)
})

test('remote session rename reaches the owning backend without altering the title', async () => {
  const local = backend(), remote = backend()
  const gateway = new NativeGateway(local, [{ id: 'remote', transport: remote }])
  const sessionId = gateway.id('remote', 'session', 's')
  const result = await gateway.invoke({ namespace: 'session', method: 'rename', args: { request: { sessionId, title: 'New title' } } })
  assert.equal(result.title, 'New title')
  assert.equal(remote.calls[0].args.request.sessionId, 's')
  assert.equal(local.calls.length, 0)
})
