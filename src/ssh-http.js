import http from 'node:http'
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { sshExecutable } from './connection-options.js'
import { targetArgs } from './ssh-target.js'
import { nativeOperations } from './native-contract.js'

export function loginTarget(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.hash || url.port === '0' ||
      [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1 ||
      !/^[A-Za-z0-9._~-]+$/.test(url.searchParams.get('token') ?? '')) throw new Error('Invalid DSH login URL')
  return url
}

function sshSocket(alias, url) {
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
  const child = spawn(sshExecutable(), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-W', `${host}:${url.port || 80}`, ...targetArgs(alias)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin })
  child.on('error', () => socket.destroy(new Error('SSH failed')))
  child.on('exit', code => { if (code) socket.destroy(new Error('SSH failed')) })
  socket.on('close', () => child.kill())
  return socket
}

function request(url, method, path, cookie, payload, createSocket, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const agent = new http.Agent()
    agent.createConnection = createSocket
    const headers = { host: url.host }
    if (cookie) headers.cookie = cookie
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    const req = http.request({ hostname: url.hostname, port: url.port || 80, method, path, headers, agent, signal }, response => {
      const chunks = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) req.destroy(new Error('Response too large')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(() => req.destroy(new Error('SSH request timed out')), 20000)
    req.on('error', reject)
    req.on('close', () => { clearTimeout(timer); agent.destroy() })
    req.end(payload)
  })
}

export async function sessionsWithLogin(alias, loginUrl) {
  const client = await connectWithLogin(alias, loginUrl)
  try {
    const result = await client.rpc('list', {})
    return { authenticated: true, sessions: projectSessions(result.items) }
  } finally { client.close() }
}

export function projectSessions(items) {
  if (!Array.isArray(items) || items.some(item => typeof item?.sessionId !== 'string')) throw new Error('Unsupported DSH sessions')
  return items.filter(item => !item.parentSessionId && item.origin !== 'subagent').map(item => {
    const value = Object.fromEntries(['sessionId', 'cwd', 'running', 'updatedAt', 'blank'].filter(key => key in item).map(key => [key, item[key]]))
    const title = item.projections?.values?.title
    if (typeof title === 'string') value.title = title.slice(0, 300)
    return value
  })
}

export async function connectWithLogin(alias, loginUrl, socketFactory) {
  targetArgs(alias)
  const url = loginTarget(loginUrl)
  const sockets = new Set(), streams = new Set()
  let closed = false
  const createSocket = () => {
    if (closed) throw new Error('Connection closed')
    const socket = socketFactory ? socketFactory() : sshSocket(alias, url)
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const close = () => {
    closed = true
    for (const stop of streams) stop()
    for (const socket of sockets) socket.destroy()
    cookie = ''
  }
  let cookie = ''
  let login
  try { login = await request(url, 'GET', url.pathname + url.search, undefined, undefined, createSocket) }
  catch { close(); throw new Error('DSH login failed') }
  url.search = ''
  if (![302, 303].includes(login.status) || !['/', './'].includes(login.headers.location) || !login.headers['set-cookie']?.length) { close(); throw new Error('DSH login rejected') }
  cookie = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ')
  return {
    close,
    async subscribeEvents(accept, failed) {
      const reader = follow('$events', { args: {} }, 'ready').getReader()
      let ready
      try {
        const first = await reader.read()
        if (first.done) throw Error('Remote events unavailable')
        ready = JSON.parse(new TextDecoder().decode(first.value))
        if (typeof ready.clientId !== 'string') throw Error('Invalid event generation')
      } catch (error) { await reader.cancel(); reader.releaseLock(); throw error }
      const task = (async () => {
        try {
          while (!closed) {
            const { value, done } = await reader.read()
            if (done) { if (!closed) throw Error('Remote events ended'); return }
            const frame = JSON.parse(new TextDecoder().decode(value))
            if (frame.type === 'emit') accept(frame)
            else if (frame.type === 'waterfall') {
              // This plugin observes notifications only. Delegate interactive requests
              // back to the remote Host instead of leaving a delivery unanswered.
              const result = await request(url, 'POST', '/api/$events/result', cookie, JSON.stringify({
                type: 'client-request', rpcId: randomUUID(), method: '$events/result',
                payload: { args: { clientId: ready.clientId, eventId: frame.eventId, outcome: { kind: 'next' } } }
              }), createSocket)
              if (result.status !== 200 || !JSON.parse(result.body).result?.ok) throw Error('Remote event delegation failed')
            }
          }
        } finally { await reader.cancel(); reader.releaseLock() }
      })()
      task.catch(error => { if (!closed) failed(error) })
    },
    native: {
      async invoke({ namespace, method, args, signal }) {
        const endpoint = `${namespace}/${method}`
        if (closed || !(nativeOperations.has(endpoint) || ['directoryPicker/list', 'directoryPicker/createDirectory', 'workspace/create'].includes(endpoint))) throw Error('Unsupported native operation')
        signal?.throwIfAborted()
        const rpcId = randomUUID()
        const response = await request(url, 'POST', `/api/${endpoint}`, cookie,
          JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), createSocket, signal)
        if (response.status !== 200) throw Error('Native DSH request rejected')
        const body = JSON.parse(response.body)
        if (body.type !== 'server-response' || body.rpcId !== rpcId) throw Error('Invalid native DSH response')
        if (!body.result?.ok) {
          const messages = {
            'directory-picker/unavailable': '远端 DSH 使用本机目录弹窗模式，未提供远程目录浏览。',
            'directory-picker/unreadable': '远端目录不存在或当前 SSH 用户无权读取。',
            'directory-picker/exists': '远端已存在同名文件夹。',
            'directory-picker/create-failed': '远端无法创建文件夹，请检查目录权限。',
            'gateway/bad-request': '远端 DSH 拒绝了目录请求参数。',
            'gateway/not-found': '远端 DSH 未提供所需目录接口。',
            'gateway/internal': '远端 DSH 目录服务内部错误。'
          }
          throw Object.assign(Error('Remote conversation operation failed'), { remoteBusinessError: true, directoryUnavailable: body.result?.error?.code === 'directory-picker/unavailable', directoryError: namespace === 'directoryPicker' ? messages[body.result?.error?.code] : undefined })
        }
        return body.result.value
      },
      async *stream({ namespace, method, args, signal }) {
        const endpoint = `${namespace}/${method}`
        const baseline = { 'session/follow': 'snapshot', 'session/control': 'baseline', 'workspace/follow': 'baseline' }[endpoint]
        if (!baseline) throw Error('Unsupported native stream')
        signal?.throwIfAborted()
        const reader = follow(endpoint, { args }, baseline, signal).getReader()
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) return
            // follow emits exactly one complete JSON frame per chunk.
            yield JSON.parse(new TextDecoder().decode(value))
          }
        } finally { await reader.cancel(); reader.releaseLock() }
      }
    },
    rpc(method, value) {
      if (closed || !['list', 'prompt', 'cancel', 'page'].includes(method)) throw new Error('Unsupported operation')
      const endpoint = `session/${method}`
      return request(url, 'POST', `/api/${endpoint}`, cookie, JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { [method === 'list' ? '_request' : 'request']: value } } }), createSocket).then(result => {
        if (result.status !== 200) throw new Error('DSH request rejected')
        const response = JSON.parse(result.body).result
        if (!response?.ok) throw new Error('DSH operation failed')
        return response.value
      })
    },
    follow(sessionId, signal) {
      return follow('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100, assistantStream: true } } }, 'snapshot', signal)
    },
    followWorkspaces(signal) {
      return follow('workspace/follow', { args: {} }, 'baseline', signal)
    }
  }
  function follow(endpoint, payload, baselineType, signal) {
      if (closed) throw new Error('Connection closed')
      let finish
      return new ReadableStream({
        start(controller) {
          const streamId = randomUUID()
          const ws = new WebSocket(`ws://${url.host}/api/remote.mux`, { headers: { cookie }, createConnection: createSocket, handshakeTimeout: 12000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, followRedirects: false })
          let done = false, alive = true, first = true
          const timer = setTimeout(() => finish(new Error('DSH subscription timed out')), 20000)
          const heartbeat = setInterval(() => {
            if (!alive) { finish(new Error('DSH disconnected')); return }
            alive = false
            if (ws.readyState === WebSocket.OPEN) ws.ping()
          }, 15000)
          const abort = () => finish()
          finish = (error, cancelled = false) => {
            if (done) return
            done = true
            clearTimeout(timer); clearInterval(heartbeat)
            signal?.removeEventListener('abort', abort)
            streams.delete(abort)
            ws.terminate()
            if (!cancelled) { if (error) controller.error(error); else controller.close() }
          }
          streams.add(abort)
          signal?.addEventListener('abort', abort, { once: true })
          ws.on('error', () => finish(new Error('DSH stream failed')))
          ws.on('close', () => finish(new Error('DSH stream disconnected')))
          ws.on('pong', () => { alive = true })
          ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload })))
          ws.on('message', raw => {
            if (done) return
            try {
              const frame = JSON.parse(raw.toString())
              if (frame.streamId !== streamId) return
              if (frame.type !== 'item') throw new Error('DSH subscription ended')
              if (first && frame.value?.type !== baselineType) throw new Error('Unsupported DSH stream')
              first = false; clearTimeout(timer)
              const bytes = new TextEncoder().encode(JSON.stringify(frame.value) + '\n')
              if (controller.desiredSize < bytes.length) throw new Error('DSH stream consumer too slow')
              controller.enqueue(bytes)
            } catch { finish(new Error('DSH stream interrupted; reopen conversation')) }
          })
          if (signal?.aborted) abort()
        },
        cancel() { finish(undefined, true) }
      }, { highWaterMark: 8 * 1024 * 1024, size: value => value.byteLength })
  }
}
