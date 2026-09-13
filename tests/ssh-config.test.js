import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listHosts } from '../src/ssh.js'

test('lists concrete aliases and includes, excludes patterns and Match-only entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-test-'))
  try {
    await mkdir(join(home, '.ssh', 'conf.d'), { recursive: true })
    await writeFile(join(home, '.ssh', 'config'), 'Host alpha beta *.example !blocked\nInclude conf.d/*\nMatch host alpha\nInclude private.conf\nHost gamma\n')
    await writeFile(join(home, '.ssh', 'conf.d', 'one'), 'Host beta delta\nInclude config\n')
    await writeFile(join(home, '.ssh', 'private.conf'), 'Host hidden\n')
    assert.deepEqual(await listHosts(home), ['alpha', 'beta', 'delta', 'gamma'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('missing SSH config is an empty list', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-test-'))
  try { assert.deepEqual(await listHosts(home), []) }
  finally { await rm(home, { recursive: true, force: true }) }
})
