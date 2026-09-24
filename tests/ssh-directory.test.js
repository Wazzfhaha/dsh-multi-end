import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import streams from 'ssh2-streams'
import { directoryOverSsh } from '../src/ssh-directory.js'

function server(home = '/home/test') {
  const sftp = new streams.SFTPStream({ server: true }), calls = []
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { sftp.write(chunk, encoding, callback) }, destroy(error, callback) { sftp.destroy(); callback(error) } })
  sftp.on('data', chunk => socket.push(chunk))
  sftp.on('error', error => socket.destroy(error))
  const attrs = mode => ({ mode, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 })
  sftp.on('REALPATH', (id, path) => { calls.push(['realpath', path]); sftp.name(id, [{ filename: path === '.' ? home : path, longname: '', attrs: null }]) })
  sftp.on('OPENDIR', (id, path) => { calls.push(['opendir', path]); sftp.handle(id, Buffer.from('dir')) })
  let read = false
  sftp.on('READDIR', id => {
    if (read) return sftp.status(id, 1)
    read = true
    sftp.name(id, [
      { filename: '项目 with spaces', longname: '', attrs: attrs(0o40755) },
      { filename: '.hidden', longname: '', attrs: attrs(0o40755) },
      { filename: 'file.txt', longname: '', attrs: attrs(0o100644) },
      { filename: '..', longname: '', attrs: attrs(0o40755) }
    ])
  })
  sftp.on('CLOSE', id => { calls.push(['close']); sftp.status(id, 0) })
  sftp.on('MKDIR', (id, path) => { calls.push(['mkdir', path]); sftp.status(id, 0) })
  return { socket, calls }
}

test('SFTP browses remote home including spaces and Unicode, filters files, and closes the connection', async () => {
  const mock = server()
  const listing = await directoryOverSsh('test', { action: 'browse' }, undefined, () => mock.socket)
  assert.equal(listing.path, '/home/test')
  assert.deepEqual(listing.entries.map(x => x.name), ['.hidden', '项目 with spaces'])
  assert.equal(listing.entries[0].hidden, true)
  assert.equal(listing.crumbs.at(-1).path, '/home/test')
  assert.equal(mock.socket.destroyed, true)
  assert.ok(mock.calls.some(x => x[0] === 'close'))
})

test('SFTP maps Windows drive paths for DSH and never executes a shell command for names', async () => {
  const mock = server('/C:/Users/test')
  const listing = await directoryOverSsh('test', { action: 'browse', path: 'C:\\Projects' }, undefined, () => mock.socket)
  assert.equal(listing.path, 'C:/Projects')
  assert.equal(listing.entries[1].path, 'C:/Projects/项目 with spaces')
  assert.equal(listing.crumbs[0].path, 'C:/')
  const created = server()
  assert.equal(await directoryOverSsh('test', { action: 'mkdir', path: '/home/test', name: '项目 $hello' }, undefined, () => created.socket), '/home/test/项目 $hello')
  assert.deepEqual(created.calls.find(x => x[0] === 'mkdir'), ['mkdir', '/home/test/项目 $hello'])
})

test('SFTP rejects relative directory inputs and traversal names before starting SSH', async () => {
  const open = () => { throw Error('must not connect') }
  for (const name of ['..', '.', '../escape', 'a/b', 'a\\b', '', ' x ']) {
    await assert.rejects(directoryOverSsh('test', { action: 'mkdir', path: '/tmp', name }, undefined, open), /目录|名称/)
  }
  await assert.rejects(directoryOverSsh('test', { action: 'browse', path: 'relative' }, undefined, open), /绝对/)
})

test('SFTP abort closes an unfinished connection', async () => {
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback() } })
  const controller = new AbortController()
  const task = directoryOverSsh('test', { action: 'browse' }, controller.signal, () => socket)
  controller.abort()
  await assert.rejects(task)
  assert.equal(socket.destroyed, true)
})
