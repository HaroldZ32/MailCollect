# 本地 Exchange（EWS）手工验证清单

> 适用版本：MailCollect v1.1 · 适配器 `packages/core/src/mail/ews.ts` · 2026-11-09
> 目的：真实环境（公司本地 Exchange 2016+）的收发验证。**本清单不是 CI 门禁**：
> 自动测试只使用 XML fixture（`ews.test.ts` / `autodiscover.test.ts`），不连真实服务器（AC-38）。

## 0. 范围与前提

- 支持：Exchange Server 2016 及以上，EWS 收件（FindItem / GetItem / GetAttachment /
  GetFolder / MoveItem / DeleteItem / UpdateItem）、`CreateItem` 发信并保存「已发送」副本。
- 认证：`password`（HTTP Basic over HTTPS）与 `ntlm`（NTLMv2）。
- 不支持（本版明确不承诺）：Exchange 2013 及更早、Kerberos、EWS OAuth、Exchange Online 的 EWS
  （Exchange Online 一律走 Graph 设备码，Autodiscover 命中 `outlook.office365.com` 时会提示改用 Graph）。

前置条件：

1. 服务器侧 EWS 已启用：`Get-WebServicesVirtualDirectory | fl Name,InternalUrl,ExternalUrl`。
2. 客户端能访问 EWS URL（公司网络/VPN），且 HTTPS 证书链受信任（自签证书需先在系统信任）。
3. 一个可用的域账号（用户名、密码、域）；测试账号建议单独申请，避免影响真实邮箱。
4. 若同时验证发信，准备 SMTP 中继参数（host/port/secure/username）。
5. 记录环境：Exchange 版本（`Get-ExchangeServer | fl Name,Edition,AdminDisplayVersion`）、
   客户端 OS、网络位置、测试时间。

## 1. 账号配置字段

账号 `config`（非敏，明文存 SQLite）与加密 secret store 的分工：

| 字段 | 含义 | 是否必填 | 示例 |
|---|---|---|---|
| `ewsUrl` | EWS 端点，必须 https | 是（或 Autodiscover 自动填） | `https://mail.corp.example.com/EWS/Exchange.asmx` |
| `authMode` | `password` / `ntlm` | 否，默认 `password` | `ntlm` |
| `ewsUser` | 登录名；缺省用账号邮箱 | 否 | `CORP\alice` 或 `alice@corp.example.com` |
| `ewsDomain` | NTLM 域；缺省空 | NTLM 建议填 | `CORP` |
| `ewsTimeoutMs` | 单次请求超时（1000–120000） | 否，默认 30000 | `45000` |
| `ewsPageSize` | FindItem 每页条数（1–200） | 否，默认 50 | `100` |
| secret | 密码，AES-256-GCM 加密落盘 | 是 | 不在 config/日志/错误里出现 |

## 2. 自动探测（Autodiscover）

1. 在初始化向导/设置页选择「本地 Exchange」，点「自动探测」。
2. 应用按 `user@domain` 依次请求：
   `https://autodiscover.<domain>/autodiscover/autodiscover.xml` →
   `https://<domain>/autodiscover/autodiscover.xml`；遇到 `Redirect` 最多跟 2 跳。
3. 期望：识别到 `kind = "ews"`，显示 `https://mail.corp.example.com/EWS/Exchange.asmx`。
4. 若返回 `kind = "graph"`：说明指向 Exchange Online，**不要**继续 EWS，改用 Graph 设备码。
5. 若失败：界面必须显示可读原因（`auth` / `network` / `protocol`）并允许**手工填写**
   `ewsUrl`、`authMode`、SMTP 参数后继续。把界面错误文案抄进证据表（确认没有密码）。
6. Redirect 只允许同源、`autodiscover.*` 或 Microsoft 365 家族域名；其它目标会被拒绝并提示手填，
   **不会**把 Basic 凭据转发给任意主机。若公司 Autodiscover 通过第三方跳转，请直接手填 `ewsUrl`。

手工填写后重复「验证连接」。

## 3. 收件验证

| # | 操作 | 期望 | 记录 |
|---|---|---|---|
| 3.1 | 点「验证连接」 | `EWS 已连接：<email> @ <host>（Exchange 15.x）` | 版本号 |
| 3.2 | 刷新文件夹 | 出现 Inbox / Sent / Drafts / Trash；Archive、Junk 不存在时应静默跳过，不报错 | 文件夹数与角色 |
| 3.3 | 首次同步 | 拉取最近一页邮件；列表出现主题/发件人/时间 | 封数 |
| 3.4 | 再次同步 | 重复同步不产生重复邮件；新邮件被拉入 | 封数 |
| 3.5 | 打开一封 HTML 邮件 | 正文可读（HTML 保留、纯文本由 HTML 转换）；收件人正确 | 截图 |
| 3.6 | 打开带附件的邮件 | 附件列表含文件名/类型/大小；下载字节与 Outlook 一致 | 文件名与字节数 |
| 3.7 | 标为已读 | Outlook/OWA 侧刷新后该邮件为已读；反向取消已读也生效 | 截图 |
| 3.8 | 移动到归档 | 目标文件夹出现该邮件，原文件夹消失；再次同步不重复 | 截图 |
| 3.9 | 删除 | 默认进入「已删除邮件」（可恢复）；`permanent` 才彻底删除（仅在测试账号做） | 截图 |

