import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let module
vm.runInNewContext(await readFile(new URL('../src/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { module = value.factory(() => ({})) } } } })

test('snapshot replaces history; duplicate durable events do not duplicate messages', () => {
  const event = { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } }
  const snapshot = { type: 'snapshot', cursor: 3, records: [{ type: 'event', event }], hasMore: true, assistantStream: { revision: 1 } }
  let state = module.reduceConversation(null, snapshot)
  state = module.reduceConversation(state, { type: 'event', event })
  assert.equal(state.records.length, 1)
  assert.equal(module.recordText(state.records[0]), 'hello')
  state = module.reduceConversation(state, { ...snapshot, records: [] })
  assert.equal(state.records.length, 0)
})

test('stream revisions detect gaps and final messages replace live output', () => {
  let state = module.reduceConversation(null, { type: 'snapshot', cursor: 0, records: [], assistantStream: { revision: 0 } })
  const frame = value => ({ type: 'assistant-stream', frame: value })
  state = module.reduceConversation(state, frame({ type: 'start', revision: 1, attemptId: 'a' }))
  state = module.reduceConversation(state, frame({ type: 'chunk', revision: 2, attemptId: 'a', index: 0, chunk: { type: 'text-delta', index: 0, text: 'hey' } }))
  assert.equal(state.liveText, 'hey')
  assert.throws(() => module.reduceConversation(state, frame({ type: 'chunk', revision: 4, attemptId: 'a', index: 1, chunk: {} })))
  state = module.reduceConversation(state, frame({ type: 'end', revision: 3, attemptId: 'a', outcome: { kind: 'committed', seq: 1 } }))
  state = module.reduceConversation(state, { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hey' }] } } } })
  assert.equal(state.liveText, '')
  assert.equal(module.recordText(state.records[0]), 'hey')
})

test('reopening a running attempt restores packed text without duplicating block-end content', () => {
  const state = module.reduceConversation(null, { type: 'snapshot', cursor: 4, records: [], assistantStream: {
    revision: 9, activeAttempt: { attemptId: 'a', nextIndex: 5, stream: [
      { type: 'text-chunks', index: 0, texts: ['he', 'llo'] },
      { type: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } }
    ] }
  } })
  assert.equal(state.liveText, 'hello')
  assert.equal(state.nextIndex, 5)
})
