import assert from 'node:assert/strict'
import { test } from 'node:test'
import { communityUpdateClient } from './overlay/apps/desktop/src/community-updates.ts'

test('available updates download the checked version and return the restart-ready state', async () => {
  let downloaded
  let manual
  const ready = { phase: 'ready', version: '0.2.2-rc.1' }
  const client = communityUpdateClient({
    state: ready,
    async check(value) { manual = value; return { phase: 'available', version: ready.version } },
    async download(version) { downloaded = version; return ready },
  })
  assert.equal(await client.check(true), ready)
  assert.equal(client.state, ready)
  assert.equal(downloaded, ready.version)
  assert.equal(manual, true)
})

test('idle, in-progress and failed downloads are not automatically restarted', async () => {
  for (const state of [{ phase: 'idle' }, { phase: 'downloading', version: '1.0.0', percent: 10 },
    { phase: 'error', failedOperation: 'download', message: 'offline' }]) {
    const client = communityUpdateClient({ state, async check() { return state },
      async download() { assert.fail('Unexpected transfer') } })
    assert.equal(await client.check(), state)
  }
})

test('transfer failures remain visible and installation is never requested', async () => {
  const failure = { phase: 'error', failedOperation: 'download', message: 'checksum mismatch' }
  const client = communityUpdateClient({ state: failure,
    async check() { return { phase: 'available', version: '1.0.0' } },
    async download() { return failure },
    install() { assert.fail('Automatic restart is forbidden') },
  })
  assert.equal(await client.check(), failure)
})
