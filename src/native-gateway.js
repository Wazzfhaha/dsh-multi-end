import { createHash } from 'node:crypto'
import { nativeOperations } from './native-contract.js'

const identities = { sessionId: 'session', parentSessionId: 'session', childSessionId: 'session', agentId: 'session', workspaceFileScopeId: 'session', workspaceId: 'workspace', beforeWorkspaceId: 'workspace', beforeSessionId: 'session' }
const supported = new Set([...nativeOperations, 'session/follow'])

// The adapter knows protocol identity positions only. Content, paths, plugin payloads
// and history records are opaque, even if their keys happen to say "sessionId".
export class NativeGateway {
  constructor(primary, hosts) {
    this.primary = primary
    this.hosts = hosts
    this.owners = new Map()
    this.workspaceStates = new Map()
  }

  id(host, kind, raw) {
    if (typeof raw !== 'string' || !raw) throw Error('Invalid native identity')
    const hex = createHash('sha256').update(JSON.stringify(['dsh-multi-end', host, kind, raw])).digest('hex')
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    const prior = this.owners.get(id)
    if (prior && (prior.host !== host || prior.kind !== kind || prior.raw !== raw)) throw Error('Native identity collision')
    this.owners.set(id, { host, kind, raw })
    return id
  }

  fields(host, value) {
    const result = { ...value }
    for (const [key, kind] of Object.entries(identities)) {
      if (typeof value[key] === 'string') result[key] = this.id(host, kind, value[key])
    }
    return result
  }

  workspace(host, value) {
    return { ...(host ? this.fields(host, value) : value), title: this.prefix(host) + value.title,
      sessionIds: value.sessionIds.map(id => host ? this.id(host, 'session', id) : id) }
  }

  prefix(host) { return `[${host ? this.hosts.find(value => value.id === host)?.name || host : '本机'}] ` }

