/** Qualify the pinned signing identity through a real two-version Squirrel.Mac installation. */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { COMMUNITY_APP_ID, signCommunityApp } from '../apps/desktop/scripts/community-package.mjs'

if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('Qualification requires native Intel macOS')
const fixtures = join(process.env.RUNNER_TEMP, 'intel-update-fixtures')
const source = resolve('apps/desktop/.desktop-build/targets/mac-x64/unsigned-artifacts/mac/DeepSeek Harness.app')
const appName = 'DeepSeek Harness.app'
const bundle = path => join(path, 'Contents', 'Info.plist')
const plist = (path, command) => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, bundle(path)], { encoding: 'utf8' }).trim()

const probe = `
const { app } = require('electron')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const root = resolve(process.resourcesPath, '../../../..')
const feedPath = join(root, 'loopback-feed.json')
const { url } = JSON.parse(readFileSync(feedPath, 'utf8'))
const support = join(root, 'probe-support')
app.setPath('userData', join(root, 'user-data'))
app.setName('Harness update qualification')
const report = async (path, options) => {
  const response = await fetch(url + path, options)
  if (!response.ok) throw new Error('Qualification HTTP ' + response.status)
  return response.text()
}
app.whenReady().then(async () => {
  app.dock.hide()
  if (app.getVersion() === '0.0.2') {
    await report('restarted?pid=' + process.pid)
    app.exit(0)
    return
  }
  const load = createRequire(join(support, 'update-coordinator.js'))
  load('electron-updater').autoUpdater.updateConfigPath = feedPath
  const { DesktopUpdateCoordinator } = await import(pathToFileURL(join(support, 'update-coordinator.js')).href)
  const { communityUpdateClient } = await import(pathToFileURL(join(support, 'community-updates.js')).href)
  const updates = new DesktopUpdateCoordinator(state => {
    console.log(JSON.stringify(state))
    if (state.phase === 'error') void report('failure', { method: 'POST', body: JSON.stringify(state) }).then(() => app.exit(1))
  }, async () => true)
  const state = await communityUpdateClient(updates).check(true)
  if (state.phase !== 'ready') throw new Error('Expected downloaded update, got ' + JSON.stringify(state))
  if (await report('ready') !== 'restart-approved') throw new Error('No restart approval')
  await updates.install(state.version)
}).catch(async error => {
  console.error(error)
  try { await report('failure', { method: 'POST', body: String(error.stack || error) }) }
  finally { app.exit(1) }
})
`

