import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { targetArgs } from './ssh-target.js'
import { dshPort } from './connection-options.js'

function normalize(value) {
  const keys = ['id', 'name', 'type', 'alias', 'hostname', 'user', 'sshPort', 'keyPath', 'dshPort']
  if (!value || Object.keys(value).some(key => !keys.includes(key))) throw Error('Unsupported host field')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\x00-\x1f]/.test(value.name)) throw Error('Invalid host name')
  targetArgs(value)
  const result = { id: value.id ?? randomUUID(), name: value.name.trim(), type: value.type, dshPort: dshPort(value.dshPort ?? 3080) }
  if (!/^[0-9a-f-]{36}$/.test(result.id)) throw Error('Invalid host ID')
  if (value.type === 'config') {
    result.alias = value.alias
    for (const key of ['hostname', 'user', 'sshPort']) if (value[key] !== undefined) result[key] = value[key]
  } else {
    Object.assign(result, { hostname: value.hostname, user: value.user, sshPort: value.sshPort ?? 22, keyPath: value.keyPath ?? '' })
  }
  return result
}

export class TargetStore {
  #queue = Promise.resolve()
  constructor(file) { this.file = file }
  async list() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Array.isArray(data) || data.length > 100) throw Error('Invalid saved hosts')
      return data.map(normalize)
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async get(id) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw Error('Saved host not found')
    return target
  }
  #mutate(change) {
    const operation = this.#queue.then(async () => {
      const items = await this.list(), result = change(items)
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.' + randomUUID() + '.tmp'
      try { await writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 }); await rename(temp, this.file) }
      finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      return result
    })
    this.#queue = operation.catch(() => {})
    return operation
  }
  save(value) {
    return this.#mutate(items => {
      const target = normalize(value)
      const index = items.findIndex(item => item.id === target.id)
      if (value.id && index < 0) throw Error('Host no longer exists')
      if (index < 0) {
        if (items.length >= 100) throw Error('Host limit reached')
        if (target.type === 'config' && items.some(item => item.type === 'config' && item.alias === target.alias)) throw Error('SSH alias already imported')
        items.push(target)
      } else items[index] = target
      return target
    })
  }
  remove(id) {
    return this.#mutate(items => {
      const index = items.findIndex(item => item.id === id)
      if (index < 0) throw Error('Host no longer exists')
      items.splice(index, 1)
      return { removed: true }
    })
  }
}
