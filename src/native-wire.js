// DSH 0.1.7's Web carrier calls invokeRpc/openWireStream, not invoke/stream.
const aggregate = new Set([
  'session/list', 'session/search', 'workspace/archiveSession', 'workspace/unarchiveSession',
  'workspace/pinSession', 'workspace/unpinSession', 'workspace/insertBefore'
])
const streams = new Set(['workspace/follow', 'session/control', 'session/follow'])

export function bridgeNativeWire(gateway, native) {
  if (typeof gateway.invokeRpc !== 'function' || typeof gateway.openWireStream !== 'function') throw Error('Unsupported DSH 0.1.7 Web carrier')
  const originalRpc = gateway.invokeRpc, originalStream = gateway.openWireStream
  const failure = { ok: false, error: { code: 'gateway/internal', message: 'Remote conversation operation failed', details: {} } }
  const rpc = async (endpoint, payload, signal, peer) => {
    if (!native.hosts.length || !/^\w+\/\w+$/.test(endpoint)) return originalRpc.call(gateway, endpoint, payload, signal, peer)
    const [namespace, method] = endpoint.split('/')
    const request = { namespace, method, args: payload?.args ?? {}, signal, peer }
    try {
      if (!aggregate.has(endpoint) && !native.route(request).hostId) return originalRpc.call(gateway, endpoint, payload, signal, peer)
      return { ok: true, value: await native.invoke(request) }
    } catch { return failure }
  }
  const stream = (endpoint, payload, uplink, peer, signal, control) => {
    if (!native.hosts.length || !streams.has(endpoint)) return originalStream.call(gateway, endpoint, payload, uplink, peer, signal, control)
    const [namespace, method] = endpoint.split('/')
    const request = { namespace, method, args: payload?.args ?? {}, uplink, peer, signal }
    if (endpoint === 'session/follow' && !native.route(request).hostId) return originalStream.call(gateway, endpoint, payload, uplink, peer, signal, control)
    return native.stream(request)
  }
  gateway.invokeRpc = rpc; gateway.openWireStream = stream
  return () => {
    if (gateway.invokeRpc === rpc) gateway.invokeRpc = originalRpc
    if (gateway.openWireStream === stream) gateway.openWireStream = originalStream
  }
}