async function prepareFixtures() {
  const staging = await mkdtemp(join(process.env.RUNNER_TEMP, 'harness-sign-update-'))
  try {
    const support = join(fixtures, 'probe-support')
    await mkdir(support, { recursive: true })
    for (const name of ['update-coordinator.js', 'update-error.js', 'update-http-executor.js', 'community-updates.js']) {
      await cp(resolve('apps/desktop/lib/types', name), join(support, name))
    }
    // Use the product's exact Electron executables and nested signatures without its runtime payload.
    for (const [role, version] of [['installed', '0.0.1'], ['candidate', '0.0.2']]) {
      const path = join(staging, role, appName)
      const resources = join(path, 'Contents', 'Resources')
      await mkdir(join(resources, 'app'), { recursive: true })
      for (const name of ['MacOS', 'Frameworks', 'Info.plist']) {
        await cp(join(source, 'Contents', name), join(path, 'Contents', name), { recursive: true, verbatimSymlinks: true })
      }
      plist(path, `Set :CFBundleIdentifier ${COMMUNITY_APP_ID}`)
      plist(path, `Set :CFBundleVersion ${version}`)
      plist(path, `Set :CFBundleShortVersionString ${version}`)
      // The signed fixture starts a small unpacked entry point and uses a loopback feed.
      const fields = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', bundle(path)], { encoding: 'utf8' }))
      if (fields.ElectronAsarIntegrity) plist(path, 'Delete :ElectronAsarIntegrity')
      if (fields.NSAppTransportSecurity) plist(path, 'Delete :NSAppTransportSecurity')
      plist(path, 'Add :NSAppTransportSecurity dict')
      plist(path, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true')
      await writeFile(join(resources, 'app', 'package.json'), JSON.stringify({ name: 'harness-update-qualification', version, main: 'main.cjs' }))
      await writeFile(join(resources, 'app', 'main.cjs'), probe)
      await cp(join(source, 'Contents', 'Resources', 'app-update.yml'), join(resources, 'app-update.yml'))
      signCommunityApp(path)
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path, join(fixtures, `${role}.zip`)], { stdio: 'inherit' })
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[2] === 'prepare') {
  await prepareFixtures()
  process.exit(0)
}
if (process.argv[2] !== 'verify') throw new Error('Expected prepare or verify')

const untrusted = spawnSync('/usr/bin/security', ['verify-cert', '-c', 'intel-build/signing-cert.pem', '-p', 'codeSign', '-L'], { timeout: 30_000 })
if (untrusted.error) throw untrusted.error
assert.ok(untrusted.status > 0, 'Qualification must run without trusting the personal certificate')
const workingDirectory = resolve('apps/desktop/.desktop-build')
await mkdir(workingDirectory, { recursive: true })
const root = await mkdtemp(join(workingDirectory, 'harness-update-'))
const installed = join(root, 'installed', appName)
const zip = join(fixtures, 'candidate.zip')
let child
let childClosed
let restartedPid
let readyObserved = false
let deadline
let finish
let fail
const finished = new Promise((resolvePromise, reject) => { finish = resolvePromise; fail = reject })
// The deadline may reject while setup still owns the event loop.
void finished.catch(() => {})
const server = createServer((request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/nightly-mac.yml') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ version: '0.0.2', files: [{ url: 'update.zip', sha512: zipHash, size: zipSize }],
        path: 'update.zip', sha512: zipHash, releaseDate: new Date().toISOString() }))
    } else if (pathname === '/update.zip') {
      response.setHeader('Content-Type', 'application/zip')
      response.setHeader('Content-Length', zipSize)
      createReadStream(zip).on('error', fail).pipe(response)
    } else if (pathname === '/ready') {
      assert.equal(plist(installed, 'Print :CFBundleShortVersionString'), '0.0.1', 'Download must not replace the app before approval')
      readyObserved = true
      response.end('restart-approved')
    } else if (pathname === '/restarted') {
      assert.ok(readyObserved, 'Restart must follow the explicit installation step')
      restartedPid = Number(new URL(request.url, 'http://localhost').searchParams.get('pid'))
      assert.ok(Number.isInteger(restartedPid) && restartedPid > 1)
      assert.equal(plist(installed, 'Print :CFBundleShortVersionString'), '0.0.2')
      response.end('verified')
      finish()
    } else if (pathname === '/failure') {
      let message = ''
      request.on('data', data => { message += data })
      request.on('end', () => { response.end('recorded'); fail(new Error(message)) })
    } else { response.statusCode = 404; response.end() }
  } catch (error) { response.statusCode = 500; response.end('qualification failed'); fail(error) }
})
let zipHash
let zipSize
try {
  await cp(join(fixtures, 'probe-support'), join(root, 'probe-support'), { recursive: true })
  await mkdir(join(root, 'installed'))
  await mkdir(join(root, 'user-data'))
  execFileSync('/usr/bin/ditto', ['-x', '-k', join(fixtures, 'installed.zip'), join(root, 'installed')], { stdio: 'inherit' })
  const bytes = await readFile(zip)
  zipHash = createHash('sha512').update(bytes).digest('base64')
  zipSize = bytes.length
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
  const address = server.address()
  await writeFile(join(root, 'loopback-feed.json'), JSON.stringify({ provider: 'generic', url: `http://127.0.0.1:${address.port}/`,
    channel: 'nightly', updaterCacheDirName: `harness-qualification-${process.pid}` }))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^HARNESS_SIGNING|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
  child = spawn(join(installed, 'Contents', 'MacOS', 'DeepSeek Harness'), [], { env: environment, stdio: 'inherit' })
  childClosed = new Promise(resolvePromise => child.once('close', (code, signal) => {
    if (code !== 0 || signal) fail(new Error(`Qualification app exited: code=${code}, signal=${signal}`))
    resolvePromise()
  }))
  child.once('error', fail)
  deadline = setTimeout(() => fail(new Error('Native update did not finish within 180 seconds')), 180_000)
  await finished
  await childClosed
  // The relaunched process is owned by ShipIt; observe its exit before removing its bundle.
  for (let attempt = 0; ; attempt++) {
    try { process.kill(restartedPid, 0) } catch (error) { if (error.code === 'ESRCH') { restartedPid = undefined; break }; throw error }
    if (attempt >= 100) throw new Error('Relaunched qualification app did not exit')
    await delay(100)
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], { stdio: 'inherit' })
  const report = { platform: process.platform, arch: process.arch, from: '0.0.1', to: '0.0.2',
    automaticDownload: true, explicitRestart: true, signedNativeReplacement: true, certificateInstalledInTrustStore: false }
  await writeFile(join(process.env.RUNNER_TEMP, 'native-update-test.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('PASS: automatic download, explicit restart, signed native replacement, and new-version launch')
} finally {
  clearTimeout(deadline)
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childClosed }
  if (restartedPid) { try { process.kill(restartedPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  server.closeAllConnections()
  await new Promise(resolvePromise => server.close(resolvePromise))
  await rm(root, { recursive: true, force: true })
}
