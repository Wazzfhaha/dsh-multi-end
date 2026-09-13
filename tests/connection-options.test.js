import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dshPort, sshExecutable } from '../src/connection-options.js'

test('accepts any valid TCP port and rejects ambiguous input', () => {
  for (const port of [1, 3080, 13083, 65535]) assert.equal(dshPort(port), port)
  assert.equal(dshPort(undefined), 3080)
  for (const port of [0, -1, 65536, 3080.5, '3080', null, NaN, Infinity]) assert.throws(() => dshPort(port))
})

test('uses native OpenSSH on Windows and PATH on Linux/macOS', () => {
  assert.equal(sshExecutable('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  assert.equal(sshExecutable('linux', {}), 'ssh')
  assert.equal(sshExecutable('darwin', {}), 'ssh')
})
