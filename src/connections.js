import { randomUUID, createHash } from 'node:crypto'
import { projectSessions } from './ssh-http.js'

// Opaque handles keep machine selection out of prompt/cancel request construction.
export class ConversationConnections {
  #connections = new Map()
  #closed = false
  #pending = 0
  constructor(connect) { this.connectHost = connect }

  async connect({ host, port, loginUrl }) {
    if (this.#closed || this.#connections.size + this.#pending >= 16) throw new Error('Connection unavailable')
    this.#pending++
    let client
    try {
      client = await this.connectHost(host, port, loginUrl)
      if (this.#closed) throw new Error('Plugin disposed')
      const sessions = projectSessions((await client.rpc('list', {})).items)
      if (this.#closed) throw new Error('Plugin disposed')
      const connectionId = randomUUID()
      const timer = setTimeout(() => this.disconnect(connectionId), 60 * 60 * 1000)
      timer.unref?.()
      this.#connections.set(connectionId, { client, sessions: new Set(sessions.map(item => item.sessionId)), sends: new Map(), timer })
      return { authenticated: true, connectionId, host, sessions, ...(client.destination ? { destination: client.destination } : {}) }
    } catch (error) { client?.close(); throw error }
    finally { this.#pending-- }
  }

  #get(connectionId, sessionId) {
    const connection = this.#connections.get(connectionId)
    if (!connection || !connection.sessions.has(sessionId)) throw new Error('Unknown connection or session')
    connection.timer.refresh()
    return connection
  }

  follow({ connectionId, sessionId }, signal) {
    return this.#get(connectionId, sessionId).client.follow(sessionId, signal)
  }

  async command({ connectionId, sessionId, action, text, requestId, throughSeq, beforeSeq }) {
    const connection = this.#get(connectionId, sessionId)
    if (action === 'stop') return connection.client.rpc('cancel', { sessionId })
    if (action === 'page') {
      if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || beforeSeq > throughSeq) throw new Error('Invalid history cursor')
      return connection.client.rpc('page', { address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 100 })
    }
    if (action !== 'send' || typeof text !== 'string' || !text.trim() || text.length > 100000 || typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Invalid prompt')
    const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, text])).digest('hex')
    const previous = connection.sends.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID reused')
      return previous.result
    }
    // Keep failures too: a lost HTTP response does not mean the prompt was not accepted.
    if (connection.sends.size >= 1000) throw new Error('Reconnect to send more messages')
    const result = Promise.resolve().then(() => connection.client.rpc('prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }))
    connection.sends.set(requestId, { fingerprint, result })
    return result
  }

  disconnect(connectionId) {
    const connection = this.#connections.get(connectionId)
    if (!connection) return
    clearTimeout(connection.timer)
    connection.client.close()
    this.#connections.delete(connectionId)
  }

  close() { this.#closed = true; for (const id of this.#connections.keys()) this.disconnect(id) }
}
