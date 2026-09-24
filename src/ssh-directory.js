import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { posix } from 'node:path'
import streams from 'ssh2-streams'
import { sshExecutable } from './connection-options.js'
import { targetArgs } from './ssh-target.js'

function openSocket(target) {
  const child = spawn(sshExecutable(), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-s', ...targetArgs(target), 'sftp'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin })
  child.on('error', () => socket.destroy(Error('SSH SFTP unavailable')))
  child.on('exit', () => socket.destroy())
  socket.on('close', () => child.kill())
  return socket
}

const nativePath = path => /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
const wirePath = path => /^[a-z]:[\\/]/i.test(path) ? '/' + path.replaceAll('\\', '/') : path

export async function directoryOverSsh(target, { action, path, name }, signal, socketFactory = openSocket) {
  if (!['browse', 'mkdir'].includes(action)) throw Error('无效目录操作')
  if (path !== undefined && (typeof path !== 'string' || path.length > 8192 || /[\x00-\x1f]/.test(path) || !/^(\/|[a-z]:[\\/])/i.test(path))) throw Error('请输入远端绝对目录路径')
  if (action === 'mkdir' && (!path || typeof name !== 'string' || !name || name !== name.trim() || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name) || name.length > 255)) throw Error('请输入单个有效文件夹名称')
  signal?.throwIfAborted()
  const socket = socketFactory(target), sftp = new streams.SFTPStream()
  const lifetime = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])])
  let fail
  const ended = new Promise((resolve, reject) => { fail = reject })
  ended.catch(() => {})
  const stop = () => fail(Error('SSH SFTP connection ended'))
  const abort = () => { fail(lifetime.reason); socket.destroy() }
  socket.on('error', stop); socket.on('close', stop); sftp.on('error', stop)
  lifetime.addEventListener('abort', abort, { once: true })
  const call = (method, ...args) => Promise.race([ended, new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)))])
  try {
    const ready = new Promise(resolve => sftp.once('ready', resolve))
    sftp.pipe(socket).pipe(sftp)
    await Promise.race([ready, ended])
    const home = await call('realpath', '.')
    const current = await call('realpath', path === undefined ? '.' : wirePath(path))
    if (action === 'mkdir') {
      const child = posix.join(current, name)
      await call('mkdir', child)
      return nativePath(child)
    }
    const handle = await call('opendir', current), entries = []
    let truncated = false, scanned = 0
    try {
      for (;;) {
        const batch = await call('readdir', handle).catch(error => { if (error.code === 1) return false; throw error })
        if (batch === false) break
        for (const item of batch) {
          if (++scanned > 10000) { truncated = true; break }
          const name = item.filename
          if (!name || name === '.' || name === '..' || /[\/\x00]/.test(name)) continue
          const child = posix.join(current, name)
          let directory = item.attrs.isDirectory()
          if (item.attrs.isSymbolicLink()) {
            try { directory = (await call('stat', child)).isDirectory() } catch {}
          }
          if (directory) entries.push({ name, path: nativePath(child), hidden: name.startsWith('.') })
        }
        if (truncated) break
      }
    } finally { await call('close', handle) }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const parts = nativePath(current).split('/').filter(Boolean)
    const windows = /^[a-z]:$/i.test(parts[0] ?? '')
    const crumbs = [{ name: windows ? parts.shift() + '/' : '/', path: windows ? nativePath(current).slice(0, 3) : '/', hidden: false }]
    for (const part of parts) crumbs.push({ name: part, path: posix.join(crumbs.at(-1).path, part), hidden: false })
    return { path: nativePath(current), home: nativePath(home), entries, crumbs, truncated }
  } catch (cause) {
    throw Object.assign(new Error('SSH 目录操作失败，请检查远端 SFTP 服务、路径和权限；创建结果不明确时请先刷新目录。', { cause }), { directoryError: 'SSH 目录操作失败，请检查远端 SFTP 服务、路径和权限；创建结果不明确时请先刷新目录。' })
  } finally {
    lifetime.removeEventListener('abort', abort)
    sftp.unpipe(socket); socket.unpipe(sftp); socket.destroy(); sftp.destroy()
  }
}