说明：

- 增量游标 = 已取到的最大 `DateTimeReceived`；下一次查询回退 5 分钟重叠窗口，
  同一秒的多封邮件由上层按 `accountId:uid` 去重兜住，因此 3.4 必须验证「不重复」。
- EWS `AttachmentId` 自带定位；若服务器返回 `ErrorItemNotFound`，说明附件/邮件已被移动或删除，重新同步后再试。

## 4. 发信验证（需要 SMTP 或 EWS 发信通道）

1. 设置页确认该账号的发信配置（SMTP host/port/secure/username，或 EWS 发信）。
2. 撰写一封纯文本 + 一封 HTML + 一个附件，发送给自己或测试收件人。
3. 期望：
   - 收件方收到，主题/正文/附件正确；
   - 账号的服务器「已发送」出现副本（EWS `CreateItem` + `SendAndSaveCopy`）；
   - 本地「已发送」镜像同时存在（服务端层负责）；
   - 失败路径：断开网络 → 返回可读 `network` 错误，消息不丢失（outbox 重试）。
4. 记录 Message-ID 与服务器 Sent 中的 ItemId。

## 5. NTLM 专项

1. 设 `authMode=ntlm`，`ewsUser` 用 `域\用户名` 或 `用户名@域`，`ewsDomain` 填 NetBIOS 域。
2. 期望三次握手成功（无认证 401 → Type1 → Type2 → Type3 → 200），`verify` 通过。
   注意：适配器不持有长连接，每次 SOAP 请求都会重新握手（3 个往返），因此 NTLM 下的同步比 Basic 慢，
   属于预期行为；不要据此判断「卡死」。
3. 失败排查：
   - 401 且服务器只给 `Negotiate`（无 `NTLM`）：公司可能只允许 Kerberos/Negotiate —— 本版不承诺，
     记录在证据表，改用 `password`（若 IIS 允许 Basic）或请管理员放开 NTLM。
   - 401 且反复要求 Type1：确认客户端与服务器之间没有代理剥离 `Authorization` 头；
     NTLM 需要同一 TCP 连接，代理/负载均衡可能破坏握手。
   - 账号被锁：检查是否用了错误域格式。
4. **不要**在日志/截图中出现密码；错误文案必须是 `auth: ...` 且无凭据。

## 6. 错误与安全核对

| 场景 | 期望 |
|---|---|
| 密码错误 | `auth` 类型可读错误，提示检查用户名/密码与认证方式；**不含密码** |
| EWS URL 写错/404 | `protocol`，提示检查 `ewsUrl` 是否指向 `.../EWS/Exchange.asmx` |
| 服务器 5xx | `network`，可重试 |
| 断网/DNS 失败 | `network`，可重试；文案含主机名，不含凭据 |
| 超时 | `network`，提示超时秒数；`ewsTimeoutMs` 覆盖整个交换（含响应体），服务器发完响应头后挂住正文也会超时 |
| 账号被禁用/无权限 | `auth`，不崩溃 |
| 服务器 429/限流 | `rate_limited`，可重试 |

安全断言（逐条打勾）：

- [ ] 错误信息、日志、截图里没有密码/令牌。
- [ ] 抓包确认密码只出现在 `Authorization: Basic`（或 NTLM 握手）头的 HTTPS 流量里。
- [ ] 账号密码在 SQLite 中是密文（secret store），config 里只有非敏字段。

## 7. 证据表模板

| 项 | 值 |
|---|---|
| 验证日期 / 验证人 | |
| Exchange 版本（AdminDisplayVersion） | |
| EWS URL | |
| 认证方式 | password / ntlm |
| Autodiscover 结果 | ews / graph / 失败+手填 |
| 3.1–3.9 结果 | 通过 / 失败（附错误文案） |
| 4 发信结果 | 收件方收到 / Sent 副本 / Message-ID |
| 5 NTLM 结果 | 通过 / 被策略拒绝 |
| 截图与日志路径 | `evidence/exchange-onprem/<date>/...` |

## 8. 已知限制

- 不做 Exchange 2013 及更早版本兼容。
- 不做 Kerberos/OAuth 认证；公司若只允许这两种，需要现场确认后另行适配。
- EWS 搜索是 FindItem 范围：给了文件夹搜该文件夹，否则搜 Inbox；不跨文件夹深搜。
- 不做 EWS 推送订阅（Streaming/Pull）；新邮件靠轮询同步。
- Archive 文件夹在本地 Exchange 上可能不存在（在线存档是独立邮箱），列表会跳过它。
