# 安装与使用

要求：运行插件的 DSH 后端具备 Node.js 24+ 和 OpenSSH。

SSH 在承载插件的 DSH 后端上执行，读取该用户的 SSH config、密钥和 known_hosts，不一定是浏览器所在电脑的配置。

请先在该后端的终端中通过 SSH 连通目标，完成主机指纹确认。插件支持密钥与 SSH Agent，暂不支持交互式密码登录；不要关闭主机密钥检查。

## 安装

下载及安装使用 GitHub Release 提供的预构建包，无需自行构建源码。

在运行主 DSH 后端的终端中执行：

```bash
dsh plugin --profile web add -w https://github.com/Wazzfhaha/dsh-multi-end/releases/download/v0.0.13/dsh-ssh-workspaces-0.0.13.tgz
```

如使用其他 profile，请将 `web` 替换为实际名称。安装后重启对应 DSH 后端。

0.0.13 适配基线为 WSL/Linux DSH 0.1.7-rc.1。Windows/macOS 后端尚未完成实机验证。

曾通过手动配置或本地链接安装本插件的用户，应先检查旧配置，避免重复注册。本项目尚未发布到 npm，请勿直接执行 `npm install dsh-ssh-workspaces`。

## 从旧的源码链接或手动注册迁移

1. 等待主后端任务结束，再停止主后端。
2. 保留主机配置文件，备份当前 profile 的 `package.json`、锁文件和 `cordis.patch.yml`。
3. 执行上面的安装命令，将同名依赖替换为 Release 安装包。
4. 官方安装流程会把 `dsh-ssh-workspaces` 登记到 `package.json` 的 `dsh.profile.bundles`。若它已存在，移除 `cordis.patch.yml` 中旧的、仅包含 `id: ssh-workspaces` / `name: dsh-ssh-workspaces` 的手动 insert 条目，避免重复注册；不要移除其他插件的配置。
5. 重启主后端并刷新客户端，确认插件只加载一次。升级后手动成功连接一次，之后才会记住自动恢复意愿。

## 使用

1. 设置 → DSH 多端管理，手动添加主机或从 SSH config 选择导入。
2. 点连接。自动读取登录信息仅适用于满足探测条件的 Linux；其他平台可以提供 DSH 启动时的 loopback HTTP 登录链接。
3. 连接后，原生侧栏显示 `[本机]` 和 `[主机名称]` 工作区。设置仍属于主后端。
4. 在多端管理的已连接主机行点“添加工作区”，默认加载远端主目录。输入 `/srv/` 等绝对路径自动显示目录候选，点击文件夹或按回车进入；也可用底部“新建文件夹”创建子目录，最后点“添加到侧栏”。原生侧栏的“+”按钮仍用于主后端。
5. 在对应工作区中创建、打开会话。运行地点由工作区所属后端决定。
6. 断线会有限次重试；也可以手动重连。失败消息不会自动重发。通过 SSH 自动读取登录信息并成功连接过的主机会在主后端重启后恢复；手动断开会取消恢复。手动登录链接不保存，重启后需重新提供。

主机配置位于 `$DSH_HOME/plugins/dsh-ssh-workspaces/hosts.json`；未设置 DSH_HOME 时使用 `~/.dsh`。不要把它加入公开仓库。登录链接、cookie 保留在进程内存，不写入主机配置。

请先阅读 [兼容性与限制](compatibility.md)，尤其是审批、第三方卡片、远端版本和跨平台验证范围。
