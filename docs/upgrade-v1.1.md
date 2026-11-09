# MailCollect v1.1 升级说明（v1 → v1.1 数据迁移）

> 适用：已有 v1 本地库（`mailcollect.sqlite`）升级到 v1.1；以及全新安装的首次初始化。
> 代码位置：`packages/core/src/store/migrate.ts`、`schema-v11.sql`、`store.ts`、`repos.ts`。
> 需求依据：C2（迁移不丢数据）、C3（初始化与种子规则）、C5（收发）、C6（规则分类）、AC-26。

## 1. 一句话结论

升级是**原地、增量、可重复执行**的：v1 的表一行不动，只新增 v1.1 的表和列；
迁移标记写进 `meta.schema_version`，重复启动不会重复迁移，也不会重复播种种子规则。
升级不需要手工操作，下一次启动服务（桌面/`npm run dev:server`）时自动完成。

## 2. 升级前后有什么变化

### 2.1 新增表（`packages/core/src/store/schema-v11.sql`）

| 表 | 用途 | 关键约束 |
|---|---|---|
| `category` | 分类（`enterTodo` / `broadcast` 两个开关） | `name` 唯一；「未分类」是计算态，不落库 |
| `rule` | 规则：名称 + 目标分类 + 条件树 JSON + 启停 + 顺序 | `category_id` 外键 `ON DELETE CASCADE`；删除分类连带删规则 |
| `tag` | 邮件↔分类多对多标签 | `UNIQUE(email_id, category_id)`；`email_id` 级联删除 |
| `folder` | 每个账号的文件夹与未读数 | 主键 `(account_id, path)` |
| `draft` | 本地草稿（整封待发送消息 JSON 快照） | 主键 `id`；账号删除级联 |
| `outbox` | 离线发件队列 | `status ∈ {queued,sending,failed,sent}`（CHECK）；`next_attempt_at` 退避时刻 |
| `init_state` | 初始化向导状态（单行表） | 主键恒为 `1` |

索引：`idx_rule_order`、`idx_tag_category`、`idx_tag_email`、`idx_draft_account`、
`idx_outbox_due`、`idx_raw_email_folder`。

### 2.2 新增列（`ALTER TABLE`，由 `migrate.ts` 用 `PRAGMA table_info` 守卫）

| 表 | 列 | 默认值 | 说明 |
|---|---|---|---|
| `raw_email` | `folder` | `'INBOX'` | 邮件所在文件夹路径（旧邮件全部视为收件箱） |
| `raw_email` | `is_read` | `0` | 已读/未读（旧邮件全部未读，与 v1 行为一致） |
| `raw_email` | `provider_ref_json` | `NULL` | 服务端定位（ref）。`NULL` = v1 旧行「未知」；`{"kind":"ref","ref":{"id","folderId"}}` = 权威定位；`{"kind":"unresolved"}` = 服务器已移动但新定位不可知（必须重同步）。见 2.4 |
| `raw_email` | `received_at` | `NULL` | **服务器记录的接收时间**（IMAP `internalDate` / Graph `receivedDateTime` / EWS `DateTimeReceived`），不是发件人的 `Date` 头。规则 `date.which="received"` 读的是它；`NULL` = 旧行或协议不提供（POP3），此时该叶子按 C6「字段缺失判 false」 |
| `raw_email` | `attachments_json` | `NULL` | 附件元数据数组 `[{"filename","mimeType","size"}]`；**只存元数据，永远不含附件字节或正文**。同步富化时写入；`NULL` = 未富化/协议不提供，`attachmentName`/`attachmentMime`/`attachmentSize` 叶子按 C6 判 false |
| `account` | `smtp_secret_cipher` | `NULL` | SMTP/EWS 密码的 AES-256-GCM 密文，与收件密码同等级 |

### 2.3 原样保留（不删表、不改写、不重建）

`user_profile`、`account`、`sync_cursor`、`raw_email`、`broadcast_verdict`、`task`、
`broadcast_decision`、`llm_config`、`change_log`、`meta`。

- `change_log` 的旧行（`seq` 连续）一条不动，升级只会在尾部追加新行。
- `user_profile` 升级后只作为只读历史保留（规则分类取代姓名点名，见 C6/C7），
  但**不会删除**；它的姓名/别名/邮箱仍用于展开「点名给我」种子规则。
- v1 的 `broadcast_verdict` / `broadcast_decision` 表保留（历史数据），
  新管线不再写入；判定改由规则分类产生。

### 2.4 服务端定位（`provider_ref_json`）与本地去重键

移动会改变服务端 id（IMAP 的 uid 是**文件夹作用域**的，Graph 也会换 id），所以
「本地行 ↔ 服务器消息」的绑定不能靠 uid 一条信息。

