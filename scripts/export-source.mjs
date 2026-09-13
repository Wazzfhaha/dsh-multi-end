import { cp, mkdir, readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const meta = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const output = new URL(`.runtime/github-source-${meta.version}/`, root)
await mkdir(new URL('.runtime/', root), { recursive: true })
await mkdir(output) // Refuse to overwrite an existing export or a user's Git checkout.
const files = ['package.json', 'package-lock.json', '.gitignore', 'README.md', 'LICENSE',
  'docs/compatibility.md', 'docs/install.md', 'docs/github-publishing.md',
  'scripts/build-client.mjs', 'scripts/export-source.mjs']
for (const name of await readdir(new URL('tests/', root))) if (name.endsWith('.test.js')) files.push('tests/' + name)
await cp(new URL('src/', root), new URL('src/', output), { recursive: true, filter: async source => {
  const stat = await lstat(source)
  return !stat.isSymbolicLink() && !source.includes('__pycache__') && (stat.isDirectory() || /\.(js|css|py)$/.test(source))
} })
for (const file of files) {
  const destination = new URL(file, output)
  await mkdir(new URL('./', destination), { recursive: true })
  await cp(new URL(file, root), destination)
}
console.log(fileURLToPath(output))
