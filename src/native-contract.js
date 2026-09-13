// Explicit 0.1.5-rc.1 adapter surface. Never forward arbitrary plugin RPCs.
export const nativeOperations = new Set([
  'session/list', 'session/create', 'session/fork', 'session/prompt', 'session/cancel',
  'session/rename', 'session/page', 'session/selectModel', 'session/attachment', 'session/updateQueue',
  'skills/list', 'fileReferences/list', 'fileUploads/upload',
  'workspace/rename', 'workspace/delete', 'workspace/insertSessionBefore', 'workspace/archiveSession', 'workspace/insertBefore'
])

export async function checkNativeContract(transport, signal) {
  const results = await Promise.all(['workspace', 'session'].map(async namespace => {
    const lifetime = new AbortController()
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])])
    const iterator = (await transport.stream({ namespace, method: namespace === 'workspace' ? 'follow' : 'control', args: {}, signal: combined }))[Symbol.asyncIterator]()
    try {
      const { value, done } = await iterator.next()
      const data = value?.value
      if (done || value?.type !== 'baseline' || !data) throw Error('Unsupported native baseline')
      if (namespace === 'workspace') {
        if (!Array.isArray(data.items) || !Array.isArray(data.archivedSessionIds) || data.archivedSessionIds.some(id => typeof id !== 'string') || data.items.some(item => typeof item.workspaceId !== 'string' || typeof item.title !== 'string' || !Array.isArray(item.sessionIds))) throw Error('Unsupported workspace baseline')
      } else if (['queues', 'jobs', 'projections'].some(key => !data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) throw Error('Unsupported control baseline')
      return data
    } finally { lifetime.abort(); await iterator.return?.() }
  }))
  return { workspace: results[0], label: '基础协议检查通过 · 适配基线 DSH 0.1.5-rc.1；远端版本未核验' }
}
