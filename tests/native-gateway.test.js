import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeGateway } from '../src/native-gateway.js'

function source(label) {
  const calls = []
  return { calls,
    async invoke(request) {
      calls.push(request)
      if (request.method === 'list') return { items: [{ sessionId: 'same', projections: { values: { title: label }, asOfSeq: 0 } }] }
      return { accepted: true }
    },
    async *stream(request) {
      if (request.namespace === 'workspace') yield { type: 'baseline', value: { items: [{ workspaceId: 'same', title: label, path: 'C:\\project', sessionIds: ['same'] }], archivedSessionIds: [], pinnedSessionIds: [] } }
      else yield { type: 'snapshot', header: { id: 'same' }, records: [{ event: { data: { sessionId: 'same', text: 'same' } } }] }
    }
  }
}

test('native list and workspace baseline retain distinct owners with identical raw IDs', async () => {
  const local = source('Local'), remote = source('Remote')
  const gateway = new NativeGateway(local, [{ id: 'host-b', transport: remote }])
  const list = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0].sessionId, 'same')
  assert.notEqual(list.items[1].sessionId, 'same')
  assert.equal(list.items[1].projections.values.title, 'Remote')
  const stream = gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })
  const { value } = await stream.next()
  assert.deepEqual(value.value.items.map(x => x.title), ['[本机] Local', '[host-b] Remote'])
  assert.equal(value.value.items[1].sessionIds[0], list.items[1].sessionId)
  assert.notEqual(value.value.items[1].workspaceId, list.items[1].sessionId)
  await stream.return()
})

test('0.1.7 workspace stream preserves pinned sessions from both backends', async () => {
  const make = label => ({ async *stream() {
    yield { type: 'baseline', value: { items: [{ workspaceId: label, title: label, path: '/' + label, sessionIds: ['s'] }], archivedSessionIds: [], pinnedSessionIds: ['s'] } }
    yield { type: 'pinned', pinnedSessionIds: [] }
  } })
  const gateway = new NativeGateway(make('local'), [{ id: 'box', transport: make('remote') }])
  const frames = []
  for await (const frame of gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })) frames.push(frame)
  assert.deepEqual(frames[0].value.pinnedSessionIds, ['s', gateway.id('box', 'session', 's')])
  assert.deepEqual(frames.filter(frame => frame.type === 'pinned').at(-1).pinnedSessionIds, [])
})

test('native prompt routes by structured identity; content and settings stay untouched', async () => {
  const local = source('Local'), remote = source('Remote')
  const gateway = new NativeGateway(local, [{ id: 'host-b', transport: remote }])
  const list = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
  const id = list.items[1].sessionId
  const content = [{ type: 'text', text: id }, { type: 'json', sessionId: id }]
  await gateway.invoke({ namespace: 'session', method: 'prompt', args: { request: { sessionId: id, content } } })
  assert.equal(remote.calls.at(-1).args.request.sessionId, 'same')
  assert.equal(remote.calls.at(-1).args.request.content, content)
  const settings = { namespace: 'settings', method: 'get', args: {} }
  await gateway.invoke(settings)
  assert.equal(local.calls.at(-1), settings)
  assert.equal(local.calls.filter(x => x.method === 'prompt').length, 0)
})

test('native session search merges matches from local and remote hosts', async () => {
  const make = label => ({ async invoke(request) {
    assert.equal(request.namespace, 'session')
    assert.equal(request.method, 'search')
    assert.deepEqual(request.args, { request: { query: 'needle' } })
    return { items: [{ sessionId: 'same', snippet: label }], hasMore: label === 'Remote' }
  } })
  const gateway = new NativeGateway(make('Local'), [{ id: 'box', transport: make('Remote') }])
  const result = await gateway.invoke({ namespace: 'session', method: 'search', args: { request: { query: 'needle' } } })
  assert.deepEqual(result.items, [{ sessionId: 'same', snippet: 'Local' }, { sessionId: gateway.id('box', 'session', 'same'), snippet: 'Remote' }])
  assert.equal(result.hasMore, true)
})

test('local session search still works while a remote host is reconnecting', async () => {
  const gateway = new NativeGateway({ invoke: async () => ({ items: [{ sessionId: 'local', snippet: 'found' }], hasMore: false }) },
    [{ id: 'box', transport: { invoke: async () => { throw Error('disconnected') } } }])
  const result = await gateway.invoke({ namespace: 'session', method: 'search', args: { request: { query: 'found' } } })
  assert.deepEqual(result, { items: [{ sessionId: 'local', snippet: 'found' }], hasMore: false })
})

