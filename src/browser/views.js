    const blankHost = () => ({ name: '', type: 'manual', hostname: '', user: '', sshPort: 22, dshPort: 3080, keyPath: '' })
    function Field({ label, hint, ...props }) {
      return h('label', { className: 'dshm-field' }, h('span', null, label), h('input', { 'aria-label': label, ...props }), hint && h('small', null, hint))
    }
    function HostForm({ initial, onSave, onClose }) {
      const [value, setValue] = React.useState(initial ?? blankHost()), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
      const set = key => event => setValue(previous => ({ ...previous, [key]: event.target.value }))
      async function submit(event) {
        event.preventDefault(); setError('')
        const target = { ...value, sshPort: Number(value.sshPort), dshPort: Number(value.dshPort) }
        if (![target.sshPort, target.dshPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) { setError('端口必须是 1–65535 的整数'); return }
        setBusy(true)
        try { await onSave(target); onClose() } catch (error) { setError(error.message) } finally { setBusy(false) }
      }
      return h('form', { className: 'dshm-editor', onSubmit: submit, 'aria-label': initial ? '编辑主机' : '添加主机' },
        h('div', { className: 'dshm-section-head' }, h('h3', null, initial ? '编辑主机' : '添加 SSH 主机'), h('span', { className: 'dshm-muted' }, value.type === 'config' ? '引用已有 SSH config' : '手动配置')),
        h('div', { className: 'dshm-fields' },
          h(Field, { label: '显示名称', value: value.name, required: true, maxLength: 80, autoFocus: true, placeholder: '例如：开发服务器', onChange: set('name') }),
          value.type === 'config' ? h(Field, { label: 'SSH 别名', value: value.alias, readOnly: true, hint: '连接时使用 config 中的最新设置' }) : h(Field, { label: '主机地址', value: value.hostname, required: true, placeholder: '192.168.1.20 或主机名', onChange: set('hostname') }),
          h(Field, { label: 'SSH 用户', value: value.user ?? '', required: value.type === 'manual', readOnly: value.type === 'config', placeholder: '用户名', onChange: set('user') }),
          h(Field, { label: 'SSH 端口', type: 'number', min: 1, max: 65535, value: value.sshPort ?? 22, readOnly: value.type === 'config', onChange: set('sshPort') }),
          h(Field, { label: 'DSH 端口', type: 'number', min: 1, max: 65535, value: value.dshPort, onChange: set('dshPort'), hint: '目标机器上 DSH 使用的端口' }),
          value.type === 'manual' && h(Field, { label: '私钥路径（可选）', value: value.keyPath, placeholder: '~/.ssh/id_ed25519', onChange: set('keyPath'), hint: '填写当前 DSH 后端机器上的路径；留空使用 SSH Agent／默认密钥' })),
        h('p', { className: 'dshm-muted' }, '仅保存连接配置，不修改系统 SSH config。当前支持密钥与 SSH Agent，暂不支持交互式密码登录。'),
        error && h('p', { role: 'alert', className: 'dshm-error' }, error),
        h('div', { className: 'dshm-actions' }, h('button', { type: 'submit', className: 'dshm-primary', disabled: busy }, busy ? '保存中…' : '保存主机'), h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消')))
    }

    function ImportHosts({ model, onClose }) {
      const state = useModel(model)
      const [candidates, setCandidates] = React.useState(null), [selected, setSelected] = React.useState([]), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        const abort = new AbortController()
        api('ssh-import', undefined, abort.signal).then(data => { setCandidates(data.hosts); if (data.unavailable.length) setError('部分别名无法解析：' + data.unavailable.join('、')) }, error => { if (!abort.signal.aborted) setError(error.message) })
        return () => abort.abort()
      }, [])
      async function importSelected() {
        setBusy(true); setError('')
        try {
          for (const target of candidates.filter(target => selected.includes(target.alias))) await model.save(target)
          onClose()
        } catch (error) { setError(error.message); setSelected([]) }
        finally { setBusy(false) }
      }
      return h('section', { className: 'dshm-editor', 'aria-label': '从 SSH config 导入' },
        h('h3', null, '从 SSH config 导入'), h('p', { className: 'dshm-muted' }, '选择要添加的别名。这里只读取当前 DSH 后端的 ~/.ssh/config，不会连接远端。'),
        candidates === null && !error && h('p', { role: 'status' }, '正在读取 SSH config…'),
        candidates?.length === 0 && h('p', null, '没有找到可导入的别名，可以返回后手动添加。'),
        h('div', { className: 'dshm-import-list' }, candidates?.map(target => {
          const exists = state.targets.some(item => item.type === 'config' && item.alias === target.alias)
          return h('label', { key: target.alias, className: 'dshm-import-row' }, h('input', { type: 'checkbox', disabled: exists || busy, checked: selected.includes(target.alias), onChange: event => setSelected(previous => event.target.checked ? [...previous, target.alias] : previous.filter(alias => alias !== target.alias)) }),
            h('span', null, h('strong', null, target.alias), h('small', null, `${target.user}@${target.hostname}:${target.sshPort}`)), exists && h('span', { className: 'dshm-muted' }, '已导入'))
        })),
        error && h('p', { role: 'alert', className: 'dshm-error' }, error),
        h('div', { className: 'dshm-actions' }, h('button', { className: 'dshm-primary', disabled: !selected.length || busy, onClick: importSelected }, busy ? '正在导入…' : `导入所选${selected.length ? '（' + selected.length + '）' : ''}`), h('button', { disabled: busy, onClick: onClose }, '取消')))
    }

    function ConnectHost({ model, target, onClose }) {
      const [method, setMethod] = React.useState('auto'), [loginUrl, setLoginUrl] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
      async function connect(event) {
        event.preventDefault(); setBusy(true); setError('')
        try { await model.connect(target, method === 'link' ? loginUrl : undefined); onClose() }
        catch (error) { setError(error.message) }
        finally { setBusy(false); setLoginUrl('') }
      }
      return h('form', { className: 'dshm-editor', onSubmit: connect, 'aria-label': '连接 DSH' },
        h('h3', null, '连接 ' + target.name),
        h('p', { className: 'dshm-destination' }, `${target.user}@${target.hostname}:${target.sshPort} → DSH :${target.dshPort}`),
        h('div', { className: 'dshm-choice' }, ['auto', 'link'].map(value => h('label', { key: value }, h('input', { type: 'radio', name: 'dsh-auth', checked: method === value, disabled: busy, onChange: () => setMethod(value) }), value === 'auto' ? '通过 SSH 读取 DSH 登录信息' : '提供 DSH 登录链接'))),
        method === 'auto' ? h('p', { className: 'dshm-muted' }, '适用于 Linux、Python 3 和可读取的 DSH 启动日志。其他启动方式可选择提供登录链接。') : h(Field, { label: 'DSH 登录链接', value: loginUrl, type: 'password', required: true, autoComplete: 'off', placeholder: 'http://127.0.0.1:3080/?token=…', onChange: event => setLoginUrl(event.target.value), hint: '通过 SSH 使用链接内的端口；链接仅用于本次连接，不保存。' }),
        h('p', { className: 'dshm-muted' }, '连接成功后，会话将出现在侧栏。关闭设置不会断开连接。'),
        error && h('p', { role: 'alert', className: 'dshm-error' }, error),
        h('div', { className: 'dshm-actions' }, h('button', { className: 'dshm-primary', type: 'submit', disabled: busy }, busy ? '连接中…' : '连接并显示会话'), h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消')))
    }

    function WorkspaceForm({ model, connection, onClose }) {
      const [path, setPath] = React.useState(''), [listing, setListing] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
      const active = React.useRef(null)
      React.useEffect(() => () => active.current?.abort(), [])
      async function browse(nextPath) {
        active.current?.abort()
        const controller = new AbortController(); active.current = controller
        setBusy(true); setError(''); setListing(null)
        try {
          const value = await model.workspace(connection, 'browse', nextPath || undefined, controller.signal)
          if (!controller.signal.aborted) { setListing(value); setPath(value.path) }
        } catch (error) { if (!controller.signal.aborted) setError(error.message) }
        finally { if (!controller.signal.aborted) setBusy(false) }
      }
      async function create(event) {
        event.preventDefault(); setBusy(true); setError('')
        try { await model.workspace(connection, 'create', path); onClose() }
        catch (error) { setError(error.message); setBusy(false) }
      }
      return h('form', { className: 'dshm-editor', 'aria-label': '添加远端工作区', onSubmit: create },
        h('h3', null, '添加工作区 · ' + connection.target.name),
        h('p', { className: 'dshm-muted' }, '选择这台后端上的已有目录。添加后会显示在原生侧栏，任务在该后端运行。'),
        h(Field, { label: '远端目录', value: path, required: true, disabled: busy, onChange: event => { setPath(event.target.value); setListing(null) }, placeholder: '输入远端绝对路径，或点击浏览' }),
        h('div', { className: 'dshm-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => browse(path) }, '浏览目录'), h('button', { type: 'button', disabled: busy, onClick: () => browse(undefined) }, '主目录')),
        listing && h('div', { className: 'dshm-directory' },
          h('nav', { 'aria-label': '远端目录层级' }, listing.crumbs.map(crumb => h('button', { key: crumb.path, type: 'button', disabled: busy, onClick: () => browse(crumb.path) }, crumb.name))),
          h('ul', null, listing.entries.map(entry => h('li', { key: entry.path }, h('button', { type: 'button', disabled: busy, onClick: () => browse(entry.path) }, '▸ ' + entry.name)))),
          !listing.entries.length && h('p', null, '没有子目录，可添加当前目录'),
          listing.truncated && h('p', { className: 'dshm-muted' }, '目录较多，后端只返回部分结果；也可以直接输入完整路径。')),
        busy && h('p', { role: 'status' }, '正在处理…'),
        error && h('p', { role: 'alert', className: 'dshm-error' }, error),
        h('p', { className: 'dshm-muted' }, '若该后端未提供目录浏览，可直接输入路径添加。不会在远端弹出系统窗口。'),
        h('div', { className: 'dshm-actions' }, h('button', { className: 'dshm-primary', type: 'submit', disabled: busy || !path.trim() }, '添加到侧栏'), h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消')))
    }

    function Panel({ model, close }) {
      const state = useModel(model)
      const [editor, setEditor] = React.useState(null), [query, setQuery] = React.useState(''), [error, setError] = React.useState('')
      const run = promise => promise.catch(error => setError(error.message))
      const targets = state.targets.filter(target => [target.name, target.hostname, target.user, target.alias].some(value => value?.toLowerCase().includes(query.toLowerCase())))
      return h('section', { className: 'dshm dshm-manager', 'aria-label': 'DSH 多端管理' },
        h('header', { className: 'dshm-header' }, h('div', { className: 'dshm-heading' }, h('span', { className: 'dshm-brand' }, h(HostIcon, { size: 23 })), h('div', null, h('h2', null, 'DSH 多端管理 · Remote SSH'), h('p', null, '管理 SSH 主机，在当前客户端使用远端 DSH'))),
          h('span', { className: 'dshm-version' }, '开发预览')),
        h('div', { className: 'dshm-toolbar' }, h('input', { type: 'search', 'aria-label': '搜索主机', placeholder: '搜索名称、地址或用户…', value: query, onChange: event => setQuery(event.target.value) }),
          h('div', { className: 'dshm-actions' }, h('button', { onClick: () => setEditor({ kind: 'import' }) }, '从 SSH config 导入'), h('button', { className: 'dshm-primary', onClick: () => setEditor({ kind: 'edit' }) }, '＋ 添加主机'))),
        h('div', { className: 'dshm-summary' }, h('span', null, `已保存 ${state.targets.length} 台主机`), h('span', null, `已连接 ${Object.keys(state.connections).length} 台`)),
        editor?.kind === 'edit' && h(HostForm, { key: editor.target?.id ?? 'new', initial: editor.target, onSave: value => model.save(value), onClose: () => setEditor(null) }),
        editor?.kind === 'import' && h(ImportHosts, { model, onClose: () => setEditor(null) }),
        editor?.kind === 'connect' && h(ConnectHost, { model, target: editor.target, onClose: () => setEditor(null) }),
        editor?.kind === 'workspace' && h(WorkspaceForm, { key: editor.connection.connectionId, model, connection: editor.connection, onClose: () => setEditor(null) }),
        editor?.kind === 'remove' && h('section', { className: 'dshm-editor', role: 'alertdialog', 'aria-label': '移除主机' },
          h('h3', null, '移除 ' + editor.target.name + '？'), h('p', null, '只移除本插件中的配置，并断开本地连接。不会删除远端会话或修改 SSH config。'),
          h('div', { className: 'dshm-actions' }, h('button', { className: 'dshm-danger', onClick: () => run(model.remove(editor.target.id).then(() => setEditor(null))) }, '确认移除'), h('button', { onClick: () => setEditor(null) }, '取消'))),
        (error || state.error) && h('p', { className: 'dshm-error', role: 'alert' }, error || state.error),
        state.loading ? h('div', { className: 'dshm-empty', role: 'status' }, '正在读取已保存的主机…') : state.targets.length === 0 ? h('div', { className: 'dshm-empty' },
          h(HostIcon, { size: 34 }), h('h3', null, '添加你的第一台主机'), h('p', null, '手动填写 SSH 信息，或选择 config 中的主机。'), h('p', { className: 'dshm-muted' }, '连接成功后，远端会话会出现在侧栏。不会自动添加或连接任何主机。')) :
          h('div', { className: 'dshm-table-wrap' }, h('table', { className: 'dshm-table', 'aria-label': '已保存的 SSH 主机' },
            h('thead', null, h('tr', null, ['主机', '连接目标', 'DSH', '状态', '操作'].map(label => h('th', { key: label, scope: 'col' }, label)))),
            h('tbody', null, targets.map(target => {
              const connection = state.connections[target.id], destination = connection?.destination ?? target, busy = state.busy[target.id]
              return h(React.Fragment, { key: target.id }, h('tr', null,
                h('td', null, h('strong', null, target.name), h('small', null, target.type === 'config' ? 'SSH config · ' + target.alias : '手动配置')),
                h('td', { className: 'dshm-destination' }, destination.hostname, h('small', null, `${destination.user} · SSH ${destination.sshPort}`)),
                h('td', { className: 'dshm-number' }, ':' + target.dshPort),
                h('td', null, h('span', { className: 'dshm-status ' + (connection?.status === 'connected' ? 'is-connected' : '') }, h('i'), busy || (connection ? connection.status === 'reconnecting' ? '恢复中' : connection.status === 'offline' ? '已断线' : '已连接' : '未连接'))),
                h('td', null, h('div', { className: 'dshm-row-actions' },
                  h('button', { disabled: !!busy, onClick: () => run(model.check(target)) }, '测试'),
                  h('button', { disabled: !!busy || !!connection, title: connection ? '请先断开连接再编辑' : '编辑主机', onClick: () => setEditor({ kind: 'edit', target }) }, '编辑'),
                  connection && h('button', { disabled: !!busy || connection.status === 'reconnecting', onClick: () => run(model.reconnect(target)) }, '重连'),
                  connection && h('button', { disabled: !!busy || connection.status !== 'connected', onClick: () => setEditor({ kind: 'workspace', connection }) }, '添加工作区'),
                  connection ? h('button', { disabled: !!busy, onClick: () => run(model.disconnect(target.id)) }, '断开') : h('button', { className: 'dshm-connect', disabled: !!busy, onClick: () => setEditor({ kind: 'connect', target }) }, '连接'),
                  h('button', { className: 'dshm-danger', disabled: !!busy, onClick: () => setEditor({ kind: 'remove', target }) }, '移除')))),
                (state.notices[target.id] || connection?.error) && h('tr', { className: 'dshm-notice' }, h('td', { colSpan: 5, role: 'status' }, state.notices[target.id] || connection.error)))
            })))),
        !state.loading && state.targets.length > 0 && !targets.length && h('p', { className: 'dshm-empty' }, '没有匹配的主机'),
        Object.values(state.connections).map(connection => h('section', { className: 'dshm-session-preview', key: connection.connectionId },
          h('div', { className: 'dshm-section-head' }, h('h3', null, connection.target.name + ' · 远端会话'), h('span', { className: 'dshm-muted' }, '已加入侧栏')),
          h('p', { className: 'dshm-muted' }, '关闭设置后，可以直接从侧栏打开这些会话。'),
          h('p', { className: 'dshm-muted' }, connection.compatibility || '正在读取兼容性检查结果…'),
          h('ul', null, connection.sessions.filter(session => !session.archived).map(session => h('li', { key: session.sessionId }, h('span', null, sessionTitle(session)), h('button', { onClick: () => { model.open(connection, session); close?.() } }, '在主界面打开')))),
          connection.sessions.some(session => session.archived) && h('p', { className: 'dshm-muted' }, '已归档会话已隐藏；恢复请使用所属后端的归档管理。'),
          !connection.sessions.some(session => !session.archived) && h('p', null, '该后端没有未归档的会话'))),
        h('details', { className: 'dshm-help' }, h('summary', null, '连接与操作说明'),
          h('p', null, '“测试”检查 SSH；“连接”登录远端 DSH 并将会话加入侧栏。SSH 与 DSH 的端口可以分别设置。'),
          h('p', null, '连接由插件保持，关闭设置不会断开。断开连接不会停止远端任务。刷新页面保留连接；通过 SSH 自动读取登录信息并成功连接过的主机，会在主后端重启后自动恢复；手动断开会取消恢复。手动登录链接不保存，重启后需重新提供。连接变化通过 DSH 原生重连更新侧栏，不刷新整页。断线会自动尝试恢复，也可点击“重连”；不会自动重发消息。'),
          h('p', null, '远端不需要安装此插件。工具审批、用户提问、第三方交互卡片和归档恢复尚未接入，请在所属后端的界面处理。全局设置仍属于主后端。')))
    }

