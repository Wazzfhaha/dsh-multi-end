import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectWorkspaceTree } from '../src/workspaces.js'

const baseline = { items: [
  { workspaceId: 'w2', title: 'Second', path: '/same/path', sessionIds: ['s2', 's1', 'archived'] },
  { workspaceId: 'w1', title: 'Empty', path: '/empty', sessionIds: [] }
], archivedSessionIds: ['archived'] }
const sessions = [{ sessionId: 's1', cwd: '/other/path', title: 'One' }, { sessionId: 's2', title: 'Two' }, { sessionId: 'archived' }, { sessionId: 'unassigned' }]

test('preserves actual workspace membership, manual order and empty workspaces; hides archived sessions', () => {
  const tree = projectWorkspaceTree('host-a', baseline, sessions)
  assert.deepEqual(tree.workspaces.map(x => x.workspaceId), ['w2', 'w1'])
  assert.deepEqual(tree.workspaces[0].sessions.map(x => x.sessionId), ['s2', 's1'])
  assert.equal(tree.workspaces[1].sessions.length, 0)
  assert.deepEqual(tree.unassigned.map(x => x.sessionId), ['unassigned'])
  assert.equal(tree.workspaces[0].title, 'Second')
})

test('identical workspace/session IDs on different machines remain distinct', () => {
  const a = projectWorkspaceTree('host:a', baseline, sessions)
  const b = projectWorkspaceTree('host:b', baseline, sessions)
  assert.notEqual(a.workspaces[0].key, b.workspaces[0].key)
  assert.notEqual(a.workspaces[0].sessions[0].key, b.workspaces[0].sessions[0].key)
})

test('rejects malformed or duplicate workspaces instead of silently treating them as an empty registry', () => {
  assert.throws(() => projectWorkspaceTree('host', {}, sessions))
  assert.throws(() => projectWorkspaceTree('host', { ...baseline, items: [baseline.items[0], baseline.items[0]] }, sessions))
  assert.throws(() => projectWorkspaceTree('host', { ...baseline, items: [{ ...baseline.items[0], sessionIds: null }] }, sessions))
})