**三种状态**（由 `mappers.parseEmailRefState` 解析，任何不可读内容一律按
`unresolved` 处理，绝不猜）：

| `provider_ref_json` | 含义 | 读/写路径的行为 |
|---|---|---|
| `NULL` | v1 旧行，从未记录 | 读/写回落到「`uid` + 当前文件夹」这一唯一可知信息 |
| `{"kind":"ref","ref":{"id","folderId"}}` | 权威定位 | 读/标/删一律用它，重启后仍然生效 |
| `{"kind":"unresolved"}` | 移动成功但新定位不可知 | 拒绝拿旧 uid 去读/标/删（旧 uid 可能指向另一封），提示重同步 |

写入时机：同步成功（`upsertEmails` 带 folder）、`move` 成功后写新 ref、适配器
`move` 返回 `null` 或纯本地移动时写 `unresolved`、重新同步识别到邮件后覆盖回
`ref`。

**本地去重键的变化**：文件夹作用域同步时，`raw_email.uid` 存的是
`"<folderId>\u001f<provider uid>"`（单位分隔符 U+001F），真正的服务端 id 留在
`provider_ref_json.ref.id`。原因是 v1 的 `UNIQUE (account_id, uid)` 是表约束、
不能在不重建表的前提下改动，而 IMAP 的 inbox uid 5 与 archive uid 5 是两封不同
邮件——不区分文件夹就会被 `INSERT OR IGNORE` 静默丢掉一封。

**重新同步怎么识别同一封邮件**（`upsertEmails`，按顺序尝试，命中即更新既有行）：

1. 本地复合 uid 完全相同（同一文件夹内的常规增量）；
2. 持久化 ref 的 `id` + `folderId` 相同（已解析的移动）；
3. v1 裸 uid 且 `provider_ref_json IS NULL`（升级后首次同步「收养」旧行，不建重复行）；
4. **Message-ID 兜底**：同账号 + 同 Message-ID + 同文件夹 + 发送时间相差 ≤1 天
   （`MESSAGE_ID_MATCH_WINDOW_DAYS`）。用于 `unresolved` 的移动——uid 和 ref 都
   指不过去，这是阻止「同一封邮件变成两条本地行」的最后一道闸。

## 3. 为什么是幂等的

| 保证 | 实现 |
|---|---|
| 建表可重复 | 全部 `CREATE TABLE/INDEX IF NOT EXISTS` |
| 加列可重复 | SQLite 没有 `ADD COLUMN IF NOT EXISTS`，因此先查 `PRAGMA table_info` 再 `ALTER` |
| 「这是不是 v1 库」可重复判定 | 读 `meta.schema_version`：不存在且库里有业务数据 → v1；否则按已迁移/全新处理。**不用行数判断**，否则「向导进行到一半就退出」的全新库会被误判成 v1 |
| 迁移版本最后写 | 先建表/加列，最后写 `meta.schema_version = '1.1'`；中途失败下次启动重跑，不会把半成品当成已完成 |
| 种子只建一次 | `meta.rules_seeded` 标记；**删除种子规则后不重播**（见第 4 节） |

## 4. 种子规则：只建一次、可编辑、删除不重播

两条种子规则来自 `packages/shared/src/rules.ts`（`SEED_BROADCAST_RULE` /
`buildSeedPersonalRule` / `planSeedPersonalReconcile`）：

1. **「群发/通知」**（分类 `enterTodo=false`、`broadcast=true`）：纯字段条件、零模型调用，
   复刻 v1 R4 的强信号（`List-Id`、`Precedence: bulk|list|junk`、`Auto-Submitted`、
   `from.isNoReply`、`To+Cc ≥ 10`）。
2. **「点名给我」**（分类 `enterTodo=true`、`broadcast=false`）：由档案的姓名/别名/邮箱/
   邮箱前缀展开成 `body` 字段条件，复刻 v1 R3。

播种时机与判定（`repos.ts`）：

| 场景 | 行为 |
|---|---|
| 全新库首次启动 | 立即建「群发/通知」；档案还没有 → **不建**「点名给我」（避免 inert 规则） |
| 向导保存用户档案 | `planSeedPersonalReconcile` 决定：缺行 → 创建；身份词变化 → 重展开；未变 → 什么都不写 |
| v1 → v1.1 升级 | 用旧 profile 的身份词一次建出两条；同时 `init_state.completed=1`（老用户不再看向导） |
| 用户删除「点名给我」 | 写墓碑 `meta.seed_personal_deleted`，之后永不重建（删分类连带删规则同样写墓碑） |
| 用户编辑过「点名给我」 | 记录播种时的树哈希 `meta.seed_personal_hash`；当前树哈希不同 → 视为用户版本，永不覆盖 |
| 任意二次 `migrate()` | `meta.rules_seeded` 已存在 → 直接返回，不写任何行 |

