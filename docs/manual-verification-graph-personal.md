# Graph 个人账号手工验收清单（Hotmail / Outlook.com）

本清单验证 Microsoft Graph 适配器对**个人 Microsoft 账号**（hotmail.com、outlook.com、live.com）
的收件、文件夹、附件、已读/移动/删除、搜索与发信。Graph 适配器同样适用于 Exchange Online
（工作/学校账号），但本清单以个人账号为主。

- 真实 Graph 登录**不作为 CI 门禁**：自动化测试全部使用 fake fetch / fake auth，不连真实租户。
- 本清单由人工执行；每一步都给出「操作」与「预期」。
- 失败时先对照最后一节的排查表，再记录：步骤号、错误码、时间、账号类型（个人/组织）。

## 0. 前置条件

- 仓库已按 `AGENT.md` 安装依赖并能启动桌面端或服务端。
- 手上有一个可登录的个人 Microsoft 账号。
- 能访问 <https://portal.azure.com>（或 Entra 管理中心）创建应用注册。
- 令牌缓存目录可写（`cachePath` 指向的用户数据目录）。

## 1. Azure 应用注册

1. Entra 管理中心 →「应用注册」→「新注册」。
2. 名称随意（例如 `MailCollect Personal`）。
3. 「受支持的账户类型」选择：
   - 「任何组织目录中的账户和个人 Microsoft 账户」（推荐，同时覆盖 Exchange Online 与个人账号）；
   - 或仅「个人 Microsoft 账户」（只验证个人账号时）。
4. 重定向 URI **不需要填**：设备码流程是公共客户端。
5. 注册完成后，在「身份验证」页把「允许公共客户端流」设为**是**（否则设备码会报 `AADSTS7000218`）。
6. 在「API 权限」→ Microsoft Graph → 委托的权限，添加：
   - `Mail.Read` —— 收件、读正文、列附件；
   - `Mail.ReadWrite` —— 已读/未读、移动、删除、发信时写入 Sent；
   - `Mail.Send` —— `POST /me/sendMail`；
   - `offline_access` —— 刷新令牌，重启后免登录。
7. 个人账号没有租户管理员，一般无需「授予管理员同意」；若组织账号需要，由管理员授予。
8. 记下「应用(客户端) ID」，下一步填入账号配置。

> 适配器默认收信 scope 为 `Mail.Read` + `offline_access`；设备码登录会额外申请
> `Mail.ReadWrite` 与 `Mail.Send`，因此**一次登录即可覆盖读写与发信**。
> 老缓存若只同意过 `Mail.Read`，发信/写操作会得到类型化 `auth` 错误并提示重新授权。

## 2. 账号配置

在应用里新建账号，协议选 `graph`，配置示例：

```json
{
  "provider": "graph",
  "email": "you@outlook.com",
  "config": {
    "clientId": "<应用(客户端) ID>",
    "tenant": "",
    "cachePath": "<用户数据目录>/graph-token-<accountId>.json"
  }
}
```

- `clientId`：**只来自账号 config**，适配器不读环境变量。
- `tenant`：留空或 `common`（个人账号必须走 `common`；填具体租户会登录失败）。
- `scopes`：可选；留空使用默认 `Mail.Read,offline_access`，一般不要手填。
- `cachePath`：必填，令牌缓存文件（写在磁盘上按 `0600` 保存）；留空会得到类型化错误。
- 不要填 `clientSecret`：设备码是公共客户端，没有客户端密码。

预期：保存账号不崩溃。缺 `clientId` 时应得到**类型化 `not_configured` 错误**（文案点名
`clientId`），不会崩溃、不会静默挂起、日志里不出现任何 secret。

## 3. 设备码登录

1. 在账号列表点「验证 / 登录」。
2. 预期：界面出现设备码提示（`userCode` + <https://microsoft.com/devicelogin>），
   同时适配器的 `lastDeviceCodeNotice` 可读到同一条提示。
3. 浏览器打开 <https://microsoft.com/devicelogin>，输入 `userCode`，选择个人账号。
4. 同意上一步的权限。
5. 预期：登录返回 `Graph 已连接：<email>`；失败时返回 `ok:false` 的类型化 `detail`，
   不抛异常、不挂起（可重复点击重试）。
6. 关闭并重启应用，再点一次「验证」：预期无需重新输入设备码（令牌缓存生效），
   只提示已连接。

失败路径预期：断网、输错代码、拒绝同意、超时，都会得到可读的 `auth`/`network` 错误，
不会长时间转圈。

## 4. 文件夹

1. 打开文件夹列表；预期能看到 Inbox / Sent / Drafts / Deleted Items / Archive
   （中文显示名也可，实现按 `wellKnownName` 判定，不依赖显示名）。
2. 若账号没有 Archive，该项可以不出现（适配器对 404 静默跳过，其余角色必须补齐）。
3. 未读计数与网页版 Outlook 的未读数一致（服务器报告口径）。

## 5. 收件（首次 + 增量 + 按文件夹）

1. 首次同步：预期拉取一页（默认 `$top=50`）并保存 `@odata.deltaLink` 游标。
2. 再点一次同步：预期只拉取新邮件（请求游标 URL，而不是从头枚举）。
3. 用一封新邮件验证：预期新邮件出现在列表、正文可读，正文不含 HTML 标签。
4. （可选）按文件夹拉取：`folderId=inbox` 时请求
   `/me/mailFolders/inbox/messages/delta`，只返回该文件夹内的增量。
5. 中途取消同步：预期得到「同步已取消」，不留下半页脏游标。

## 6. 邮件详情与附件

