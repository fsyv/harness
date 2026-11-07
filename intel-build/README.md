# Personal Intel macOS builds

English | [中文](README.zh.md)

This fork's default `intel` branch is maintained by the monthly sync workflow and targets macOS 15 Intel. Packages use a fixed personal signing certificate and are not notarized by Apple.

## Installation and automatic updates

For the first installation, download the `.dmg` from a version named **Intel macOS …** in [Releases](https://github.com/fsyv/harness/releases). Drag the App into your own `~/Applications` directory (create it if needed), or an `/Applications` directory writable by your account. If macOS blocks the first launch, allow it in System Settings → Privacy & Security. Do not run directly from the DMG.

At startup and while running, the App checks this repository's update feed and downloads new versions automatically. Use the existing restart-to-update action after the download finishes; the App never restarts without your approval. Restart still uses upstream's active-task confirmation and shutdown handling. Checks retain the upstream default of roughly 10 minutes with jitter; network failures back off, and failed downloads can be retried manually in the update interface.

The `intel-updates` Release stores only update metadata; installers belong to immutable versioned Releases. Each version contains a DMG, update ZIP, `nightly-mac.yml`, `SHA256SUMS`, build information, and a native upgrade test report.

## Automated builds

[Intel macOS release](https://github.com/fsyv/harness/actions/workflows/intel-release.yml) runs on the first day of each month at 10:17 Asia/Shanghai and supports manual Run workflow. GitHub scheduling delays can move the actual start later.

- Leave `tag` empty to select the highest upstream `dsh-v*` version using SemVer, including RC and other prereleases.
- Set `tag` to build a particular upstream tag. An older build never moves the update feed backwards.
- Set `force` to rebuild the same upstream version with a new build version.
- Skip packaging when the upstream commit and recipe match a successful published release; still commit the monthly check record to maintain sync activity.
- Stop publication if the upstream tag, patch integration points, packaging, signing, or native update test fails; retain the previous update feed.

The workflow builds on `macos-15-intel`, runs upstream runtime checks after signing, and uses the same Electron binaries, update coordinator, and signing identity to download, explicitly restart, replace, and launch two versions of a test App. It removes the build machine's certificate trust settings before that test to cover users who have not installed the certificate. Publication follows successful qualification. This does not replace first-installation and functional checks on the actual laptop.

Build versions extend the upstream version, for example `0.2.2-rc.1.20261107.1.1`. Stable versions follow upstream's packaging rules with a `-test.<date>.<run>.<attempt>` suffix. All personal builds are marked as prereleases.

## Maintenance

`intel-build/overlay/` owns the maintained personal patches, and `apply.py` applies them to the selected upstream tag. To change updates or signing, edit the overlay and copy it into `apps/desktop/`; edits made only to generated copies disappear on the next sync. Sync preserves `intel-build/` and this branch's workflows, replacing the rest of the source with the upstream tag, so use a separate branch for other feature development.

`master` retains the original upstream branch. Only the personal Intel workflow is enabled in this fork; upstream's dedicated CI and release workflows are disabled in GitHub settings. Scheduling requires `intel` to remain the default branch and Actions to stay enabled. Re-enable the workflow in Actions if GitHub disables its schedule.

The repository Secrets `MACOS_SIGNING_P12_BASE64` and `MACOS_SIGNING_PASSWORD` must be reused; `signing-cert.pem` contains the public certificate. Do not delete or regenerate the existing identity: installed versions accept updates only from the same certificate. Certificate expiry or private-key loss requires manual installation of a release using the new identity. Private keys and passwords never enter source, Releases, or logs.

Automatic sync advances this branch. Pull the latest `intel` before committing manually; if sync detects a moved branch, it exits and can be rerun. The packaging job has only repository read access; the publishing job has Release write access.
