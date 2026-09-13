    function createClientModel(request = api, navigation = {}) {
      let state = { targets: [], connections: {}, notices: {}, busy: {}, loading: true, error: '' }, disposed = false
      const listeners = new Set(), drafts = new Map()
      const update = change => { state = { ...state, ...change }; for (const listener of listeners) listener() }
      const notice = (id, value) => update({ notices: { ...state.notices, [id]: value } })
      async function operation(id, action, callback) {
        if (disposed || state.busy[id]) return
        update({ busy: { ...state.busy, [id]: action } }); notice(id, '')
        try { return await callback() }
        catch (error) { if (!disposed) notice(id, error.message); throw error }
        finally { if (!disposed) update({ busy: { ...state.busy, [id]: '' } }) }
      }
      const model = {
        drafts,
        getSnapshot: () => state,
        subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
        async load() {
          try {
            const data = await request('targets')
            const connections = navigation.native ? Object.fromEntries((data.connections ?? []).map(connection => [connection.host, { ...connection, target: data.targets.find(target => target.id === connection.host) }]).filter(([, connection]) => connection.target)) : state.connections
            if (!disposed && navigation.native) for (const [id, connection] of Object.entries(connections)) {
              if (state.connections[id] && (connection.revision ?? 0) > (state.connections[id].revision ?? 0)) navigation.recovered?.(connection)
            }
            if (!disposed) update({ targets: data.targets, connections, loading: false, error: '' })
          }
          catch (error) { if (!disposed) update({ loading: false, error: error.message }); throw error }
        },
        async save(target) {
          const result = await request('targets', { action: 'save', target })
          await model.load()
          return result.target
        },
        async remove(id) {
          await model.disconnect(id)
          await request('targets', { action: 'remove', id })
          await model.load()
        },
        check(target) {
          return operation(target.id, '测试中', async () => {
            const result = await request('check', { id: target.id })
            if (!disposed) notice(target.id, result.connected ? 'SSH 可用，可以连接 DSH' : 'SSH 不可用')
          })
        },
        connect(target, loginUrl) {
          return operation(target.id, '连接中', async () => {
            const result = await request('connect', { host: target.id, loginUrl: loginUrl || undefined })
            if (disposed) { await request('disconnect', { connectionId: result.connectionId }); return }
            try {
              if (!navigation.native) await model.disconnect(target.id)
              const connection = { ...result, target }
              navigation.connected?.(connection)
              update({ connections: { ...state.connections, [target.id]: connection } })
              notice(target.id, `已连接 · ${result.sessions.length} 个会话已加入侧栏`)
            } catch (error) { await request('disconnect', { connectionId: result.connectionId }).catch(() => {}); throw error }
          })
        },
        async disconnect(id) {
          const connection = state.connections[id]
          if (!connection) return
          const next = { ...state.connections }; delete next[id]
          update({ connections: next })
          await request('disconnect', { connectionId: connection.connectionId }).catch(() => {})
          navigation.disconnected?.(connection)
          notice(id, '已断开；远端任务继续运行')
        },
        reconnect(target) {
          return operation(target.id, '重连中', async () => {
            const connection = state.connections[target.id]
            if (!connection) return
            await request('reconnect', { connectionId: connection.connectionId })
            await model.load()
            notice(target.id, '连接已恢复，未重发消息')
          })
        },
        async workspace(connection, action, path, signal) {
          const result = await request('workspace', { connectionId: connection.connectionId, action, path }, signal)
          if (action === 'create') { navigation.recovered?.(connection); await model.load() }
          return result
        },
        open(connection, session) { return Promise.resolve().then(() => navigation.open?.(connection, session)).catch(error => notice(connection.target.id, error.message)) },
        dispose() {
          disposed = true
          for (const connection of navigation.native ? [] : Object.values(state.connections)) {
            navigation.disconnected?.(connection)
            request('disconnect', { connectionId: connection.connectionId }).catch(() => {})
          }
          state = { ...state, connections: {} }; listeners.clear()
        }
      }
      return model
    }

    function useModel(model) { return React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot) }
    function sessionTitle(session) { return session.title || (session.cwd?.split(/[\\/]/).filter(Boolean).pop() || '会话') + ' · ' + session.sessionId.slice(0, 6) }
    function panelKey(connection, session) { return 'dsh-remote:' + connection.target.id + ':' + session.sessionId }
    function HostIcon({ size = 18 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
        h('rect', { x: 3, y: 3, width: 18, height: 7, rx: 2 }), h('rect', { x: 3, y: 14, width: 18, height: 7, rx: 2 }),
        h('path', { d: 'M7 6.5h.01M7 17.5h.01M16 6.5h2M16 17.5h2', strokeLinecap: 'round' }))
    }