> 已知偏差（与 C3 字面「向导结束展示两条种子规则」）：若向导第①步被跳过，
> 档案没有可匹配的身份词，则只展示「群发/通知」一条。这是 `shared/src/rules.ts`
> 的设计决定（空档案不产出 inert 规则）；用户补完档案后自动出现第二条。

## 5. change_log：新增写路径全部入账

`change_log` 仍是唯一的同步缝，`entity` 取值与 `op` 明确：

| entity | insert | update | delete |
|---|---|---|---|
| `category` | 建分类（含种子） | 改名/开关 | 删分类 |
| `rule` | 建规则（含种子/重展开） | 改树/启停/排序/重展开 | 删规则 |
| `tag` | 打标 | 命中规则变化时改 `ruleId` | 重算移除、级联删除 |
| `folder` | 首次发现文件夹 | 角色/未读数变化 | 服务器不再返回该文件夹 |
| `draft` | 首次自动保存 | 同 id 覆盖保存 | 手动删除 |
| `outbox` | 入队 | 状态机每一步（含退避时刻） | 手动删除 |
| `init_state` | 首次写向导状态 | 完成/跳过变化 | —（不删） |
| `account` | 已有路径 | 发信配置/密文轮换 | 已有路径 |

级联删除同样是写操作：先取出将被级联的行，再删父行，逐行写 `op=delete`，
所以同步缝不会漏掉「不是显式 `DELETE` 语句」的写：

- **删分类**（`deleteCategory`）：`category` + 其下 `rule` + 该分类的 `tag`；
- **删账号**（`deleteAccount`）：`account` + 该账号的 `raw_email`、`broadcast_verdict`、
  `task`、`tag`、`folder`、`draft`、`outbox`、`sync_cursor`，每张表各自成行。

### change_log payload 里到底有什么

**前提**：`change_log` 不是内部调试日志，它通过 token 鉴权后的
`GET /api/sync/changes`（以及 SSE 同步缝）**对外可见**，所以 payload 只放「重放所需
的最小字段」，大字段与敏感字段按 id 去各自的表里读。

| 会进 payload | 不会进 payload（按 id 回表读） |
|---|---|
| 分类（名称/两个开关）、规则（名称/目标分类/条件树/启停/顺序） | 任何密码 / app password / token / client secret |
| 标签（`emailId`/`categoryId`/`ruleId`）、文件夹（`path`/`role`/`unread`） | `account.secret_cipher`、`account.smtp_secret_cipher`、`llm_config.api_key_cipher` 的密文 |
| `raw_email`：**只有 `id` / `folder` / 服务端 ref**；同步与移动只记定位，不记正文 | `account.config` 原文（创建/更新只记 `provider`/`label`/`email`/`enabled`/`send` 白名单字段） |
| 草稿：`id` / `accountId` / `savedAt`（**不含**正文/收件人/附件） | **邮件正文、邮件头全文、附件字节**（`raw_email` 表里本就没有附件字节，正文也不进日志） |
| 发件箱：**只有 `outboxId` / `status` / `attempts`**（含退避时刻的状态变更） | **发件正文、HTML、收件人/抄送/密送列表、附件元数据与 base64**——R7 回放按 `outboxId` 读 `outbox` 表（该表必须存全文才能发信） |
| 任务（标题/详情/证据引用/时间，任务本身就是被同步的实体）、用户档案、LLM 配置视图（`hasKey` 布尔，无 key） | — |

一句话：**凭据与邮件/发件正文永远不进 change_log**。控制台日志、错误信息、HTTP
错误体同样不得出现正文全文或任何凭据（C2）——二者是不同的边界，但结论一致。
发件箱的正文只存在于 `outbox.message_json`，通过 `getOutboxItem(outboxId)` 读取。

## 6. 升级后怎么验

```bash
# 1) 类型检查 + 存储层测试（本包）
cd packages/core && npx tsc --noEmit
npx vitest run src/store        # 46 个用例：迁移幂等、种子只一次、标签幂等、outbox 状态机、change_log 入账（含删账号级联）、文件夹同步/ref/Message-ID 兜底

# 2) 仓库门禁（根目录）
npm run typecheck
npm test -w @mailcollect/core
```

测试里的升级用例在临时目录里**真实建一个 v1 库**（只执行 `schema.sql` 并插入
profile/账号/邮件/任务/change_log 各一行），再用 `openStore` 打开：

