import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const context = vm.createContext({})
vm.runInContext(await readFile(new URL('../src/browser/views.js', import.meta.url), 'utf8'), context)
test('path typing browses the parent and filters a partial basename on Unix and Windows', () => {
  for (const [input, path, prefix] of [['/s', '/', 's'], ['/srv/', '/srv/', ''], ['/srv/pro', '/srv/', 'pro'], ['C:\\Users\\mi', 'C:/Users/', 'mi'], ['C:/', 'C:/', '']]) {
    const result = context.directoryQuery(input)
    assert.equal(result.path, path)
    assert.equal(result.prefix, prefix)
  }
  assert.equal(context.directoryQuery('relative'), null)
  assert.equal(context.directoryQuery(''), null)
})