  async ensureWorkspaceStates(signal) {
    for (const source of [{ id: null, transport: this.primary }, ...this.hosts]) {
      if (this.workspaceStates.has(source.id)) continue
      const lifetime = new AbortController()
      const timeout = AbortSignal.timeout(15000)
      const combined = AbortSignal.any([lifetime.signal, timeout, ...(signal ? [signal] : [])])
      const iterator = (await source.transport.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: combined }))[Symbol.asyncIterator]()
      try {
        const { value, done } = await iterator.next()
        if (done || value.type !== 'baseline') throw Error('Workspace baseline unavailable')
        this.workspaceStates.set(source.id, {
          items: value.value.items.map(item => this.workspace(source.id, item)),
          archivedSessionIds: value.value.archivedSessionIds.map(id => source.id ? this.id(source.id, 'session', id) : id)
        })
      } finally { lifetime.abort(); await iterator.return?.() }
    }
  }

  route(request) {
    const owners = new Set()
    const decode = value => {
      if (!value || typeof value !== 'object') return value
      const result = { ...value }
      for (const [key, kind] of Object.entries(identities)) {
        if (typeof value[key] !== 'string') continue
        const owner = this.owners.get(value[key])
        if (owner && owner.kind !== kind) throw Error('Wrong native identity kind')
        // A caller-allocated new ID has no owner yet; the selected workspace
        // determines where creation happens. Known IDs still enforce ownership.
        if (!owner && key === 'sessionId' && request.namespace === 'session' && request.method === 'create') continue
        owners.add(owner?.host ?? null)
        if (owner) result[key] = owner.raw
      }
      return result
    }
    const args = decode(request.args)
    if (args.request && request.namespace !== 'fileUploads') {
      args.request = decode(args.request)
      if (args.request.address) args.request.address = decode(args.request.address)
    }
    if (owners.size > 1) throw Error('Cannot mutate identities belonging to different backends')
    const hostId = [...owners][0]
    if (!hostId) return { transport: this.primary, request }
    if (!supported.has(`${request.namespace}/${request.method}`)) throw Error('Unsupported remote conversation operation')
    const host = this.hosts.find(host => host.id === hostId)
    if (!host) throw Error('Remote backend disconnected')
    return { transport: host.transport, request: { ...request, args }, hostId }
  }

  async invoke(request) {
    if (request.namespace === 'session' && request.method === 'list') {
      const local = await this.primary.invoke(request)
      const remote = await Promise.all(this.hosts.map(async host => {
        const value = await host.transport.invoke(request)
        return value.items.map(item => this.fields(host.id, item))
      }))
      if (local.items.some(item => this.owners.has(item.sessionId))) throw Error('Native identity collides with primary session')
      return { ...local, items: [...local.items, ...remote.flat()] }
    }
    let { transport, request: routed, hostId } = this.route(request)
    const aggregate = request.namespace === 'workspace' && ['archiveSession', 'insertBefore'].includes(request.method)
    if (aggregate) await this.ensureWorkspaceStates(request.signal)
    if (request.namespace === 'workspace' && request.method === 'rename') {
      const input = routed.args.request, prefix = this.prefix(hostId)
      if (typeof input.title === 'string' && input.title.startsWith(prefix)) routed = { ...routed, args: { ...routed.args, request: { ...input, title: input.title.slice(prefix.length) } } }
    }
    const value = await transport.invoke(routed)
    if (aggregate) {
      const state = this.workspaceStates.get(hostId ?? null)
      const sources = [null, ...this.hosts.map(host => host.id)]
      if (request.method === 'archiveSession') {
        state.archivedSessionIds = value.archivedSessionIds.map(id => hostId ? this.id(hostId, 'session', id) : id)
        return { ...value, archivedSessionIds: sources.flatMap(id => this.workspaceStates.get(id)?.archivedSessionIds ?? []) }
      }
      const byId = new Map(state.items.map(item => [item.workspaceId, item]))
      state.items = value.workspaceIds.map(id => byId.get(hostId ? this.id(hostId, 'workspace', id) : id))
      if (state.items.some(item => !item)) throw Error('Workspace order references unknown workspace')
      return { ...value, workspaceIds: sources.flatMap(id => (this.workspaceStates.get(id)?.items ?? []).map(item => item.workspaceId)) }
    }
    if (request.namespace === 'workspace' && value.workspace) return { ...value, workspace: this.workspace(hostId, value.workspace) }
    if (!hostId) return value
    if (request.namespace === 'session') return this.fields(hostId, value)
    if (value.workspace) return { ...value, workspace: this.workspace(hostId, value.workspace) }
    if (value.workspaceIds) throw Error('Workspace ordering aggregation is not implemented')
    if (value.archivedSessionIds) throw Error('Archive aggregation is not implemented')
    return this.fields(hostId, value)
  }

  async *stream(request) {
    if (request.namespace === 'session' && request.method === 'control') {
      yield* this.controlStream(request)
      return
    }
    if (request.namespace === 'workspace' && request.method === 'follow') {
      yield* this.workspaceStream(request)
      return
    }
    const { transport, request: routed, hostId } = this.route(request)
    for await (const frame of await transport.stream(routed)) {
      if (hostId && frame.type === 'snapshot' && frame.header) {
        const header = { ...frame.header, id: this.id(hostId, 'session', frame.header.id) }
        if (header.parentSession) header.parentSession = this.id(hostId, 'session', header.parentSession)
        yield { ...frame, header }
      } else yield frame
    }
  }

  async *controlStream(request) {
    const lifetime = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal
    const sources = [{ id: null, transport: this.primary }, ...this.hosts]
    const iterators = [], pending = new Map()
    const next = index => pending.set(index, Promise.resolve(iterators[index].next()).then(
      result => ({ index, result }), error => ({ index, error })
    ))
    try {
      for (const source of sources) {
        const stream = await source.transport.stream({ ...request, signal })
        iterators.push(stream[Symbol.asyncIterator]())
        next(iterators.length - 1)
      }
      const value = { queues: {}, jobs: {}, projections: {} }
      for (const { index, result, error } of await Promise.all(pending.values())) {
        if (error) throw error
        if (result.done || result.value.type !== 'baseline') throw Error('Control stream has no opening baseline')
        for (const field of ['queues', 'jobs', 'projections']) {
          for (const [raw, item] of Object.entries(result.value.value[field])) {
            const id = sources[index].id ? this.id(sources[index].id, 'session', raw) : raw
            if (Object.hasOwn(value[field], id)) throw Error('Control identity collision')
            value[field][id] = item
          }
        }
      }
      pending.clear()
      yield { type: 'baseline', value }
      for (let i = 0; i < iterators.length; i++) next(i)
      while (pending.size) {
        signal.throwIfAborted()
        const { index, result, error } = await Promise.race(pending.values())
        pending.delete(index)
        if (error) throw error
        if (result.done) continue
        const host = sources[index].id
        yield host ? this.fields(host, result.value) : result.value
        next(index)
      }
    } finally {
      lifetime.abort()
      await Promise.allSettled(pending.values())
      await Promise.allSettled(iterators.map(iterator => iterator.return?.()))
    }
  }

  async *workspaceStream(request) {
    const lifetime = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal
    const sources = [{ id: null, transport: this.primary }, ...this.hosts]
    const states = new Map()
    let baselineSent = false
    const iterators = []
    const pending = new Map()
    const next = index => pending.set(index, Promise.resolve(iterators[index].next()).then(
      result => ({ index, result }), error => ({ index, error })
    ))
    try {
      for (const source of sources) {
        const stream = await source.transport.stream({ ...request, signal })
        iterators.push(stream[Symbol.asyncIterator]())
        next(iterators.length - 1)
      }
      while (pending.size) {
        signal.throwIfAborted()
        const { index, result, error } = await Promise.race(pending.values())
        pending.delete(index)
        if (error) throw error
        if (result.done) continue
        const frame = result.value, host = sources[index].id
        const workspace = item => this.workspace(host, item)
        const id = (kind, raw) => host ? this.id(host, kind, raw) : raw
        const state = states.get(index)
        if (frame.type === 'baseline' && state) throw Error('Workspace stream repeated its opening baseline')
        if (frame.type === 'baseline') states.set(index, {
          items: frame.value.items.map(workspace),
          archivedSessionIds: frame.value.archivedSessionIds.map(raw => id('session', raw))
        })
        else if (!state) throw Error('Workspace stream has no opening baseline')
        else if (frame.type === 'upsert') {
          const item = workspace(frame.workspace), at = state.items.findIndex(x => x.workspaceId === item.workspaceId)
          if (at < 0) state.items.push(item)
          else state.items[at] = item
        } else if (frame.type === 'remove') state.items = state.items.filter(x => x.workspaceId !== id('workspace', frame.workspaceId))
        else if (frame.type === 'order') {
          const byId = new Map(state.items.map(x => [x.workspaceId, x]))
          state.items = frame.workspaceIds.map(raw => byId.get(id('workspace', raw)))
          if (state.items.some(x => !x)) throw Error('Workspace order references unknown identity')
        } else if (frame.type === 'archived') state.archivedSessionIds = frame.archivedSessionIds.map(raw => id('session', raw))
        else throw Error('Unsupported workspace frame')
        this.workspaceStates.set(host, states.get(index))
        if (states.size === sources.length) {
          const items = sources.flatMap((_, i) => states.get(i).items)
          const archivedSessionIds = sources.flatMap((_, i) => states.get(i).archivedSessionIds)
          if (!baselineSent) {
            baselineSent = true
            yield { type: 'baseline', value: { items, archivedSessionIds } }
          } else if (frame.type === 'order') yield { type: 'order', workspaceIds: items.map(item => item.workspaceId) }
          else if (frame.type === 'archived') yield { type: 'archived', archivedSessionIds }
          else if (frame.type === 'upsert') yield { ...frame, workspace: workspace(frame.workspace) }
          else if (frame.type === 'remove') yield { ...frame, workspaceId: id('workspace', frame.workspaceId) }
        }
        next(index)
      }
    } finally {
      lifetime.abort()
      await Promise.allSettled(pending.values())
      await Promise.allSettled(iterators.map(iterator => iterator.return?.()))
    }
  }
}
