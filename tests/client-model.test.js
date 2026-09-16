import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
let module
vm.runInNewContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: item => { module = item.factory(() => ({})) } } } })

test('unsubscribing a settings view retains the connection and sidebar; explicit disconnect releases them', async () => {
  const calls = [], rows = new Set()
  const target = { id: 'one', name: 'Build box' }
  const model = module.createClientModel(async (method, input) => {
    calls.push(method)
    if (method === 'targets') return { targets: [target] }
    if (method === 'connect') return { connectionId: 'capability', sessions: [{ sessionId: 'same' }] }
    return {}
  }, { connected: c => rows.add(c.connectionId), disconnected: c => rows.delete(c.connectionId) })
  const unsubscribe = model.subscribe(() => {})
  await model.load()
  assert.deepEqual(calls, ['targets'])
  await model.connect(target)
  unsubscribe()
  assert.equal(model.getSnapshot().connections.one.connectionId, 'capability')
  assert.equal(rows.size, 1)
  assert.equal(calls.includes('disconnect'), false)
  await model.disconnect('one')
  assert.equal(rows.size, 0)
  assert.equal(Object.keys(model.getSnapshot().connections).length, 0)
  model.dispose()
})

test('a late connect result after plugin disposal is disconnected, not added to sidebar', async () => {
  let resolve, disconnected = 0, added = 0
  const model = module.createClientModel((method, input) => {
    if (method === 'connect') return new Promise(done => { resolve = done })
    if (method === 'disconnect') { disconnected++; return Promise.resolve({}) }
  }, { connected() { added++ } })
  const pending = model.connect({ id: 'one', name: 'One' })
  model.dispose()
  resolve({ connectionId: 'late', sessions: [] })
  await pending
  assert.equal(disconnected, 1)
  assert.equal(added, 0)
})

test('native polling during connect does not disconnect the new connection', async () => {
  const target = { id: 'one', name: 'One' }
  const connection = { host: 'one', connectionId: 'new', sessions: [], revision: 0 }
  let resolve, disconnected = 0, recovered = 0
  const model = module.createClientModel(async method => {
    if (method === 'connect') return new Promise(done => { resolve = done })
    if (method === 'targets') return { targets: [target], connections: [connection] }
    if (method === 'disconnect') disconnected++
  }, { native: true, recovered() { recovered++ } })
  const pending = model.connect(target)
  await model.load()
  resolve(connection)
  await pending
  assert.equal(disconnected, 0)
  connection.revision = 1
  await model.load()
  await model.load()
  assert.equal(recovered, 1)
  model.dispose()
  assert.equal(disconnected, 0)
})


test('backend-restored connections refresh native feeds even when the client had none', async () => {
  let connections = [], connected = 0
  const target = { id: 'one', name: 'One' }
  const model = module.createClientModel(async () => ({ targets: [target], connections }), { native: true, connected() { connected++ } })
  await model.load()
  connections = [{ host: 'one', connectionId: 'restored', sessions: [] }]
  await model.load(); await model.load()
  assert.equal(connected, 1)
  connections = [{ host: 'one', connectionId: 'new-backend', sessions: [] }]
  await model.load()
  assert.equal(connected, 2)
  model.dispose()
})
