# 飞书配置说明

核对日期：2026-11-08。下面只写当天从飞书开放平台文档读到的内容。企业还没有提供 App、审批模板、租户授权、回调域名和密钥，所以本系统现在不会发真实审批或消息。

## 登录

用户授权页（2026 文档）：

`GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`

必填查询参数：`client_id`、`response_type=code`、`redirect_uri`。本系统另外总是发送一次性 `state`，并使用 `prompt=consent`。`scope` 留空也可以；如果填写，必须是该应用已经开通的权限，否则用户会看到 20027。不要把未开通的 scope 写死。

用户 token（文档更新于 2026-08-21）：

`POST https://accounts.feishu.cn/oauth/v3/token`

`grant_type=authorization_code`，机密应用使用 `client_secret_post`。成功时读取 `access_token`、`expires_in`、`token_type`。不要再读旧字段 `tenant_access_token`。授权码约 5 分钟、只能用一次。

获取用户信息：

`GET https://open.feishu.cn/open-apis/authen/v1/user_info`

用用户 token，不用租户 token。本系统核对 `data.tenant_key` 与 `FEISHU_TENANT_KEY`，并用 `open_id` 找名册。`open_id` 不能跨应用混用。用户 token 换完身份后不落库、不回前端。

PKCE：授权页支持 `code_challenge` 与 `code_challenge_method=S256`。同一份授权页文档仍写着 PKCE 暂时配合 v2 换 token。v3 token 文档已经列出 `code_verifier` 和错误码 20049。默认关闭 PKCE，避免混用两份尚未完全对齐的说明。设置 `FEISHU_OAUTH_PKCE=1` 才会同时发送 challenge 和 verifier。

## 租户 token

新接口（文档更新于 2026-10-14）：

`POST https://accounts.feishu.cn/oauth/v3/token`

`grant_type=client_credentials`，加上 `client_id` 与 `client_secret`。成功响应使用 `access_token` 和 `expires_in`。token 可能是较长 JWT，存储请按文档预留至少 4KB。按 `expires_in` 提前刷新，不把有效期写成固定 2 小时。

旧接口 `POST /open-apis/auth/v3/tenant_access_token/internal` 已标为不推荐。本系统不调用它，也不混用两种响应字段。

租户 token 只代表应用，不能证明是谁登录。

## 审批

创建：`POST https://open.feishu.cn/open-apis/approval/v4/instances`

使用租户 token。`open_id` 与 `user_id` 至少传一个，本系统传名册上的 `open_id`。`form` 是控件数组的 JSON 字符串。官方示例控件类型是 `input`，所以四个业务字段都按单行文本提交。`uuid` 在同一企业内只能成功创建一次，冲突返回 60012。本系统在调用前写好 uuid；超时用同一个 uuid 再试；60012 标记为待对账，不换成新 uuid，也不当成成功。

查询：`GET /open-apis/approval/v4/instances/:instance_id`

订阅定义：`POST /open-apis/approval/v4/approvals/:approval_code/subscribe`

专页写的是这条路径。审批概述表格里少了 `approvals` 段，实施时以订阅专页为准。返回 1390007 表示已经订阅或已取消，不需要重复制造订阅。开发者后台仍要订阅 `approval_instance` 事件，只调用这个接口不够。

权限：原生接入指南给出 `approval:approval`（查看、创建、更新、删除审批应用相关信息）。创建实例文档还允许“查看、创建、更新、删除原生审批实例相关信息”，这次没有从专页读到第二个权限的独立英文 scope，联调时以后台名称为准。

## 事件

`approval_instance` 仍是 v1 结构：顶层 `uuid`、`token`、`type=event_callback`，详情在 `event`。用顶层 `uuid` 去重。事件里的 `event.uuid` 不是去重键，也不是创建审批时传入的 uuid。

推送方式文档写的是 Webhook。接收端要在 3 秒内返回 HTTP 200，否则平台按 15 秒、5 分钟、1 小时、6 小时重试，最多 4 次，文档给出的窗口大约 7.1 小时。本系统默认接受 8 小时时间偏差，可用 `FEISHU_EVENT_MAX_SKEW_SECONDS` 调整。去重记录会长期保留。

加密与签名（接收事件文档）：

1. 用原始 body 计算 `SHA256(timestamp + nonce + encrypt_key + body)`，与 `X-Lark-Signature` 常量时间比较。
2. 通过后再解密。密钥是 `SHA256(Encrypt Key)`，算法 AES-256-CBC，密文是 `base64(iv + ciphertext)`。
3. 明文里的 Verification Token 还要和配置一致。
4. `url_verification` 只回 `{ "challenge": "..." }`，不改业务数据。配置了 Encrypt Key 时，本系统不接受明文事件。

回调地址：`https://<域名>/api/feishu/events`。必须是飞书要求的公网地址。先落库再处理；数据库写失败返回 5xx，不伪装成功。较旧的 `operate_time` 不会覆盖新状态。`OVERTIME_RECOVER` 只标记待对账，不直接当成通过。

状态：`PENDING` 审批中，`APPROVED` 待财务，`REJECTED` 驳回，`CANCELED` 撤回，`DELETED` / `REVERTED` / `OVERTIME_CLOSE` 暂停或在已结算后登记冲正。未通过不能结算。已结算不删除。

## 本系统不会做的事

- 不发送飞书消息，不安装聊天插件。
- 不向 OA 发单。
- 不在页面收集或回显 App Secret、Encrypt Key、Verification Token。
- 配置不齐时不发起对应的真实请求。
