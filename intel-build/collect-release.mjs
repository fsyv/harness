/** Verify generated update hashes and collect only public release files. */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const { load, dump } = require('js-yaml')
const directory = 'apps/desktop/.desktop-build/targets/mac-x64/unsigned-artifacts'
const destination = join(process.env.RUNNER_TEMP, 'intel-release')
mkdirSync(destination, { recursive: true })
const metadata = load(readFileSync(join(directory, 'nightly-mac.yml'), 'utf8'))
if (metadata.version !== process.env.BUILD_VERSION) throw new Error('Update metadata version mismatch')
const files = readdirSync(directory).filter(name => /\.(?:dmg|zip|blockmap)$/.test(name))
if (!files.some(name => name.endsWith('.zip')) || !files.some(name => name.endsWith('.dmg'))) throw new Error('Missing ZIP or DMG')
async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}
const base = `https://github.com/fsyv/harness/releases/download/${process.env.RELEASE_TAG}/`
for (const file of metadata.files) {
  if (!files.includes(file.url)) throw new Error(`Unexpected update asset: ${file.url}`)
  if (await digest(join(directory, file.url), 'sha512', 'base64') !== file.sha512) throw new Error('Update ZIP checksum mismatch')
  file.url = base + encodeURIComponent(file.url)
}
if (metadata.path) metadata.path = base + encodeURIComponent(metadata.path)
for (const name of files) copyFileSync(join(directory, name), join(destination, name))
writeFileSync(join(destination, 'nightly-mac.yml'), dump(metadata, { lineWidth: -1 }))
copyFileSync('LICENSE', join(destination, 'LICENSE.upstream.txt'))
writeFileSync(join(destination, 'build-info.json'), JSON.stringify({
  version: metadata.version, upstreamTag: process.env.UPSTREAM_TAG, upstreamCommit: process.env.UPSTREAM_SHA,
  sourceCommit: process.env.SOURCE_COMMIT, recipeHash: process.env.RECIPE_HASH,
  platform: 'darwin', architecture: 'x64', signing: 'fixed personal certificate; not notarized',
  run: `https://github.com/fsyv/harness/actions/runs/${process.env.GITHUB_RUN_ID}`,
}, null, 2) + '\n')
const sums = []
for (const name of readdirSync(destination).sort()) sums.push(`${await digest(join(destination, name), 'sha256', 'hex')}  ${name}`)
writeFileSync(join(destination, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`Verified release ${metadata.version}: ${destination}`)
