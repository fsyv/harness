/** Community feed configuration and stable self-signing for the Intel desktop package. */
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeMacOSAppUpdateConfig, verifyMacOSAppUpdateConfig } from './macos-app-update-config.mjs'

export const COMMUNITY_APP_ID = 'io.github.fsyv.harness'
export const COMMUNITY_FEED = 'https://github.com/fsyv/harness/releases/download/intel-updates/'

/** Sign one assembled bundle with the pinned certificate, preserving Electron entitlements. */
export function signCommunityApp(appPath, environment = process.env) {
  const keychain = environment.HARNESS_SIGNING_KEYCHAIN
  const certificatePath = environment.HARNESS_SIGNING_CERTIFICATE
  if (!keychain || !certificatePath) throw new Error('Community signing keychain and public certificate are required')
  const certificate = new X509Certificate(readFileSync(certificatePath))
  const fingerprint = certificate.fingerprint.replaceAll(':', '')
  const requirement = `designated => identifier "${COMMUNITY_APP_ID}" and certificate leaf = H"${fingerprint}"`
  execFileSync('/usr/bin/codesign', ['--force', '--sign', fingerprint, '--keychain', keychain,
    '--timestamp=none', '--preserve-metadata=identifier,entitlements,flags,runtime',
    '--requirements', '=' + requirement, appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2',
    '-R', `=identifier "${COMMUNITY_APP_ID}" and certificate leaf = H"${fingerprint}"`, appPath], { stdio: 'inherit' })
}

/** Configure the community package after upstream has resolved its local build defaults. */
export function communityPackageConfig(config, environment = process.env) {
  if (environment.HARNESS_COMMUNITY_BUILD !== '1') return config
  if (environment.DSH_DESKTOP_UNSIGNED !== '1' || environment.DSH_DESKTOP_TARGET_ARCH !== 'x64'
    || environment.DSH_DESKTOP_TARGET_PLATFORM !== 'darwin') {
    throw new Error('The community package requires the local macOS x64 packaging path')
  }
  const feed = { publicUrl: COMMUNITY_FEED, channel: 'nightly' }
  const afterPack = config.afterPack
  const afterSign = config.afterSign
  return {
    ...config,
    appId: COMMUNITY_APP_ID,
    extraMetadata: { ...config.extraMetadata, dshDesktopAppId: COMMUNITY_APP_ID, dshDesktopUpdateChannel: 'nightly' },
    artifactName: 'deepseek-harness-${version}-mac-${arch}-self-signed.${ext}',
    mac: { ...config.mac, identity: '-', forceCodeSigning: false, notarize: false, target: ['dmg', 'zip'] },
    publish: [{ provider: 'generic', url: COMMUNITY_FEED, channel: 'nightly' }],
    async afterPack(context) {
      await afterPack(context)
      await writeMacOSAppUpdateConfig(context.packager.getResourcesDir(context.appOutDir), feed, 'fsyv-harness-intel-updater')
    },
    async afterSign(context) {
      await afterSign(context)
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      await verifyMacOSAppUpdateConfig(appPath, feed, 'fsyv-harness-intel-updater')
      signCommunityApp(appPath, environment)
    },
  }
}
