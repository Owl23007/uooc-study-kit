# 发布流程

每次发布均按以下步骤执行，源码维护在 `main`，稳定构建产物维护在 `release` 分支根目录，预发布构建产物维护在 `dev` 分支根目录

1. 更新 `package.json` 中的版本号，正式发布使用稳定 SemVer 格式 `x.y.z`，预发布使用 `x.y.z-dev` 或 `x.y.z-dev.1` 等格式，不使用构建标识 `+build`
2. 在 `CHANGELOG.md` 中记录本次变更、修复和兼容性说明
3. 执行 `pnpm install --frozen-lockfile` 和 `pnpm check`
4. 提交本次源码与文档变更，推送到 `main`
5. 为该提交创建与版本一致的 `v<版本号>` 标签并推送到远端，例如版本为 `0.1.1` 时执行 `git tag v0.1.1` 和 `git push origin v0.1.1`
6. GitHub Actions 会执行“发布用户脚本”工作流，确认测试、构建、GitHub Release 上传和对应更新分支同步全部成功；预发布会标记为 Pre-release
7. 检查 GitHub Release 附件、固定 Raw 地址的两个文件及其 `@version`，确认均为本次版本，再验证 Tampermonkey 更新

每次发布生成以下两个文件，并同时上传到 GitHub Release 和对应更新分支：

- `uooc-study-plugin.user.js`：可读、未压缩、未混淆的独立用户脚本
- `uooc-study-plugin.meta.js`：供 Tampermonkey 检查更新的元数据

当前 `0.1.0-dev` 使用开发版固定地址：

- 安装：`https://raw.githubusercontent.com/Owl23007/uooc-study-kit/dev/uooc-study-plugin.user.js`
- 更新：`https://raw.githubusercontent.com/Owl23007/uooc-study-kit/dev/uooc-study-plugin.meta.js`

稳定版固定地址：

- 安装：`https://raw.githubusercontent.com/Owl23007/uooc-study-kit/release/uooc-study-plugin.user.js`
- 更新：`https://raw.githubusercontent.com/Owl23007/uooc-study-kit/release/uooc-study-plugin.meta.js`

两个通道独立更新，不互相覆盖。工作流按 SemVer 检查版本顺序，拒绝旧标签覆盖较新版本；相同版本可以重试失败的工作流。切换通道时重新安装对应地址的脚本，用户配置仍保留在 GM 存储中