- `store.test.ts > "v1 -> v1.1 migration" > "upgrades in place, keeps every v1 row and seeds the two rules once"`
- `store.test.ts > "v1 -> v1.1 migration" > "does not replay a seed rule the user deleted after the upgrade"`
- `store.test.ts > "account deletion" > "logs every row the foreign-key cascade removes"`（9 个 entity 逐一断言）
- `store.test.ts > "migration bookkeeping" > "creates the folder index and keeps a second migration a no-op"`
- `store.test.ts > "folder-scoped sync (T53)" > "matches an unresolved move by Message-ID on resync instead of duplicating the row"`
- `store.test.ts > "folder-scoped sync (T53)" > "keeps same-numbered UIDs from different folders as two emails"`
- `store.test.ts > "change_log privacy (T63)" > "never puts outbox message bodies into the sync stream"`

断言内容：v1 四类数据仍在、旧 `change_log` 行仍在（`deviceId=device-old`）、
两条种子规则建出且含旧 profile 的姓名、`init_state.completed=true`、
连续两次 `migrate()` 后规则数与 `change_log` 头号不变。

## 7. 备份与回滚

- 升级前建议整目录备份数据目录（`mailcollect.sqlite`、`mailcollect.sqlite-wal`、
  `mailcollect.sqlite-shm`、`secret.key`）。AES 密钥与库同目录，缺一不可解密。
- **不支持降级**：v1.1 写入的 `folder`/`is_read` 列与新增表对 v1 代码不可见，
  但 v1 代码不会删除它们；如需回到 v1，请用升级前的数据目录副本。
- 迁移不提供「清空/重置数据」入口（C3 明确不做）。

## 8. 已知限制

1. 迁移只为已存在的邮件补默认值（`folder='INBOX'`、`is_read=0`、`provider_ref_json=NULL`），
   不会回填真实文件夹/已读状态/服务端定位；下一次同步时由适配器写入
   （`replaceFolders` / `markEmailRead` / `moveEmail` / `provider_ref_json`）。
   v1 旧行在首次文件夹作用域同步时被「收养」（补 uid 前缀与 ref），不会变成两行。
2. 附件的原始字节不在本层持久化（附件由适配器按需取回，`AttachmentMeta` 只存元数据）。
   `attachments_json` 同理只有 name/mime/size，任何路径都不会把字节写进本库。
3. `received_at` 只在适配器真的提供服务器接收时间时才有值：POP3 没有这个信息，
   v1 旧行迁移后也为 `NULL`；不会用 `sentAt` 或抓取时刻冒充。
   **边界（三态缺口）**：引擎按 C6 把「字段缺失」定义为该叶子 `false`，并没有
   `unknown` 第三态——所以 POP3 / 未富化邮件的 `date.which="received"` 条件不会命中，
   而 `NOT(该条件)` 会命中，尽管真实答案可能是「已知不在区间」。要让「未知」与
   「明确不在区间」在结果里可区分，需要改引擎的求值结果类型（C6 契约变更），
   本版不做；这里把缺口如实记录为已知边界。
4. `change_log` 持续增长，v1.1 不做清理/压缩（与 v1 相同，预留同步缝）。
5. **历史「已发送」镜像的 folder 归属可能错误（T70 修复）**：T70 之前的版本把发信成功写入
   的本地镜像落在 `raw_email.folder` 的默认值 `INBOX`，所以按 Sent 角色筛选的「已发送」
   视图可能看不到这些邮件（邮件本身已投递成功，只是本地归属错）。修复后**新发的邮件**
   一律写入 Sent 角色对应的真实文件夹（账号没有 Sent 角色行时为字面 `Sent`），直发与
   离线队列 worker 两条路径一致。**旧行不做自动迁移**：镜像行可识别的标记是
   `id = '<accountId>:sent:<Message-ID>'` 加 `headers.message-id`，但 POP3 的 UIDL 允许
   以 `sent:` 开头的任意字符串，其收件行 id 形状与镜像行完全相同，无法 100% 区分；
   按「毫不可靠就不做」的原则，本版不会为修正旧数据而批量移动 `folder='INBOX'` 的行
   （避免把普通收件箱邮件误当成已发送）。需要找回旧邮件的用户：最稳妥的是**重新发送**
   该邮件（新镜像会正确归位）；高级用户可在备份后用
   `SELECT id, account_id, subject, sent_at FROM raw_email WHERE id LIKE '%:sent:%' AND folder='INBOX'`
   逐条人工核对（`uid` 是 Message-ID、`from_email` 是账号地址、`sent_at` 等于发信时刻），
   再对**核对过的 id** 执行 `UPDATE raw_email SET folder='Sent' WHERE id IN (...)`。
   注意：直接改库不会写 `change_log`（同步缝看不到这次修改），本机单人使用可接受，
   多端同步前请以重新发送为准。
