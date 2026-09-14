# DSH 多端管理

通过已有 SSH 配置，把其他机器上的 DSH 工作区和会话接入同一个原生 DSH 界面。对话在哪里，就在哪里运行；全局设置仍使用主后端。

**0.0.6 开发预览。适配基线：DSH 0.1.5-rc.1。尚未完成跨平台实机验收与完整交互支持。**

## 安装与使用

当前提供 [v0.0.6 安装包](https://github.com/Wazzfhaha/dsh-multi-end/releases/tag/v0.0.6)，验证基线为 DSH 0.1.5-rc.1。

在运行主 DSH 后端的终端中执行：

```bash
dsh plugin --profile web add -w https://github.com/Wazzfhaha/dsh-multi-end/releases/download/v0.0.6/dsh-ssh-workspaces-0.0.6.tgz
```

如使用其他 profile，请替换 `web`。安装后重启对应后端，打开“设置 → DSH 多端管理”，手动添加 SSH 主机或从 SSH config 导入。

远端需运行 DSH，但不需要安装本插件。曾手动安装或使用本地链接安装本插件的用户，请先检查旧配置，避免重复注册。

详见 [安装说明](docs/install.md) 和 [兼容性与限制](docs/compatibility.md)。

## 已实现

- 手动添加主机、选择导入 SSH config；SSH 和 DSH 端口独立配置。
- 聚合原生工作区侧栏，标注后端来源；使用原生会话界面。
- 浏览远端已有目录、添加工作区、在所属工作区创建会话。
- 会话改名、归档与同一工作区内排序；已归档会话从管理页快捷列表隐藏。
- 显式路由对话、取消、历史、分叉、附件、消息队列及会话 skills 请求。
- 断线有限次重试、手动重连；保留未发送草稿，不自动重发失败消息。
- 连接时只读检查工作区与会话控制基础协议；这不代表已识别远端版本或验证全部操作。

## 当前限制

工具审批、用户提问和第三方交互卡片尚未转发；这些场景需要使用所属后端的界面。归档恢复没有接入。远端文件侧栏、跨机器移动、全局配置同步不在当前支持范围。Windows/macOS 远端尚未实机验证。详见 [兼容表](docs/compatibility.md)。

[安装与使用](docs/install.md) · [手动上传 GitHub](docs/github-publishing.md)

## 开发

使用 Node.js 24+：

```sh
npm ci
npm run build
npm test
```

`src/browser/` 是浏览器源文件，`src/client.js` 是生成入口。测试使用 Node 内置框架和本地模拟服务，不会连接真实 SSH 主机或发送模型请求。真实后端验收须使用独立 profile 和专用测试会话。

直接在这个固定 Git 仓库中开发、运行和提交；升级版本不更换目录，也不再导出源码副本。`node_modules/` 和 `.runtime/` 不纳入 Git。当前包保留 `private: true`，避免误发布到 npm。Linux 登录探测的补充测试可运行 `python3 -B tests/remote-probe.test.py`。

插件依赖 DSH 的运行时 gateway 适配，不修改其安装文件；它不是上游承诺稳定的多后端扩展接口。更新 DSH 后需要重新验收。

MIT 许可证仅覆盖本项目代码；DSH 和依赖项保留各自许可证。
