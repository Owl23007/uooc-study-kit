# UOOC Study Kit

[![build](https://github.com/Owl23007/uooc-study-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Owl23007/uooc-study-kit/actions/workflows/ci.yml) [![version](https://img.shields.io/badge/version-0.1.0-blue)](CHANGELOG.md) [![许可证 MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-blue)](https://www.tampermonkey.net/)

> [!IMPORTANT]
> 本项目仅供学习、技术研究与交流，属于非官方辅助工具，与 UOOC 官方无关联，使用前请阅读下方使用声明

> [!WARNING]
> 使用声明与免责声明
>
> - 本项目仅供**个人学习、技术研究与交流**，请遵守平台规则、所在学校的学习与考试要求以及适用法律法规
> - 不得将本项目用于作弊、代学代考、伪造学习记录、绕过监考或访问控制，以及其他违规用途
> - AI 生成的答案和解析仅供参考，不保证正确性、完整性或适用性，使用者应独立判断并人工核验
> - 使用者自行选择 API 服务商并保管 API Key，自行承担第三方服务费用及相关数据处理风险
> - 本项目按 MIT 许可证以“原样”提供，不对功能可用性、平台兼容性、学习效果或成绩作任何保证
> - 使用者自行承担使用或无法使用本项目的风险；在适用法律允许的范围内，作者及贡献者不对由此产生的账号限制、学习记录或成绩异常、数据损失、第三方费用及其他损失承担责任

面向 UOOC（优课联盟）的非官方 Tampermonkey 学习辅助工具

- 旧版和新版视频课程自动导航跳转连播、倍速、静音
- 配置 API Key 来实现的课中小测、完成练习并重试错题的功能

## 安装与更新

1. 安装 [Tampermonkey BETA](https://chromewebstore.google.com/detail/tampermonkey-beta/gcalenpjmijncebpfijmoaglllgpjagf) 或者访问 [Tampermonkey 官网](https://www.tampermonkey.net/) 安装 Tampermonkey BETA 版，并允许安装来自 GitHub 的用户脚本。

2. 打开 [正式版安装地址](https://raw.githubusercontent.com/Owl23007/uooc-study-kit/release/uooc-study-plugin.user.js)，确认安装。

## 本地开发

要求 Node.js 22.12+ 和 pnpm 11.8.0，建议使用 Node.js 24

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm check
```

开发版通过 [开发版安装地址](https://raw.githubusercontent.com/Owl23007/uooc-study-kit/dev/uooc-study-plugin.user.js) 获取远端最新，本地构建产物在 `dist/uooc-study-plugin.user.js`，可直接在 Tampermonkey 中安装或更新。

在测试完毕后，需要通过创建 pr 来将本地变更合并到 `main`，并在 `CHANGELOG.md` 中记录本次变更、修复和兼容性说明。

在之后的发布流程中，会生成正式版构建产物并上传到 GitHub Release 和对应更新分支。

## 发布

参见 [发布流程](docs/releasing.md)

预发布版本发布为 Pre-release 并同步 `dev` 分支，稳定版本同步 `release` 分支。

## 隐私与权限

- API Key 只写入 Tampermonkey 的 GM 存储，不上传到 GitHub，也不在本地文件中保存

- 题干、选项及错题评分反馈只会在用户发起答题操作时发送至配置的 API 服务商

用户可以配置任意服务商，元数据保留 `@connect *`，同时列出常用和本地地址。请仅授权自己使用的 API 域名；若只使用固定服务商，可在脚本设置中收窄允许域名。
Tampermonkey 的域名授权和更新元数据行为见[官方文档](https://www.tampermonkey.net/documentation.php?q=connect)。
