import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TargetStore } from '../src/targets.js'
import { targetArgs } from '../src/ssh-target.js'

test('saved hosts start empty, persist explicit edits, and do not contain login credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-targets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TargetStore(join(dir, 'hosts.json'))
  assert.deepEqual(await store.list(), [])
  const item = await store.save({ name: 'Build box', type: 'manual', hostname: '192.168.1.30', user: 'dev', sshPort: 2222, dshPort: 42123, keyPath: '~/.ssh/id_ed25519' })
  assert.equal((await new TargetStore(join(dir, 'hosts.json')).list())[0].hostname, '192.168.1.30')
  await store.save({ ...item, name: 'Renamed' })
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.get(item.id)).name, 'Renamed')
  await assert.rejects(store.save({ ...item, loginUrl: 'http://localhost/?token=secret' }))
  assert.equal((await readFile(join(dir, 'hosts.json'), 'utf8')).includes('secret'), false)
  await store.remove(item.id)
  assert.deepEqual(await store.list(), [])
})

test('manual SSH arguments are individual arguments and never interpreted as a config alias or command', () => {
  assert.deepEqual(targetArgs({ type: 'manual', hostname: 'box.example', user: 'dev', sshPort: 2222, keyPath: '/keys/key with spaces' }), ['-F', 'none', '-p', '2222', '-l', 'dev', '-i', '/keys/key with spaces', '-o', 'IdentitiesOnly=yes', 'box.example'])
  assert.deepEqual(targetArgs({ type: 'config', alias: 'my-box' }), ['my-box'])
  for (const hostname of ['-oProxyCommand=bad', 'host;touch /tmp/bad', 'user@host', 'host\nother']) assert.throws(() => targetArgs({ type: 'manual', hostname, user: 'dev', sshPort: 22 }))
  for (const port of [0, 65536, 2.5, '22']) assert.throws(() => targetArgs({ type: 'manual', hostname: 'box', user: 'dev', sshPort: port }))
})

test('concurrent saves preserve both hosts and deletion never alters SSH config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-targets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TargetStore(join(dir, 'hosts.json'))
  await Promise.all(['one', 'two'].map(alias => store.save({ name: alias, type: 'config', alias, hostname: alias, user: 'dev', sshPort: 22, dshPort: 3080 })))
  assert.equal((await store.list()).length, 2)
})


test('reconnect preference survives a fresh store and explicit disconnect clears it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-targets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'hosts.json')
  const store = new TargetStore(file)
  const target = await store.save({ name: 'Remote', type: 'config', alias: 'remote', hostname: 'remote', user: 'dev', sshPort: 22, dshPort: 3080 })
  await store.remember(target.id, true)
  const restored = new TargetStore(file)
  assert.equal((await restored.get(target.id)).autoConnect, true)
  await restored.remember(target.id, false)
  assert.equal((await new TargetStore(file).get(target.id)).autoConnect, false)
  await store.remove(target.id)
  await assert.rejects(store.remember(target.id, true))
})
