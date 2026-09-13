import { randomUUID } from 'node:crypto'
import { projectSessions } from './ssh-http.js'

export class NativeConnections {
  constructor(connect, gateway, options = {}) { this.connectHost = connect; this.gateway = gateway; this.connections = new Map(); this.closed = false; this.retryDelays = options.retryDelays ?? [1000, 3000, 10000, 30000, 30000] }
  list() { return [...this.connections.values()].map(value => {
    const archived = new Set(this.gateway.workspaceStates.get(value.public.host)?.archivedSessionIds ?? value.client.contract?.workspace.archivedSessionIds.map(id => this.gateway.id(value.public.host, 'session', id)) ?? [])
    return { ...value.public, sessions: value.public.sessions.map(session => ({ ...session, archived: archived.has(session.sessionId) })), compatibility: value.client.contract?.label, error: value.error, status: value.status, revision: value.revision }
  }) }
  hosts() { return [...this.connections.values()].map(value => ({ id: value.public.host, name: value.client.displayName, transport: value.transport })) }
  async connect({ host, loginUrl }) {
    if (this.closed || this.connections.size >= 16) throw Error('Connection unavailable')
    if ([...this.connections.values()].some(value => value.public.host === host)) throw Error('Host already connected')
    const client = await this.connectHost(host, undefined, loginUrl)
    try {
      const raw = await client.native.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, signal: AbortSignal.timeout(10000) })
      if (this.closed || [...this.connections.values()].some(value => value.public.host === host)) throw Error('Connection unavailable')
      const connectionId = randomUUID()
      const value = { client, raw, loginUrl, error: '', status: 'connected', revision: 0, retry: 0, timer: null, pending: null, removed: false,
        public: { authenticated: true, host, connectionId, sessions: projectSessions(raw.items).map(item => ({ ...item, sessionId: this.gateway.id(host, 'session', item.sessionId) })), destination: client.destination } }
      const manager = this
      value.transport = {
        invoke: async request => {
          const carrier = value.client
          try {
            if (value.status !== 'connected') throw Error('Backend reconnecting; operation not sent')
            const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
            const result = await carrier.native.invoke({ ...request, signal })
            if (request.namespace === 'session' && request.method === 'list') this.updateSessions(value, result)
            return result
          } catch (error) {
            if (value.client === carrier) this.failed(value, error, request.signal)
            if (request.namespace === 'session' && request.method === 'list') return value.raw
            throw error
          }
        },
        async *stream(request) {
          let opened = false
          const carrier = value.client
          try {
            for await (const frame of carrier.native.stream(request)) { opened = true; yield frame }
            if (!request.signal?.aborted && !value.removed && value.client === carrier) throw Error('Subscription ended')
          } catch (error) {
            if (value.client === carrier) manager.failed(value, error, request.signal)
            if (!['workspace/follow', 'session/control'].includes(`${request.namespace}/${request.method}`)) throw error
          }
          if (!opened && !request.signal?.aborted) yield { type: 'baseline', value: request.namespace === 'workspace' ? { items: [], archivedSessionIds: [] } : { queues: {}, jobs: {}, projections: {} } }
        }
      }
      this.connections.set(connectionId, value)
      return value.public
    } catch (error) { client.close(); throw error }
  }
  updateSessions(value, raw) {
    value.raw = raw
    value.public.sessions = projectSessions(raw.items).map(item => ({ ...item, sessionId: this.gateway.id(value.public.host, 'session', item.sessionId) }))
  }
  async workspace({ connectionId, action, path }, signal) {
    const value = this.connections.get(connectionId)
    if (!value || value.status !== 'connected') throw Error('请先连接目标后端')
    if (!['browse', 'create'].includes(action) || (path !== undefined && (typeof path !== 'string' || path.length > 8192 || path.includes('\0')))) throw Error('无效的目录请求')
    if (action === 'create' && !path?.trim()) throw Error('请输入目标后端上的目录路径')
    const request = action === 'browse' ? { namespace: 'directoryPicker', method: 'list', args: { path } } : { namespace: 'workspace', method: 'create', args: { request: { path } } }
    const result = await value.transport.invoke({ ...request, signal })
    if (action === 'browse') {
      if (typeof result?.path !== 'string' || !Array.isArray(result.entries) || !Array.isArray(result.crumbs) || [...result.entries, ...result.crumbs].some(entry => typeof entry?.path !== 'string' || typeof entry?.name !== 'string')) throw Error('Unsupported directory listing')
      return result
    }
    const workspace = this.gateway.workspace(value.public.host, result.workspace)
    this.gateway.workspaceStates.delete(value.public.host)
    return { ...result, workspace }
  }
  failed(value, error, signal) {
    if (value.removed || this.closed || signal?.aborted || error.remoteBusinessError) return
    if (value.status === 'connected') { value.status = 'offline'; value.retry = 0 }
    value.error = '连接中断，正在恢复；消息不会自动重发'
    this.schedule(value)
  }
  schedule(value) {
    if (value.removed || this.closed || value.timer || value.pending) return
    if (value.retry >= this.retryDelays.length) { value.error = '自动恢复未成功，请重连；登录失效时断开后更新登录链接'; return }
    const delay = this.retryDelays[value.retry++]
    value.timer = setTimeout(() => { value.timer = null; this.reconnect(value.public.connectionId).catch(() => {}) }, delay)
    value.timer.unref?.()
  }
  async reconnect(id, loginUrl) {
    const value = this.connections.get(id)
    if (!value || this.closed) throw Error('Unknown connection')
    if (value.pending) return value.pending
    clearTimeout(value.timer); value.timer = null
    value.status = 'reconnecting'
    value.pending = (async () => {
      let next
      try {
        next = await this.connectHost(value.public.host, undefined, loginUrl ?? value.loginUrl)
        const raw = await next.native.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, signal: AbortSignal.timeout(10000) })
        if (value.removed || this.closed) throw Error('Connection removed during reconnect')
        const old = value.client
        this.updateSessions(value, raw); value.client = next
        if (loginUrl !== undefined) value.loginUrl = loginUrl
        value.public.destination = next.destination
        value.status = 'connected'; value.error = ''; value.revision++; value.retry = 0
        this.gateway.workspaceStates.delete(value.public.host)
        old.close()
        return { ...value.public, status: value.status, revision: value.revision }
      } catch (error) {
        next?.close(); value.status = 'offline'; value.error = '重连未成功，正在重试'
        throw error
      }
    })()
    try { return await value.pending }
    finally { value.pending = null; if (value.status !== 'connected') this.schedule(value) }
  }
  disconnect(id) { const value = this.connections.get(id); if (value) { value.removed = true; value.loginUrl = undefined; clearTimeout(value.timer); value.client.close(); this.connections.delete(id); this.gateway.workspaceStates.delete(value.public.host) } }
  close() { this.closed = true; for (const id of this.connections.keys()) this.disconnect(id) }
}
