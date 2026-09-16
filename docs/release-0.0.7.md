# 0.0.7 发布说明草稿

## 修复

- 主后端重启后自动恢复此前成功连接的 SSH 主机；主动断开取消恢复。
- 远端会话的运行、完成与活动通知实时更新原生侧栏。
- 不重发任务、不保存带令牌的登录链接。升级后需手动成功连接一次。

## 展示

- 对外名称统一为“DSH 多端管理 · Remote SSH”，仓库及包名不变。
- 增加原生工作区与会话、主机管理、手动配置三张截图，使用演示数据。
- 补充旧源码链接/手动注册安装的迁移步骤。

## 验证与范围

58 项 Node 回归测试通过；隔离 DSH 已验证重启恢复、主动断开后不恢复、状态事件转发。WSL/Linux 主力已完成安装包替换和启动检查。验证基线为 DSH 0.1.5-rc.1；Windows/macOS 后端及 RC2 尚未实机验证。

## 市场条目更新草稿

发布 Release 并确认下载成功后，修改收录仓库的 `data/plugins/Wazzfhaha__dsh-multi-end.yml`。保留已有其他字段，更新简介和 tarball：

```yaml
url: https://github.com/Wazzfhaha/dsh-multi-end
name: Wazzfhaha/dsh-multi-end
category: remote
description:
  en: Remote SSH multi-host management for DSH. Access remote workspaces and sessions in one native sidebar, with tasks running on their original machines.
  zh: DSH 多端管理：通过 SSH 远程连接多台机器，在同一原生侧栏管理工作区与会话，任务在所属机器运行。
tarball: https://github.com/Wazzfhaha/dsh-multi-end/releases/download/v0.0.7/dsh-ssh-workspaces-0.0.7.tgz
```

截图由本仓库根目录 `screenshots.json` 声明。目录构建采集后，在市场中刷新数据。仅更改 README 标题不会更改市场卡片的仓库标题。