test('history header is translated without rewriting opaque event data', async () => {
  const gateway = new NativeGateway(source('Local'), [{ id: 'host-b', transport: source('Remote') }])
  const list = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
  const id = list.items[1].sessionId
  const stream = gateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: id } } } })
  const { value } = await stream.next()
  assert.equal(value.header.id, id)
  assert.equal(value.records[0].event.data.sessionId, 'same')
  await stream.return()
})

test('mixed-owner mutations and unsupported remote operations fail without local fallback', async () => {
  const local = source('Local'), remote = source('Remote')
  const gateway = new NativeGateway(local, [{ id: 'host-b', transport: remote }])
  const list = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
  const id = list.items[1].sessionId
  await assert.rejects(gateway.invoke({ namespace: 'workspace', method: 'insertSessionBefore', args: { request: { workspaceId: 'same', sessionId: id } } }), /different backends/)
  await assert.rejects(gateway.invoke({ namespace: 'unknown', method: 'danger', args: { agentId: id } }), /Unsupported remote/)
  assert.equal(local.calls.length, 1)
  assert.equal(remote.calls.length, 1)
})

test('native control stream keeps remote queues and projections in their own scope', async () => {
  const make = label => ({ async *stream() {
    yield { type: 'baseline', value: { queues: { same: [] }, jobs: { same: [] }, projections: { same: { values: { title: label }, asOfSeq: 1 } } } }
    yield { type: 'projection', sessionId: 'same', key: 'title', value: label + ' updated', seq: 2 }
  } })
  const gateway = new NativeGateway(make('Local'), [{ id: 'host-b', transport: make('Remote') }])
  const frames = []
  for await (const frame of gateway.stream({ namespace: 'session', method: 'control', args: {} })) frames.push(frame)
  const baseline = frames[0].value, remoteId = gateway.id('host-b', 'session', 'same')
  assert.deepEqual(Object.keys(baseline.queues).sort(), ['same', remoteId].sort())
  assert.equal(baseline.projections[remoteId].values.title, 'Remote')
  assert(frames.some(frame => frame.type === 'projection' && frame.sessionId === remoteId && frame.value === 'Remote updated'))
})

test('abort releases all aggregate stream subscriptions without cancelling model work', async () => {
  let closed = 0
  const transport = { async *stream({ signal }) {
    try {
      yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    } finally { closed++ }
  } }
  const controller = new AbortController()
  const gateway = new NativeGateway(transport, [{ id: 'host-b', transport }])
  const stream = gateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: controller.signal })
  await stream.next()
  const pending = stream.next()
  controller.abort()
  await pending.catch(() => {})
  await stream.return()
  assert.equal(closed, 2)
})

test('workspace feed emits one opening baseline, then native increments preserving other host order', async () => {
  const transport = { async *stream() {
    yield { type: 'baseline', value: { items: [
      { workspaceId: 'a', title: 'A', path: '/a', sessionIds: [] },
      { workspaceId: 'b', title: 'B', path: '/b', sessionIds: [] }
    ], archivedSessionIds: [], pinnedSessionIds: [] } }
    yield { type: 'order', workspaceIds: ['b', 'a'] }
    yield { type: 'archived', archivedSessionIds: ['same'] }
  } }
  const gateway = new NativeGateway(transport, [{ id: 'host-b', transport }])
  const frames = []
  for await (const frame of gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })) frames.push(frame)
  assert.equal(frames.filter(frame => frame.type === 'baseline').length, 1)
  const orders = frames.filter(frame => frame.type === 'order')
  assert(orders.length)
  assert.deepEqual(orders.at(-1).workspaceIds, ['b', 'a', gateway.id('host-b', 'workspace', 'b'), gateway.id('host-b', 'workspace', 'a')])
  assert.deepEqual(frames.filter(frame => frame.type === 'archived').at(-1).archivedSessionIds, ['same', gateway.id('host-b', 'session', 'same')])
})


test('remote notifications qualify identities while keeping event payloads opaque', () => {
  const gateway = new NativeGateway({}, [])
  const id = gateway.id('host', 'session', 'same')
  assert.deepEqual(gateway.event('host', { type: 'emit', event: 'api-session/status', args: ['same', true] }), { event: 'api-session/status', args: [id, true] })
  assert.deepEqual(gateway.event('host', { type: 'emit', event: 'api-session/status', args: ['same', false] }).args, [id, false])
  const summary = { sessionId: 'same', parentSessionId: 'parent', projections: { values: { title: 'same' } } }
  const added = gateway.event('host', { type: 'emit', event: 'api-session/added', args: [summary] })
  assert.equal(added.args[0].sessionId, id)
  assert.equal(added.args[0].projections, summary.projections)
  assert.equal(gateway.event('host', { type: 'emit', event: 'settings/change', args: ['same'] }), null)
  assert.throws(() => gateway.event('host', { type: 'emit', event: 'api-session/status', args: ['same', 'yes'] }))
})
