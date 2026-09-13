import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshPort } from './connection-options.js'

export function targetArgs(target) {
  if (typeof target === 'string') target = { type: 'config', alias: target }
  if (target?.type === 'config') {
    if (typeof target.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(target.alias)) throw Error('Invalid SSH alias')
    return [target.alias]
  }
  if (target?.type !== 'manual' || typeof target.hostname !== 'string' || target.hostname.length > 253 ||
      (!isIP(target.hostname) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(target.hostname)) ||
      typeof target.user !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/.test(target.user)) throw Error('Invalid SSH destination')
  const args = ['-F', 'none', '-p', String(dshPort(target.sshPort ?? 22)), '-l', target.user]
  if (target.keyPath) {
    if (typeof target.keyPath !== 'string' || target.keyPath.length > 1024 || /[\x00-\x1f\x7f]/.test(target.keyPath)) throw Error('Invalid key path')
    const key = target.keyPath.startsWith('~/') ? join(homedir(), target.keyPath.slice(2)) : target.keyPath
    args.push('-i', key, '-o', 'IdentitiesOnly=yes')
  }
  return [...args, target.hostname]
}
