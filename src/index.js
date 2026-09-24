import { listHosts, checkHost, readRemoteSessions, configuredHost, connectTarget, checkTarget } from './ssh.js'
import { TargetStore } from './targets.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NativeGateway } from './native-gateway.js'
import { NativeConnections } from './native-connections.js'
import { checkNativeContract } from './native-contract.js'
import { bridgeNativeWire } from './native-wire.js'
import { directoryOverSsh } from './ssh-directory.js'

export const name = 'ssh-workspaces'
export const inject = ['connection', 'typertGateway']

export async function apply(ctx) {
  const gateway = ctx.typertGateway
  if (typeof gateway?.invoke !== 'function' || typeof gateway?.stream !== 'function') throw Error('Unsupported DSH gateway')
  const originalInvoke = gateway.invoke, originalStream = gateway.stream
  const native = new NativeGateway({ invoke: request => originalInvoke.call(gateway, request), stream: request => originalStream.call(gateway, request) }, [])
  let nativeConnections
  Object.defineProperty(native, 'hosts', { get: () => nativeConnections?.hosts() ?? [] })
  ctx.effect(() => bridgeNativeWire(gateway, native), 'native Web carrier adapter')
  const invoke = request => native.invoke(request), stream = request => native.stream(request)
  gateway.invoke = invoke; gateway.stream = stream
  ctx.effect(() => () => {
    if (gateway.invoke === invoke) gateway.invoke = originalInvoke
    if (gateway.stream === stream) gateway.stream = originalStream
  }, 'native gateway compatibility adapter')
  const dispose = await ctx.connection.fetch.register({
    path: '/api/ssh-workspaces/hosts', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return Response.json({ hosts: await listHosts() })
        const { host } = await request.json()
        return Response.json(await checkHost(host))
      } catch {
        return Response.json({ error: 'SSH 检查失败，请检查主机配置、密钥和 known_hosts。' }, { status: 400 })
      }
    }
  })
  ctx.effect(() => dispose, 'ssh-workspaces routes')
  const disposeSessions = await ctx.connection.fetch.register({
    path: '/api/ssh-workspaces/sessions', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const { host, port, loginUrl } = await request.json()
        return Response.json(await readRemoteSessions(host, port, loginUrl))
      } catch {
        return Response.json({ error: '无法读取远端 DSH。请检查端口和登录链接；未提供链接时，自动探测需 Linux、Python 3 和可读的 DSH 标准输出日志。' }, { status: 400 })
      }
    }
  })
  ctx.effect(() => disposeSessions, 'ssh-workspaces session route')
  const targets = new TargetStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'dsh-ssh-workspaces', 'hosts.json'))
  const resolveTarget = async id => {
    const target = await targets.get(id)
    return target.type === 'config' ? { ...target, ...await configuredHost(target.alias), id: target.id, name: target.name, dshPort: target.dshPort } : target
  }
  for (const action of ['targets', 'ssh-import', 'check']) {
    const dispose = await ctx.connection.fetch.register({
      path: `/api/ssh-workspaces/${action}`, methods: action === 'check' ? ['POST'] : action === 'ssh-import' ? ['GET'] : ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          if (action === 'ssh-import') {
            const hosts = [], unavailable = []
            for (const alias of (await listHosts()).slice(0, 100)) {
              try { hosts.push(await configuredHost(alias)) } catch { unavailable.push(alias) }
            }
            return Response.json({ hosts, unavailable }, { headers: { 'cache-control': 'no-store' } })
          }
          if (request.method === 'GET') return Response.json({ targets: await targets.list(), native: true, connections: nativeConnections?.list() ?? [] }, { headers: { 'cache-control': 'no-store' } })
          const input = await request.json()
          if (action === 'check') {
            const target = await resolveTarget(input.id)
            return Response.json({ ...await checkTarget(target), destination: { hostname: target.hostname, user: target.user, sshPort: target.sshPort } })
          }
          if (input.action === 'remove') { nativeConnections.cancelRestore(input.id); return Response.json(await targets.remove(input.id)) }
          if (input.action !== 'save') throw Error('Unsupported host operation')
          let value = input.target
          if (value?.type === 'config') value = { ...value, ...await configuredHost(value.alias), name: value.name, id: value.id, dshPort: value.dshPort }
          return Response.json({ target: await targets.save(value) })
        } catch {
          return Response.json({ error: action === 'check' ? 'SSH 测试失败。请核对地址、端口、密钥和 known_hosts；当前使用非交互认证。' : '无法保存或读取主机。请检查必填信息、端口、SSH 别名和重复导入。' }, { status: 400 })
        }
      }
    })
    ctx.effect(() => dispose, `ssh-workspaces ${action} route`)
  }
  nativeConnections = new NativeConnections(async (id, _port, loginUrl) => {
    const target = await resolveTarget(id)
    let client
    try { client = await connectTarget(target, loginUrl) }
    catch { throw Object.assign(Error('Remote DSH login failed'), { connectStage: 'login' }) }
    try { client.contract = await checkNativeContract(client.native) }
    catch (error) { client.close(); throw error }
    client.displayName = target.name
    client.destination = { hostname: target.hostname, user: target.user, sshPort: target.sshPort }
    client.directory = (request, signal) => directoryOverSsh(target, request, signal)
    return client
  }, native, { remember: (host, enabled) => targets.remember(host, enabled), onEvent: frame => ctx.emit(frame.event, ...frame.args) })
  await registerConversations(ctx, nativeConnections)
  nativeConnections.restore(await targets.list()).catch(() => {})
}

