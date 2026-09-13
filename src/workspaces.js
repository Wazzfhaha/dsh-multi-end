// Workspace membership comes from workspace/follow, never inferred from cwd.
export function projectWorkspaceTree(hostId, baseline, sessions) {
  const id = value => typeof value === 'string' && value.length > 0
  if (!id(hostId) || !Array.isArray(baseline?.items) || !Array.isArray(baseline.archivedSessionIds) ||
      !baseline.archivedSessionIds.every(id) || !Array.isArray(sessions)) throw Error('Unsupported workspace baseline')
  const archived = new Set(baseline.archivedSessionIds), members = new Set(), seen = new Set()
  const byId = new Map(sessions.map(session => {
    if (!id(session?.sessionId)) throw Error('Unsupported session')
    return [session.sessionId, session]
  }))
  const projectSession = session => ({ ...session, hostId, key: JSON.stringify([hostId, 'session', session.sessionId]) })
  const workspaces = baseline.items.map(workspace => {
    if (!id(workspace?.workspaceId) || seen.has(workspace.workspaceId) || typeof workspace.title !== 'string' ||
        typeof workspace.path !== 'string' || !Array.isArray(workspace.sessionIds) || !workspace.sessionIds.every(id)) throw Error('Unsupported workspace')
    seen.add(workspace.workspaceId)
    for (const sessionId of workspace.sessionIds) members.add(sessionId)
    return {
      hostId, key: JSON.stringify([hostId, 'workspace', workspace.workspaceId]),
      workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path,
      sessions: workspace.sessionIds.filter(sessionId => !archived.has(sessionId) && byId.has(sessionId)).map(sessionId => projectSession(byId.get(sessionId)))
    }
  })
  return { workspaces, unassigned: sessions.filter(session => !archived.has(session.sessionId) && !members.has(session.sessionId)).map(projectSession) }
}
