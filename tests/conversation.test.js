import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { connectWithLogin } from '../src/ssh-http.js'
import { ConversationConnections } from '../src/connections.js'

test('0.1.7 browser login accepts the directory-relative redirect', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/?token=test')
    res.writeHead(303, { location: './', 'set-cookie': ['dsh=test; HttpOnly'] }); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const port = server.address().port
  const client = await connectWithLogin('mock', `http://127.0.0.1:${port}/?token=test`, () => {
    const socket = net.connect(port, '127.0.0.1')
    return Duplex.from({ readable: socket, writable: socket })
  })
  client.close()
})

test('authenticated SSH transport lists, follows, sends and stops using the DSH wire protocol', async t => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/?token=test') { res.writeHead(302, { location: '/', 'set-cookie': ['dsh=test; HttpOnly'] }); res.end(); return }
    assert.equal(req.headers.cookie, 'dsh=test')
    let body = ''; for await (const chunk of req) body += chunk
    const rpc = JSON.parse(body); calls.push(rpc)
    assert.equal(req.url, '/api/' + rpc.method)
    const value = rpc.method === 'session/list' ? { items: [{ sessionId: 'same', cwd: '/project' }] } : { accepted: true }
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }))
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket, req) => {
    assert.equal(req.url, '/api/remote.mux')
    assert.equal(req.headers.cookie, 'dsh=test')
    socket.on('message', raw => {
      const frame = JSON.parse(raw)
      if (frame.type !== 'open') return
      if (frame.endpoint === 'workspace/follow') {
        assert.deepEqual(frame.payload, { args: {} })
        socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [{ workspaceId: 'real', title: 'Real workspace', path: '/project', sessionIds: ['same'] }], archivedSessionIds: [] } } }))
        return
      }
      assert.equal(frame.endpoint, 'session/follow')
      assert.deepEqual(frame.payload.args.request, { address: { kind: 'session', sessionId: 'same' }, maxMessages: 100, assistantStream: true })
      socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', cursor: 0, records: [], hasMore: false, assistantStream: { revision: 0 } } }))
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close() })
  const port = server.address().port
  const client = await connectWithLogin('mock', `http://127.0.0.1:${port}/?token=test`, () => {
    const socket = net.connect(port, '127.0.0.1')
    return Duplex.from({ readable: socket, writable: socket })
  })
  t.after(() => client.close())
  assert.equal((await client.rpc('list', {})).items[0].sessionId, 'same')
  const workspaceReader = client.followWorkspaces(new AbortController().signal).getReader()
  const baseline = JSON.parse(new TextDecoder().decode((await workspaceReader.read()).value))
  assert.equal(baseline.value.items[0].workspaceId, 'real')
  await workspaceReader.cancel()
  const stream = client.follow('same', new AbortController().signal)
  const reader = stream.getReader()
  const first = await reader.read()
  assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'snapshot')
  await client.rpc('prompt', { sessionId: 'same', requestId: 'request-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
  await client.rpc('cancel', { sessionId: 'same' })
  assert.deepEqual(calls.map(x => x.payload.args), [
    { _request: {} },
    { request: { sessionId: 'same', requestId: 'request-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } },
    { request: { sessionId: 'same' } }
  ])
  await reader.cancel()
  assert.throws(() => client.rpc('arbitrary/path', {}))
  const nativeList = await client.native.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
  assert.equal(nativeList.items[0].sessionId, 'same')
  const nativeWorkspace = client.native.stream({ namespace: 'workspace', method: 'follow', args: {} })
  assert.equal((await nativeWorkspace.next()).value.value.items[0].title, 'Real workspace')
  await nativeWorkspace.return()
  await client.native.invoke({ namespace: 'workspace', method: 'archiveSession', args: { request: { sessionId: 'same' } } })
  assert.equal(calls.at(-1).method, 'workspace/archiveSession')
  assert.equal(calls.at(-1).payload.args.request.sessionId, 'same')
  const count = calls.length
  await assert.rejects(client.native.invoke({ namespace: 'settings', method: 'set', args: {} }), /Unsupported/)
  await assert.rejects(client.native.invoke({ namespace: 'session', method: 'cancel', args: { request: { sessionId: 'same' } }, signal: AbortSignal.abort() }))
  assert.equal(calls.length, count)
})

test('connection capabilities isolate identical session IDs on two hosts and reject unknown sessions', async () => {
  const sent = []
  const manager = new ConversationConnections(async host => ({
    rpc: async (method, request) => method === 'list' ? { items: [{ sessionId: 'same', secret: 'not public' }] } : (sent.push({ host, method, request }), { accepted: true }),
    close() {}, follow() { return new ReadableStream() }
  }))
  const a = await manager.connect({ host: 'one' }), b = await manager.connect({ host: 'two' })
  assert.notEqual(a.connectionId, b.connectionId)
  assert.equal(JSON.stringify(a).includes('secret'), false)
  await manager.command({ connectionId: b.connectionId, sessionId: 'same', action: 'send', text: 'hello', requestId: 'id-1' })
  assert.equal(sent[0].host, 'two')
  await assert.rejects(manager.command({ connectionId: a.connectionId, sessionId: 'other', action: 'stop' }))
  await assert.rejects(manager.command({ connectionId: 'unknown', sessionId: 'same', action: 'stop' }))
  manager.disconnect(b.connectionId)
  await assert.rejects(manager.command({ connectionId: b.connectionId, sessionId: 'same', action: 'stop' }))
  manager.close()
})

test('ambiguous sends are not retried and request IDs cannot be reused for other content', async () => {
  let sends = 0
  const manager = new ConversationConnections(async () => ({
    rpc: async method => { if (method === 'list') return { items: [{ sessionId: 's' }] }; sends++; throw Error('network lost') }, close() {}
  }))
  const { connectionId } = await manager.connect({ host: 'one' })
  const request = { connectionId, sessionId: 's', action: 'send', text: 'hello', requestId: 'r' }
  await assert.rejects(manager.command(request))
  await assert.rejects(manager.command(request))
  await assert.rejects(manager.command({ ...request, text: 'different' }))
  assert.equal(sends, 1)
  manager.close()
})

test('plugin disposal during connection setup closes the late connection', async () => {
  let release, closed = 0
  const manager = new ConversationConnections(() => new Promise(resolve => { release = resolve }))
  const pending = manager.connect({ host: 'one' })
  manager.close()
  release({ close() { closed++ }, rpc: async () => ({ items: [] }) })
  await assert.rejects(pending)
  assert.equal(closed, 1)
  await assert.rejects(manager.connect({ host: 'one' }))
})

test('empty, oversized and malformed operations never reach the remote; pagination keeps the owning session', async () => {
  const calls = []
  const manager = new ConversationConnections(async () => ({
    rpc: async (method, request) => method === 'list' ? { items: [{ sessionId: 's' }] } : (calls.push({ method, request }), { records: [], hasMore: false }), close() {}
  }))
  const { connectionId } = await manager.connect({ host: 'one' })
  for (const value of [{ action: 'send', text: ' ', requestId: 'r' }, { action: 'send', text: 'a'.repeat(100001), requestId: 'r' }, { action: 'send', text: 'hello' }, { action: 'delete' }, { action: 'page', throughSeq: 4, beforeSeq: 8 }]) {
    await assert.rejects(manager.command({ connectionId, sessionId: 's', ...value }))
  }
  assert.equal(calls.length, 0)
  await manager.command({ connectionId, sessionId: 's', action: 'page', throughSeq: 9, beforeSeq: 4 })
  assert.deepEqual(calls, [{ method: 'page', request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 9, beforeSeq: 4, maxMessages: 100 } }])
  manager.close()
})
