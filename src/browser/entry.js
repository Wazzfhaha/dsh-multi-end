    return { reduceConversation, recordText, createClientModel, inject: ['slots', 'layout', 'sessions', 'connection'], apply(ctx) {
      const style = document.createElement('style'); style.textContent = styles; document.head.appendChild(style)
      const managerPanel = 'dsh-remote-manager'
      let refresh, polling = false
      const reconnect = () => { clearTimeout(refresh); refresh = setTimeout(() => ctx.connection.reconnect(), 100) }
      const model = createClientModel(api, {
        native: true,
        connected: reconnect,
        disconnected: reconnect,
        recovered: reconnect,
        open(connection, session) { ctx.layout.selectPanel(null); ctx.sessions.open(session.sessionId) }
      })
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: managerPanel }, () => h('div', { className: 'dshm-main' }, h(Panel, { model }))))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: managerPanel, order: 55, label: () => '多端管理' }, HostIcon))
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'ssh-workspaces', order: 25, label: () => 'DSH 多端管理' }, ({ close }) => h(Panel, { model, close })))
      const poll = setInterval(async () => {
        if (polling) return
        polling = true
        try { await model.load() } catch {} finally { polling = false }
      }, 4000)
      ctx.effect(() => () => { clearTimeout(refresh); clearInterval(poll); model.dispose(); style.remove() }, 'ssh-workspaces client state')
      model.load().catch(() => {})
    } }
