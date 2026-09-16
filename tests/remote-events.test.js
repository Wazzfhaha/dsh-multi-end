import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { connectWithLogin } from '../src/ssh-http.js'
import { NativeConnections } from '../src/native-connections.js'
import { NativeGateway } from '../src/native-gateway.js'

test('live remote status and completion cross the event carrier without refreshing the list', async t => {
  let lists = 0, eventSocket, streamId, delegated
  const delegation = new Promise(resolve => { delegated = resolve })
  const server = http.createServer(async (req, res) => {
    if (req.url === '/?token=test') { res.writeHead(302, { location: '/', 'set-cookie': 'dsh=test' }); res.end(); return }
    assert.equal(req.headers.cookie, 'dsh=test')
    let body = ''; for await (const chunk of req) body += chunk
    const rpc = JSON.parse(body)
    if (rpc.method === '$events/result') {
      assert.deepEqual(rpc.payload.args, { clientId: 'generation', eventId: 'question', outcome: { kind: 'next' } })
      delegated()
    } else { assert.equal(rpc.method, 'session/list'); lists++ }
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value: { items: [{ sessionId: 'same', running: false }] } } }))
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw)
    assert.equal(frame.endpoint, '$events')
    assert.deepEqual(frame.payload, { args: {} })
    eventSocket = ws; streamId = frame.streamId
    ws.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'generation', host: { home: '/remote' } } }))
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port, events = []
  const registry = new NativeConnections(() => connectWithLogin('mock', `http://127.0.0.1:${port}/?token=test`, () => net.connect(port, '127.0.0.1')), new NativeGateway({}, []), { onEvent: event => events.push(event), retryDelays: [] })
  t.after(() => { registry.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close() })
  await registry.connect({ host: 'host' })
  const id = registry.list()[0].sessions[0].sessionId
  const emit = value => eventSocket.send(JSON.stringify({ type: 'item', streamId, value }))
  emit({ type: 'emit', event: 'api-session/status', args: ['same', true] })
  await waitFor(() => events.length === 1)
  assert.equal(registry.list()[0].sessions[0].running, true)
  emit({ type: 'emit', event: 'settings/change', args: ['private'] })
  emit({ type: 'waterfall', event: 'tool/approval', eventId: 'question', agentId: 'same', request: {} })
  await delegation
  emit({ type: 'emit', event: 'api-session/status', args: ['same', false] })
  await waitFor(() => events.length === 2)
  assert.equal(registry.list()[0].sessions[0].running, false)
  assert.deepEqual(events, [{ event: 'api-session/status', args: [id, true] }, { event: 'api-session/status', args: [id, false] }])
  assert.equal(lists, 1)
})

async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Expected event did not arrive')
}
