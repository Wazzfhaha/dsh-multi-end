# 使用同一个仓库开发和上传

这个仓库同时是插件的开发源和 GitHub 源码。固定使用一个目录；0.0.7、0.0.8 等版本只更新代码和 package.json，不创建新的版本目录，也不重复 git init。

## 日常更新

先在仓库目录修改代码，使用 Node.js 24+ 构建并验证：

```powershell
npm run build
npm test
git status
git add .
git diff --cached --stat
git diff --cached
git commit -m "描述这次修改"
git push
```

需要新增依赖时同步提交 package-lock.json。node_modules、临时产物、登录链接、密钥和个人 DSH 配置不提交。Git Credential Manager 保存授权后，通常无需每次登录。

## 本机运行

DSH 的开发安装链接应直接指向这个仓库。不要把整个 DSH 数据目录放入 Git；主机配置和聊天记录继续由 DSH 保管。

浏览器代码修改后先构建并刷新页面。Host 代码是否热加载取决于 DSH 版本；当前验收基线需要确认没有运行任务后重载主后端。推送 GitHub 不会自动更新或重启任何后端。

另一台机器需要取得代码时，clone 这个仓库，在自己的工作目录安装依赖并按相同流程安装开发插件。用户配置仍保存在各自后端，不能通过复制整个个人 profile 来发布插件。

## 跟踪 DSH 更新

在上游仓库 Watch → Custom → Releases 中订阅版本更新。Fork 是可选的，用于研究 DSH 源码或向上游提 PR；插件继续放在自己的独立仓库中。

收到更新后，先在隔离环境检查 Host gateway、Client 插件依赖与协议，并执行真实 UI 验收。更新兼容性记录后再发布插件版本。不能把上游更新自动等同于插件兼容。

## 发布

当前是开发预览源码。需要发行时，可创建 Git 标签和 GitHub 预发布，明确已验证的 DSH 版本与未支持功能。使用 npm pack --dry-run 检查包内容。发布 GitHub 源码并不等于发布到 npm 或 DSH 插件市场。

参考：[GitHub 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-subscriptions-for-activity-on-github/viewing-your-subscriptions)、[Fork 工作流](https://docs.github.com/en/pull-requests/how-tos/work-with-forks)。
