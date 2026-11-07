/** Qualify the pinned signing identity through a real two-version Squirrel.Mac installation. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { COMMUNITY_APP_ID, signCommunityApp } from '../apps/desktop/scripts/community-package.mjs'

if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('Qualification requires native Intel macOS')
const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'harness-update-'))
const source = resolve('apps/desktop/.desktop-build/targets/mac-x64/unsigned-artifacts/mac/DeepSeek Harness.app')
const installed = join(root, 'installed', 'DeepSeek Harness.app')
const candidate = join(root, 'candidate', 'DeepSeek Harness.app')
const zip = join(root, 'update.zip')
const bundle = path => join(path, 'Contents', 'Info.plist')
const plist = (path, command) => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, bundle(path)], { encoding: 'utf8' }).trim()
const coordinator = pathToFileURL(resolve('apps/desktop/lib/types/update-coordinator.js')).href
const communityClient = pathToFileURL(resolve('apps/desktop/lib/types/community-updates.js')).href
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
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
  const address = server.address()
  const feed = `http://127.0.0.1:${address.port}/`
  const probe = `
const { app } = require('electron')
app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
app.setName('Harness update qualification')
const report = async (path, options) => {
  const response = await fetch(${JSON.stringify(feed)} + path, options)
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
  const { DesktopUpdateCoordinator } = await import(${JSON.stringify(coordinator)})
  const { communityUpdateClient } = await import(${JSON.stringify(communityClient)})
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
  // Retain the exact Electron executables and nested signatures from the product; omit its large runtime payload.
  for (const [path, version] of [[installed, '0.0.1'], [candidate, '0.0.2']]) {
    await mkdir(join(path, 'Contents', 'Resources', 'app'), { recursive: true })
    for (const name of ['MacOS', 'Frameworks', 'Info.plist']) {
      await cp(join(source, 'Contents', name), join(path, 'Contents', name), { recursive: true, verbatimSymlinks: true })
    }
    plist(path, `Set :CFBundleIdentifier ${COMMUNITY_APP_ID}`)
    plist(path, `Set :CFBundleVersion ${version}`)
    plist(path, `Set :CFBundleShortVersionString ${version}`)
    // A probe uses an unpacked entry point; its signed resources do not contain the product ASAR.
    const info = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', bundle(path)], { encoding: 'utf8' })
    const fields = JSON.parse(info)
    if (fields.ElectronAsarIntegrity) plist(path, 'Delete :ElectronAsarIntegrity')
    if (fields.NSAppTransportSecurity) plist(path, 'Delete :NSAppTransportSecurity')
    plist(path, 'Add :NSAppTransportSecurity dict')
    plist(path, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true')
    await writeFile(join(path, 'Contents', 'Resources', 'app', 'package.json'), JSON.stringify({ name: 'harness-update-qualification', version, main: 'main.cjs' }))
    await writeFile(join(path, 'Contents', 'Resources', 'app', 'main.cjs'), probe)
    await writeFile(join(path, 'Contents', 'Resources', 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feed, channel: 'nightly', updaterCacheDirName: `harness-qualification-${process.pid}` }))
    signCommunityApp(path)
  }
  execFileSync('/usr/bin/security', ['remove-trusted-cert', process.env.HARNESS_SIGNING_CERTIFICATE], { stdio: 'inherit' })
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', candidate, zip], { stdio: 'inherit' })
  const bytes = await readFile(zip)
  zipHash = createHash('sha512').update(bytes).digest('base64')
  zipSize = bytes.length
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
    try { process.kill(restartedPid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
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
