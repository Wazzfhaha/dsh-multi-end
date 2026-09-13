import { readFile, realpath, glob } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dshPort, sshExecutable } from './connection-options.js'
import { sessionsWithLogin, connectWithLogin } from './ssh-http.js'
import { targetArgs } from './ssh-target.js'

const run = promisify(execFile)
const concrete = value => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)

// Discovery only. OpenSSH remains responsible for evaluating connection options.
export async function listHosts(home = homedir()) {
  const hosts = new Set(), seen = new Set()
  const base = join(home, '.ssh')
  async function visit(file) {
    let canonical, source
    try { canonical = await realpath(file); source = await readFile(canonical, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (seen.has(canonical)) return
    seen.add(canonical)
    let conditional = false
    for (const line of source.split(/\r?\n/)) {
      const parts = line.match(/"[^"\n]*"|'[^'\n]*'|[^\s=]+/g) ?? []
      const key = parts.shift()?.toLowerCase()
      const args = parts.slice(0, parts.findIndex(x => x.startsWith('#')) < 0 ? undefined : parts.findIndex(x => x.startsWith('#'))).map(x => x.replace(/^(['"])(.*)\1$/, '$2'))
      if (key === 'match') conditional = true
      if (key === 'host') {
        conditional = false
        for (const alias of args) if (concrete(alias)) hosts.add(alias)
      }
      if (key === 'include' && !conditional) for (let pattern of args) {
        if (pattern.startsWith('~/')) pattern = join(home, pattern.slice(2))
        if (!isAbsolute(pattern)) pattern = join(base, pattern)
        for await (const included of glob(pattern)) await visit(included)
      }
    }
  }
  await visit(join(base, 'config'))
  return [...hosts]
}

export async function checkHost(alias) {
  if (!concrete(alias) || !(await listHosts()).includes(alias)) throw new Error('Unknown SSH alias')
  const options = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8']
  const { stdout } = await run(sshExecutable(), [...options, alias, 'echo DSH_SSH_CONNECTED'], { windowsHide: true, timeout: 12000, maxBuffer: 65536 })
  if (stdout.trim() !== 'DSH_SSH_CONNECTED') throw new Error('Unexpected SSH response')
  return { connected: true }
}

export async function readRemoteSessions(alias, port = 3080, loginUrl) {
  if (!concrete(alias) || !(await listHosts()).includes(alias)) throw new Error('Unknown SSH alias')
  if (loginUrl) return sessionsWithLogin(alias, loginUrl)
  return probeRemote(alias, dshPort(port))
}

export async function connectRemote(alias, port = 3080, loginUrl) {
  if (!concrete(alias) || !(await listHosts()).includes(alias)) throw new Error('Unknown SSH alias')
  if (!loginUrl) loginUrl = (await probeRemote(alias, dshPort(port), true)).loginUrl
  return connectWithLogin(alias, loginUrl)
}

export async function configuredHost(alias) {
  if (!concrete(alias) || !(await listHosts()).includes(alias)) throw Error('Unknown SSH alias')
  const { stdout } = await run(sshExecutable(), ['-G', alias], { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 })
  const fields = Object.fromEntries(stdout.split(/\r?\n/).map(line => { const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)] }))
  return { type: 'config', alias, name: alias, hostname: fields.hostname, user: fields.user, sshPort: dshPort(Number(fields.port)), dshPort: 3080 }
}

export async function checkTarget(target) {
  const { stdout } = await run(sshExecutable(), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', ...targetArgs(target), 'echo DSH_SSH_CONNECTED'], { windowsHide: true, timeout: 12000, maxBuffer: 65536 })
  if (stdout.trim() !== 'DSH_SSH_CONNECTED') throw Error('Unexpected SSH response')
  return { connected: true }
}

export async function connectTarget(target, loginUrl) {
  targetArgs(target)
  if (!loginUrl) loginUrl = (await probeRemote(target, dshPort(target.dshPort), true)).loginUrl
  return connectWithLogin(target, loginUrl)
}

async function probeRemote(alias, port, handoff = false) {
  const script = await readFile(new URL('./remote_probe.py', import.meta.url), 'utf8')
  return new Promise((resolve, reject) => {
    const child = execFile(sshExecutable(), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', ...targetArgs(alias), `python3 - ${port}${handoff ? ' handoff' : ''}`],
      { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        try {
          const result = JSON.parse(stdout)
          if (error || result.authenticated !== true || !Array.isArray(result.sessions)) throw new Error('远端认证不可用；需要 Linux、Python 3 和可读的 DSH 进程日志。')
          resolve(result)
        } catch { reject(new Error('远端认证或会话读取失败；此启动方式可能不支持自动读取登录链接。')) }
      })
    child.stdin.on('error', () => {})
    child.stdin.end(script)
  })
}
