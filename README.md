# 私车公用 · 里程补贴

独立的企业里程补贴测试版。它不是 WorkBuddy 站点的升级，没有原站源代码，也不迁移原站数据。

手机浏览器公开演示（静态 H5，数据只在本地浏览器，不是企业联调环境，也不会连接飞书或 OA）：<https://dannywang0822.github.io/JT-selfcar-management/?v=1>

正式链路是：行程 → 补贴申请 → 飞书审批 → 财务核对 → 确认结算。首期不自动付款。飞书是唯一会实际调用的审批提供商；OA 只有禁用的适配器，不会发单。

## 本地运行

需要 Node.js 22。SQLite 使用 Node 内置模块，启动参数里带有 `--experimental-sqlite`。

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run check` 按顺序跑 lint、类型检查和测试。推送和拉取请求也会跑同一条检查。`npm test` 本身仍然只跑测试。

开发服务监听 `43123` 端口。默认 `APP_ENV=demo`，进入首页可以选择带“示例”的演示身份。演示数据写在 `data/demo.db`。

生产或沙箱必须显式设置：

```bash
APP_ENV=production
NODE_ENV=production
SESSION_SECRET=一段至少24位的随机字符串
```

缺少飞书配置时，真实登录、创建审批和事件回调都会失败，不会改走演示成功。配置说明见 [docs/deploy.md](docs/deploy.md) 和 [docs/feishu-setup.md](docs/feishu-setup.md)。

## 模式

| APP_ENV | 行为 |
| --- | --- |
| demo | 演示库、演示身份切换、模拟审批。不访问飞书。不能和 `NODE_ENV=production` 同时使用。 |
| sandbox | 调用真实飞书测试应用。没有角色切换。配置不全则阻断。 |
| production | 同上，并且会话密钥不能使用占位值。 |

## 已知限制

- 浏览器定位不能在后台持续记录，也不能防篡改。
- 没有地图密钥时不提供路线导航。
- 演示巡航不能进入补贴申请。
- 油价联动只确认了“每 0.50 元/升调整 0.05 元/公里，不足不调”。基准费率和取整方式仍待企业确认，演示值不是正式政策。
- 金额在服务端按整数分计算，历史申请保存费率快照。
- 界面时间用北京时间。
