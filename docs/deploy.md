# 部署说明

本文件说明如何在企业自己的服务器上运行。当前仓库没有公网预览，也没有注册飞书应用。

## 运行环境

- Node.js 22.x。数据层使用内置 `node:sqlite`，仍标记为 experimental，启动脚本已经加上 `--experimental-sqlite`。
- 持久文件默认是 `data/<APP_ENV>.db`。请把该目录放在备份盘上。
- 不需要付费数据库或地图服务。没有地图配置时，产品不会假装具备导航。

## 进程

```bash
npm ci
npm run check
npm run build
APP_ENV=production NODE_ENV=production SESSION_SECRET="$(openssl rand -base64 32)" npm start
```

`npm run check` 依次执行 lint、类型检查和测试。仓库里的 `.github/workflows/check.yml` 在 push 和 pull request 时跑同一条命令，Node 版本是 22。这个仓库托管在 Origin，GitHub 不会直接收到推送；工作流文件给 Origin 上兼容 GitHub Actions 的检查使用。没有另行开通付费 CI 应用。

`npm start` 监听 `0.0.0.0:43123`。前面用企业的 HTTPS 反向代理，并把 `/api/feishu/events` 原样转到 Node。代理不要改写请求体，否则飞书签名会失败。

## 必须放在服务器环境里的值

复制 `.env.example`。真实密钥只出现在服务器环境或机密管理系统，不进入仓库、前端、日志和导出。

- `SESSION_SECRET`：至少 24 位，生产不能用示例占位。
- `PUBLIC_BASE_URL`：对外的 https 源，用于登录完成后的跳转。
- 飞书项见 [feishu-setup.md](feishu-setup.md)。留空时集成页显示未配置，真实请求被拒绝。

## 模式隔离

- `demo`、`sandbox`、`production` 使用不同的数据库文件。
- 演示身份切换只在 `APP_ENV=demo` 存在。`NODE_ENV=production` 且 `APP_ENV=demo` 时进程拒绝启动。
- 真实飞书调用失败不会写入演示通过。

## 备份与升级

备份对应的 SQLite 文件即可保留申请、快照、回调收件箱和结算审计。不要为了“重试审批”删除 `approval_outbox` 里的 uuid。

## 健康检查

管理员打开“集成设置”。未完成企业联调前，状态应保持“未配置”或“已填写 · 待联调”，而不是“已接通”。页面不提供密钥输入框。