1. 打开一封 HTML 邮件：预期正文显示为纯文本（`<script>`、`<img onerror>` 等不进入正文）。
2. 打开一封带附件的邮件：预期附件列表显示文件名、MIME 类型、大小；正文内嵌图片标记为
   inline（不进入普通附件列表）。
3. 下载附件：预期字节、文件名、Content-Type 正确。
4. 下载「嵌套邮件」（itemAttachment）：预期得到类型化 `unsupported` 提示
   （Graph 不提供这类附件的字节流），而不是空文件。

## 7. 已读 / 未读、移动、删除

1. 打开一封未读邮件：预期变为已读（`PATCH /me/messages/{id}`，`isRead=true`）。
2. 手动标为未读：预期服务器同步为未读。
3. 移到 Archive：预期邮件出现在 Archive；原文件夹不再显示（Graph 移动后 id 会变）。
4. 删除（默认）：预期邮件进入 Deleted Items，可恢复。
5. 彻底删除：预期邮件直接从服务器删除，不经过回收站。
6. 以上写操作若因权限不足失败：预期是类型化 `auth` 错误并提示重新授权，
   收件功能仍然可用。

## 8. 搜索

1. 搜索主题关键词（中文与英文各一次）：预期返回匹配邮件。
2. 搜索发件人邮箱：预期返回该发件人的邮件。
3. 搜索正文关键词：预期返回正文命中的邮件。
4. 限定文件夹搜索（`folderId`）：预期只返回该文件夹内的命中。
5. 未读筛选 / 日期筛选：预期与筛选条件一致。
6. 若服务器拒绝 `$search`（HTTP 400/415/501）：预期界面显示类型化
   「搜索不被当前服务器支持」错误，**不能静默返回空列表**。

## 9. 发信（sendMail）

1. 写一封带附件的邮件发送。
2. 预期：请求为 `POST /me/sendMail`，`Content-Type: text/plain` +
   `Content-Transfer-Encoding: base64`，请求体是完整 MIME 的 base64；令牌请求包含
   `Mail.Send`。
3. 预期：收件人收到邮件；发件账号的 Sent 中出现副本（Graph 服务端自动保存）。
4. 发送结果：成功返回 `ok:true, transport:"graph", savedToSent:"server"`；
   `messageId` 为 null（MIME 发送不回服务端 id，用 MIME 头里的客户端 Message-ID）。
5. 故意撤销 `Mail.Send` 权限（或在只同意过 `Mail.Read` 的旧缓存上）再发信：
   预期 `ok:false`、`error.code = "auth"`、`savedToSent = "none"`、文案提示重新授权；
   此时收信仍正常。
6. 断网发送：预期 `ok:false` 且 `network` 可重试，不会重复投递（服务端未收到请求）。

## 10. 安全与日志

1. 检查服务端日志、桌面日志、错误提示：不得出现 access token、refresh token、
   客户端密码；错误文案只描述原因。
2. `cachePath` 文件权限应为 `0600`（仅当前用户可读写），并把它当作凭据看待。
3. 设备码 `userCode` 不是长期凭据，但也不应写进可长期检索的日志。

## 11. 失败排查

| 现象 / 错误码 | 可能原因 | 处理 |
|---|---|---|
| `AADSTS700016` / `invalid_client` | `clientId` 抄错，或应用不属于该账号 | 核对 clientId；`tenant` 留空 |
| `AADSTS7000218` | 未开启「允许公共客户端流」 | 应用注册 → 身份验证 → 允许公共客户端流 = 是 |
| `AADSTS65001` / `consent_required` | 权限未同意 | 重新设备码登录并同意全部权限 |
| 登录成功但发信/写操作 `403 Authorization_RequestDenied` | 缺 `Mail.Send` / `Mail.ReadWrite` | 补 API 权限后重新授权 |
| `401 InvalidAuthenticationToken` | 令牌过期或缓存损坏 | 删除 `cachePath` 文件后重新登录 |
| 个人账号登录报「账号不在租户中」 | `tenant` 填了具体租户 / `organizations` | `tenant` 留空（= `common`） |
| 一直转圈、没有设备码提示 | `clientId` 缺失或公共客户端未开启 | 查看是否 `not_configured`；检查公共客户端设置 |
| 设备码超时 | 未在有效期内完成登录 | 重新发起登录 |
| 搜索提示不支持 | 服务器拒绝 `$search` | 已知限制；改用本地搜索，界面应显示 `unsupported` |
| `429 Too Many Requests` | Graph 限流 | 等待后重试（可重试错误） |
| Archive 不出现 | 账号没有 Archive（404） | 正常；其余四个角色必须出现 |
| 附件下载提示不支持 | itemAttachment 没有字节流 | 已知限制；导出原邮件 |
| 中文界面找不到文件夹 | 显示名被本地化 | 按 `wellKnownName` 匹配，不依赖显示名 |

## 12. 与自动化测试的边界

- **已由单元测试覆盖（fake fetch / fake auth，不连真实租户）**：well-known 文件夹映射、
  按文件夹 delta、附件元数据与字节解码、PATCH 已读、move/delete、`$search` 合成与
  unsupported 映射、`POST /me/sendMail` + `Mail.Send` scope、缺 clientId 的类型化错误、
  设备码失败路径、token/secret 不出现在结果与错误里。
- **只能由本清单人工验证**：真实设备码登录与同意、真实服务器对 `$search` 的支持程度、
  真实附件下载、真实发信到达与 Sent 副本、真实缓存文件 `0600` 权限。
- 本清单**不是** CI 准入门槛；没有 Azure 应用注册/clientId 时，Graph 相关功能以
  「未配置」状态存在，不应阻塞其它协议的验收。
