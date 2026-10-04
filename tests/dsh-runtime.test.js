import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { connectWithLogin } from '../src/ssh-http.js'
import { checkNativeContract } from '../src/native-contract.js'
import { NativeGateway } from '../src/native-gateway.js'
import { NativeConnections } from '../src/native-connections.js'

const root = process.env.DSH_COMPAT_TEST_ROOT
// Opt-in: only point at dedicated disposable DSH homes, never production logs.
test('real isolated DSH: login, baselines, remote workspace/session actions and projections', { skip: !root, timeout: 60000 }, async () => {
  const clients = []
  let registry
  async function connect(name) {
    const log = await readFile(join(root, `${name}.stdout.log`), 'utf8')
    const login = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~-]+/)?.[0]
    assert.ok(login, 'Dedicated test instance must be running')
    const url = new URL(login)
    const client = await connectWithLogin('compat-test', login, () => net.connect(Number(url.port), '127.0.0.1'))
    clients.push(client)
    client.contract = await checkNativeContract(client.native)
    return client
  }
  try {
    const primary = await connect('primary')
    const remote = await connect('remote')
    const gateway = new NativeGateway(primary.native, [])
    registry = new NativeConnections(async () => remote, gateway)
    Object.defineProperty(gateway, 'hosts', { get: () => registry.hosts() })
    const connection = await registry.connect({ host: 'compat-test' })
    const path = join(root, 'workspace-' + randomUUID())
    await mkdir(path)
    try {
      const directory = await registry.workspace({ connectionId: connection.connectionId, action: 'browse', path })
      assert.equal(directory.path.toLowerCase(), path.toLowerCase())
    } catch (error) { assert.equal(error.directoryUnavailable, true, 'Only an explicit native picker may skip the listing') }
    const { workspace } = await registry.workspace({ connectionId: connection.connectionId, action: 'create', path })
    assert.match(workspace.title, /^\[compat-test\]/)
    async function invoke(namespace, method, request) {
      return gateway.invoke({ namespace, method, args: { request }, signal: AbortSignal.timeout(10000) })
    }
    const created = await invoke('session', 'create', { workspaceId: workspace.workspaceId })
    const sessionId = created.sessionId
    assert.ok(gateway.owners.has(sessionId))
    const title = 'DSH compatibility ' + randomUUID()
    await invoke('session', 'rename', { sessionId, title })
    const projections = await invoke('session', 'projections', { sessionId })
    assert.equal(projections.values.title, title)
    const missing = gateway.id('compat-test', 'session', randomUUID())
    assert.equal(await invoke('session', 'projections', { sessionId: missing }), null)
    const list = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } })
    assert.ok(list.items.some(item => item.sessionId === sessionId))
    const search = await invoke('session', 'search', { query: title })
    assert.ok(Array.isArray(search.items))
    assert.equal(search.hasMore, false) // Native search scans message content, not titles of empty sessions.
    const lifetime = new AbortController()
    const follow = gateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } }, signal: lifetime.signal })[Symbol.asyncIterator]()
    try {
      const { value } = await follow.next()
      assert.equal(value.type, 'snapshot')
      assert.equal(value.header.id, sessionId)
    } finally { lifetime.abort(); await follow.return?.() }
    await invoke('workspace', 'archiveSession', { sessionId })
    await invoke('workspace', 'unarchiveSession', { sessionId })
    await invoke('workspace', 'pinSession', { sessionId })
    await invoke('workspace', 'unpinSession', { sessionId })
  } finally { registry?.close(); for (const client of clients) client.close() }
})