export async function registerConversations(ctx, connections) {
  ctx.effect(() => () => connections.close(), 'ssh-workspaces connections')
  for (const action of ['connect', 'reconnect', 'command', 'follow', 'disconnect', 'workspace']) {
    const dispose = await ctx.connection.fetch.register({
      path: `/api/ssh-workspaces/${action}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const input = await request.json()
          if (action === 'connect') {
            const result = await connections.connect(input)
            if (request.signal.aborted) { if (connections.disconnectSaved) await connections.disconnectSaved(result.connectionId); else connections.disconnect(result.connectionId); throw new Error('Request cancelled') }
            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
          }
          if (action === 'command') return Response.json(await connections.command(input))
          if (action === 'workspace') return Response.json(await connections.workspace(input, request.signal), { headers: { 'cache-control': 'no-store' } })
          if (action === 'reconnect') return Response.json(await connections.reconnect(input.connectionId, input.loginUrl), { headers: { 'cache-control': 'no-store' } })
          if (action === 'disconnect') { if (connections.disconnectSaved) await connections.disconnectSaved(input.connectionId); else connections.disconnect(input.connectionId); return Response.json({ disconnected: true }) }
          return new Response(connections.follow(input, request.signal), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
        } catch (cause) {
          const stage = cause?.connectStage
          const detail = stage === 'login' ? 'SSH 已连通，但远端 DSH 登录未完成。' :
            stage === 'events' ? '远端 DSH 事件流未建立。' :
            stage === 'sessions' ? '远端 DSH 会话列表未返回。' :
            stage?.startsWith('protocol-workspace-') ? '远端工作区基础协议检查未通过。' :
            stage?.startsWith('protocol-session-') ? '远端会话控制基础协议检查未通过。' : ''
          const error = action === 'workspace' ? '目录操作未完成，请核对远端路径和权限；浏览接口不可用时可手动输入路径。添加结果不明确时先检查侧栏。' : action === 'command' ? '操作未确认，请重新打开会话核对状态；不要直接重复发送。' : '连接未完成，请检查 SSH、登录链接及 DSH 协议兼容性；当前适配基线为 0.1.7-rc.1。'
          return Response.json({ error: action === 'workspace' && cause?.directoryError ? cause.directoryError : detail && ['connect', 'reconnect'].includes(action) ? detail : error }, { status: 400, headers: { 'cache-control': 'no-store' } })
        }
      }
    })
    ctx.effect(() => dispose, `ssh-workspaces ${action} route`)
  }
}
