import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginTarget } from '../src/ssh-http.js'

test('login handoff retains custom DSH ports and loopback authorities', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(loginTarget(`http://${host}:42123/?token=abc`).port, '42123')
  }
})

test('login handoff cannot target arbitrary remote services or ambiguous tokens', () => {
  for (const url of ['http://example.com/?token=a', 'http://localhost:0/?token=a', 'http://user@localhost/?token=a', 'http://localhost/api?token=a', 'http://localhost/?token=a&token=b', 'http://localhost/?token=a&redirect=x', 'http://localhost/?token=a#x', 'http://localhost/']) {
    assert.throws(() => loginTarget(url))
  }
})
