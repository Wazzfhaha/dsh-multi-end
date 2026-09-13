    function recordText(record) {
      const event = record.event
      const content = event?.data?.message?.content ?? event?.data?.content
      if (Array.isArray(content)) return content.map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : `[${block.type}]`).join('\n')
      return JSON.stringify(event?.data ?? record)
    }
    function addChunk(blocks, chunk) {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') blocks[chunk.index] = (blocks[chunk.index] ?? '') + chunk.text
      if (chunk.type === 'block-end' && typeof chunk.block?.text === 'string') blocks[chunk.index] = chunk.block.text
    }
    function reduceConversation(previous, value) {
      if (value.type === 'snapshot') {
        if (!Array.isArray(value.records) || !Number.isSafeInteger(value.cursor) || !Number.isSafeInteger(value.assistantStream?.revision)) throw Error('Unsupported snapshot')
        const active = value.assistantStream.activeAttempt, blocks = {}
        for (const record of active?.stream ?? []) {
          if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') blocks[record.index] = (blocks[record.index] ?? '') + record.texts.join('')
          if (record.type === 'chunk') addChunk(blocks, record.chunk)
        }
        return { records: value.records, cursor: value.cursor, hasMore: !!value.hasMore, revision: value.assistantStream.revision, attemptId: active?.attemptId, nextIndex: active?.nextIndex ?? 0, blocks, liveText: Object.values(blocks).join('\n') }
      }
      if (!previous) throw Error('Snapshot required')
      const state = { ...previous, blocks: { ...previous.blocks } }
      if (value.type === 'event') {
        if (!Number.isSafeInteger(value.event?.seq)) throw Error('Invalid event')
        if (value.event.seq <= state.cursor) return state
        state.cursor = value.event.seq
        state.records = [...state.records, { type: 'event', event: value.event }]
        if (state.committedSeq === value.event.seq) { state.blocks = {}; state.liveText = '' }
      } else if (value.type === 'assistant-stream') {
        const frame = value.frame
        if (frame.revision !== state.revision + 1) throw Error('Stream revision gap')
        state.revision = frame.revision
        if (frame.type === 'start') { state.attemptId = frame.attemptId; state.nextIndex = 0; state.blocks = {}; state.committedSeq = undefined }
        else {
          if (frame.attemptId !== state.attemptId) throw Error('Stream attempt mismatch')
          if (frame.type === 'chunk') {
            if (frame.index !== state.nextIndex) throw Error('Stream index gap')
            state.nextIndex++
            addChunk(state.blocks, frame.chunk)
          } else if (frame.type === 'end') {
            state.committedSeq = frame.outcome?.kind === 'committed' ? frame.outcome.seq : undefined
            if (state.committedSeq === undefined || state.committedSeq <= state.cursor) state.blocks = {}
          } else throw Error('Unsupported stream frame')
        }
        state.liveText = Object.values(state.blocks).join('\n')
      } else throw Error('Unsupported follow frame')
      return state
    }
    async function api(action, input, signal) {
      const response = await fetch(`/api/ssh-workspaces/${action}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal })
      const data = await response.json()
      if (!response.ok || data.error) throw Error(data.error ?? '请求失败')
      return data
    }
    function Conversation({ connectionId, sessionId, host, title, drafts }) {
      const draftKey = connectionId + ':' + sessionId
      const [state, setState] = React.useState(null), [text, setText] = React.useState(() => drafts?.get(draftKey) ?? '')
      const [status, setStatus] = React.useState('正在打开会话…'), [ready, setReady] = React.useState(false)
      const [busy, setBusy] = React.useState(false), [revision, setRevision] = React.useState(0)
      const current = React.useRef(null), mounted = React.useRef(false), sending = React.useRef(false)
      const identity = { connectionId, sessionId }
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])
      React.useEffect(() => {
        const abort = new AbortController()
        setReady(false); setStatus('正在读取历史并订阅…')
        let reader
        ;(async () => {
          try {
            const response = await fetch('/api/ssh-workspaces/follow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity), signal: abort.signal })
            if (!response.ok || !response.body) throw Error('无法打开会话，请重新连接主机')
            reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (true) {
              const part = await reader.read()
              if (abort.signal.aborted) return
              if (part.done) throw Error('连接已断开；重新订阅可恢复历史，不会重发消息')
              buffer += decoder.decode(part.value, { stream: true })
              if (buffer.length > 8 * 1024 * 1024) throw Error('远端事件过大')
              let end
              while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
                if (!line) continue
                const value = JSON.parse(line)
                current.current = reduceConversation(current.current, value)
                setState(current.current)
                if (value.type === 'snapshot') { setReady(true); setStatus('已连接，操作将在 ' + host + ' 执行') }
              }
            }
          } catch (error) {
            if (!abort.signal.aborted) { setReady(false); setStatus(error.message) }
          } finally { await reader?.cancel().catch(() => {}) }
        })()
        return () => abort.abort()
      }, [connectionId, sessionId, revision])
      async function command(action) {
        if (sending.current || !ready) return
        sending.current = true; setBusy(true)
        try {
          const input = { ...identity, action }
          if (action === 'send') { input.text = text; input.requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') }
          if (action === 'page') {
            input.throughSeq = current.current.cursor
            input.beforeSeq = Math.min(...current.current.records.map(record => record.event?.seq).filter(Number.isSafeInteger))
          }
          const result = await api('command', input)
          if (!mounted.current) return
          if (action === 'page') {
            const records = new Map([...result.records, ...current.current.records].map(record => [record.event.seq, record]))
            current.current = { ...current.current, records: [...records.values()].sort((a, b) => a.event.seq - b.event.seq), hasMore: result.hasMore }
            setState(current.current)
          } else {
            if (result.accepted !== true) throw Error('远端未确认操作')
            if (action === 'send') { setText(''); drafts?.delete(draftKey) }
            setStatus(action === 'send' ? '消息已提交，等待远端执行' : '停止请求已提交')
          }
        } catch (error) {
          if (mounted.current) { setStatus(error.message); setReady(false) }
        } finally { sending.current = false; if (mounted.current) setBusy(false) }
      }
      return h('section', { 'aria-label': '远端对话', className: 'dshm-conversation' },
        h('h3', null, title ?? `${host} · ${sessionId}`),
        h('p', null, '当前支持文本、基础历史和实时输出。工具审批、附件及插件专属交互请使用该后端原有界面。'),
        h('div', { className: 'dshm-actions' }, h('button', { disabled: busy, onClick: () => setRevision(value => value + 1) }, '重新订阅'),
        state?.hasMore && h('button', { disabled: !ready || busy, onClick: () => command('page') }, '加载更早历史')),
        h('div', { className: 'dshm-history', 'aria-label': '会话历史' },
          state?.records.map((record, index) => h('article', { key: record.event?.seq ?? index }, h('strong', null, record.event?.type ?? '事件'), h('pre', null, recordText(record)))),
          state?.liveText && h('article', { 'aria-label': '实时输出' }, h('strong', null, '正在输出'), h('pre', null, state.liveText)),
          state && !state.records.length && !state.liveText && h('p', null, '暂无消息')),
        h('label', { className: 'dshm-field' }, '消息 ', h('textarea', { 'aria-label': '远端消息', placeholder: '发送消息到 ' + host, value: text, disabled: busy, onChange: event => { setText(event.target.value); drafts?.set(draftKey, event.target.value) }, rows: 3, maxLength: 100000 })),
        h('div', { className: 'dshm-actions' }, h('button', { className: 'dshm-primary', disabled: !ready || busy || !text.trim(), onClick: () => command('send') }, '发送到 ' + host),
        h('button', { disabled: !ready || busy, onClick: () => command('stop') }, '停止生成')),
        h('p', { role: 'status' }, status))
    }
