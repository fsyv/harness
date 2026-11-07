# 个人 Intel macOS 构建

[English](README.md) | 中文

此 fork 的 `intel` 默认分支由每月同步任务维护，面向 macOS 15 Intel。安装包使用固定的个人自签证书，没有 Apple 公证。

## 安装与自动更新

首次从 [Releases](https://github.com/fsyv/harness/releases) 中名为 **Intel macOS …** 的版本下载 `.dmg`，将 App 拖到自己的 `~/Applications`（可手动创建），或当前账户可写的 `/Applications`。首次打开如被系统阻止，请在“系统设置 → 隐私与安全”允许打开。不要直接在 DMG 中运行。

App 启动后以及运行期间会检查本仓库的更新源，发现新版自动下载。下载完成后使用现有的“重启更新”入口安装；不会擅自重启。重启仍经过上游的活动任务确认和退出处理。检查周期沿用上游默认约 10 分钟，带随机偏移；网络失败会退避重试，下载失败可在更新界面手动重试。

`intel-updates` Release 只存储更新索引，安装包位于不可覆盖的版本 Release。每个版本包含 DMG、更新 ZIP、`nightly-mac.yml`、`SHA256SUMS`、构建信息和原生升级测试记录。

## 自动构建

[Intel macOS release](https://github.com/fsyv/harness/actions/workflows/intel-release.yml) 每月 1 日北京时间 10:17 运行，也可手动 Run workflow。时间可能因 GitHub 调度延迟而后移。

- `tag` 留空：按 SemVer 选择上游最高的 `dsh-v*` 标签，包含 RC 等预发布版。
- `tag` 填具体标签：构建该版本。低于已发布版本时不会回退更新源。
- `force`：同一上游版本强制重建，分配新的构建版本号。
- 相同上游 commit、相同构建配方且已成功发布时跳过打包；每月仍提交检查记录，保持同步活动。
- 上游标签、补丁整合点、打包、签名或原生升级测试不通过时停止发布，保留已有更新源。

流水线在 `macos-15-intel` 上构建，签名后运行上游运行时检查。全新的 Intel runner 确认证书未受信任，再使用相同 Electron 二进制、更新协调器和签名身份完成两版测试 App 的下载、显式重启、原生替换和新版启动。测试成功后发布。请在实际笔记本上完成首次安装与功能检查。

构建版本扩展上游版本，例如 `0.2.2-rc.1.20261107.1.1`。稳定版按照上游打包规则使用 `-test.<日期>.<运行号>.<尝试号>` 后缀。所有自用构建标为 prerelease。

## 维护

`intel-build/overlay/` 是自用补丁的维护源，`apply.py` 将它应用到所选上游标签。需要改更新逻辑或签名逻辑时，修改 overlay 后同步到 `apps/desktop/`；仅改生成后的副本会在下次同步时被覆盖。同步保留 `intel-build/` 和本分支工作流，源码其余部分按上游标签更新，因此日常功能开发请另建分支。

`master` 保留原来的上游分支。fork 仅启用个人 Intel 工作流，上游专用的 CI/发布工作流在 GitHub 设置中停用。定时任务依赖 `intel` 保持默认分支且 Actions 启用；若 GitHub 停用了定时任务，可在 Actions 中重新启用。

仓库 Secrets 中的 `MACOS_SIGNING_P12_BASE64` 和 `MACOS_SIGNING_PASSWORD` 必须持续复用；公钥证书在 `signing-cert.pem`。不要删除或重生成现有证书：已安装版本只接受同一证书签名的更新。证书到期或丢失私钥后需要手动重新安装新身份的版本。私钥和密码不进入源码、Release 或日志。

本分支由自动同步推进。手动提交前先拉取最新 `intel`；若同步检测到分支已变化会退出，重新运行即可。打包 job 只有读取仓库的权限，发布 job 才拥有 Release 写权限。
