import { win32 } from 'node:path'

export function dshPort(value = 3080) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid DSH port')
  return value
}

export function sshExecutable(platform = process.platform, env = process.env) {
  return platform === 'win32' ? win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh'
}
