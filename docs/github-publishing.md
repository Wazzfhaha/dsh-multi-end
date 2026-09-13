# 手动上传 GitHub

插件使用独立仓库，建议仓库名 `dsh-multi-end`，显示名“DSH 多端管理”。不用 Fork DSH 才能发布插件。当前适合发布为实验性源码项目，不应宣传全功能或全平台已验证。

## 1. 准备发布目录

在插件开发目录运行 `node scripts/export-source.mjs`。脚本只复制明确列出的源码、可移植单元测试、构建脚本和公开文档；不会复制 `.runtime` 里的日志、截图、备份、凭证、本机验收脚本，也不会创建 Git 仓库或上传。已有同名导出目录时会停止，避免覆盖你已开始的 Git 工作。

先查看导出目录的 README、兼容性说明及 LICENSE。许可证草案使用 MIT；发布前确认你接受该许可。此许可只覆盖本插件自己的代码，不替代 DSH 或依赖项的许可证。

## 2. 在 GitHub 建空仓库

登录 GitHub，选择 New repository，填写 `dsh-multi-end`。可以先选 Private，整理好后再设为 Public。不要勾选自动创建 README、LICENSE 或 .gitignore，因为导出目录已经包含这些文件。

## 3. 由你在导出目录执行

PowerShell 中先 `Set-Location -LiteralPath '导出目录的完整路径'`，确认 `Get-ChildItem` 显示的是插件 README、src、tests，而不是整个 Desktop 客户端。

```powershell
git init
git add .
git diff --cached --stat
git diff --cached
git commit -m "Initial experimental DSH multi-end plugin"
git branch -M main
git remote add origin https://github.com/你的用户名/dsh-multi-end.git
git push -u origin main
```

在 commit 之前检查暂存内容。Git 登录使用 GitHub 的认证流程，不要把密码或 token 写入脚本、README 或 remote URL。这里没有要求你 Fork DSH，也没有把插件代码混入 DSH 主仓库。

## 4. 发布与后续开发

首次可以先只公开源码。需要供人下载安装时，再在 GitHub Releases 创建预发布，标明准确测试过的 DSH 版本、当前限制和验收方式。`npm pack --dry-run` 可检查 npm 包内容；创建 GitHub 仓库并不等于已经发布到 npm 或 DSH 插件市场。

第一次上传后，把这个独立 Git 仓库作为后续开发源。让本机 DSH 的开发安装指向它，再继续改；不要长期同时维护一份导出目录和一份旧源目录。切换开发路径属于后续单独操作，本轮没有自动更改链接。

## 5. 跟踪 DSH 更新

在上游仓库的 Watch 中选择 Custom → Releases，订阅新版本。Fork 的作用是保存你自己的 DSH 源码副本，方便实验或向上游提 PR；它不负责自动修复插件，也不保证自动同步。

收到 DSH 更新通知后：记录版本 → 在隔离环境安装 → 检查 `typertGateway`、客户端插件依赖和远程协议 → 运行插件测试与真实 UI 验收 → 更新兼容表 → 发布插件版本。主力后端有任务时不要为了验收而重启。

参考：[GitHub 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-subscriptions-for-activity-on-github/viewing-your-subscriptions)、[Fork 工作流](https://docs.github.com/en/pull-requests/how-tos/work-with-forks)。
