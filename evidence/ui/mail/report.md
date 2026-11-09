# 证据：ui-mail（T35）— 收发界面

> 生成时间：2026-11-09（Asia/Shanghai）· 操作者：se-ui-mail（Senior Engineer）· 任务行：T35
> 复跑：`node evidence/ui/mail/run.mjs`（会重建 `.runtime/`、清上一轮 png，并在末尾打印 `58/58 passed` 或失败清单）

## 1. 改了什么（写域之内）

| 文件 | 变更 |
|---|---|
| `apps/ui/src/pages/InboxPage.tsx` | 重写：文件夹联动（侧栏事件 + 面板内 chips）、分类多选筛选（ANY）、每封邮件全部标签、搜索、只看未读、分页「加载更多」、详情（服务端 sanitized html）、已读乐观更新 + 502 回滚、回复/转发/归档/移入垃圾箱、附件下载、发件箱页、草稿页 |
| `apps/ui/src/components/ComposerDialog.tsx` | 替换占位：撰写/回复/转发、To/Cc/Bcc、HTML/纯文本切换（含预览）、多附件（base64，单件 ≤10 MB / 合计 ≤20 MB）、签名开关、草稿自动保存（停输 3 秒 / 关闭 / 切换账号）、发送三态提示、仅入队、删除草稿 |
| `apps/ui/src/components/MessageView.tsx` | 新增：前端二次 sanitize（`<script>/<style>/<iframe>/<object>/<form>` 等整树删除，`on*`/`srcdoc`/`javascript:` 移除，外链补 `noopener noreferrer nofollow`）、富文本/纯文本切换、引用原文折叠、附件列表与下载 |
| `apps/ui/src/components/Sidebar.tsx` | 增量：文件夹导航与未读数（`FOLDER_EVENT` 跨文件事件），保留 T31 已加的「规则/初始化」入口、未配置提示与两个窗口事件监听（对 HEAD 的 diff 中只删 2 行，且都是 T31 自己替换的旧行） |
| `evidence/ui/mail/{run.mjs,seed-extra.ts,report.json,report.md}` | 证据脚本与结果（本目录） |

未触碰：`App.tsx`、`useMailData.ts`、`lib/api.ts`、`SettingsPage.tsx`、`OnboardingWizard.tsx`、`styles/global.css`（新布局一律内联样式或复用既有 class）。

## 2. 门禁（原样执行，原样记退出码）

`run.mjs` 第一步就跑这两条，`report.json` 里逐条记录：

| 命令 | 结果 |
|---|---|
| `npm run typecheck -w @mailcollect/ui` | **exit=0** |
| `npm run build` | **exit=0** |

仓库级核对（本次会话手工跑，与 UI 改动无测试关联，仅作「没有弄坏别人」的证据）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（shared/core/server/ui 全量） | **exit=0** |
| `npm test` | **exit=0**，29 个测试文件 / 577 个用例全过 |

UI 包没有测试框架，所以本任务**没有**任何单元测试覆盖声明；有的只是上面那 58 条浏览器断言。

## 3. 黑盒证据（Playwright，生产构建 + 真 server + 一次性数据目录）

共 **58 条断言全部通过**（`report.json` 里 `failed: 0`）。环境：1440×960 @2x，Chromium headless shell（`node_modules/.cache/ms-playwright`）。
注意：8787/5173 被另一处 dev 实例占用，因此证据用**生产构建**经同源静态服务（8099）反代真实 server（8801）来跑，避免动别人的进程与数据。

| 断言 | 观察到的结果 |
|---|---|
| 收件箱列表 | 8 封 / 未读 6，侧栏 4 个文件夹，收件箱未读 4 |
| 每封邮件显示全部标签 | 「苏州客户现场走访」= 2 个标签（点名给我 + 项目跟进） |
| 分类多选 ANY | 单选「项目跟进」= 2 封；再选「群发/通知」= 6 封（并集） |
| 详情正文 | 标题 + 剥离引文后的正文可见 |
| **前端 sanitize** | 拦截 `/api/messages/e1` 返回含 `<script>`/`onerror`/`onclick`/`javascript:`/`<iframe>` 的 html：`window.__xss=null`，script/iframe/on*/js-link 计数全 0，正文与附件条目仍可见，无 pageerror |
| 草稿停输 3 秒 | `GET /api/drafts` = 1 行，UI 显示「草稿已保存」 |
| 草稿 upsert | 再改一次后仍是 **1 行、同一 id**（`f7382308-…`），附件 1 个 / Bcc 1 个随草稿落库 |
| 草稿恢复 | 关闭弹层 → 草稿页刷新 → 「继续编辑」可见 |
| 发送硬失败（认证 535） | 弹层内可读错误「SMTP 认证失败：服务器拒绝了用户名或密码（535…）」；发件箱出现 `failed` + `lastError`，带「重试」「删除」 |
| 真投递（本地 SMTP sink:2525） | `status=sent`、弹层关闭、提示「已发送」、sink 收到 DATA（421 B，含 To/Subject/Message-ID）、发件箱出现 `sent` 行 |
| 端口不可达（:1） | `POST /send` 返回 `queued` 并提示「已加入发件箱」；worker 尝试后落 `failed` + 近期 `nextAttemptAt`（27 秒）→ UI 区分显示「失败 · 将自动重试」 |
| 侧栏文件夹联动 | 点「归档」→ 列表切到「邮件 · 归档」 |
| 未配置（空库） | 收件箱显示「还没有邮箱账号…设置页添加账号」，侧栏「未配置：档案 / 邮箱账号」 |
| 运行时 | 全程 **pageerror = 0**；console error 仅 2 条且都是预期的 `Failed to load resource`（证据账号连不上 127.0.0.1:1） |

截图（`evidence/ui/mail/`，png 被 `.gitignore` 忽略，留在本地）：

| 文件 | 内容 |
|---|---|
| `01-inbox-list.png` | 多账号 + 文件夹未读 + 分类筛选 + 每封多标签 |
| `02-inbox-filter-category.png` | 分类单选筛选结果 |
| `03-inbox-detail.png` | 详情头（分类 chips、回复/转发/归档/删除）+ 正文 |
| `04-html-sanitize.png` | 恶意 html 被清洗后仍可读的富文本视图 |
| `05-composer.png` / `05b-composer-attachments.png` | 撰写弹层（Cc/Bcc/HTML 预览/附件/页脚草稿状态） |
| `06-composer-autosaved.png` | 草稿「已保存」状态 |
| `07-drafts.png` | 草稿页（继续编辑 / 删除） |
| `08-send-auth-failure.png` | 认证失败的可读错误 |
| `09-outbox-failed.png` | 发件箱失败行（需手动重试 + 原因 + 重试/删除） |
| `10-send-sent.png` | 真投递成功的「已发送」提示 |
| `11-outbox-auto-retry.png` | 可重试失败的「失败 · 将自动重试」 |
| `12-folder-archive.png` | 侧栏切文件夹后的空态 |
| `13-unconfigured.png` | 空库：收件箱与侧栏的未配置提示 |

## 4. 没验证到的（明确边界）

1. **真实 SMTP/Graph/EWS**：成功路径只打本地 SMTP sink；Graph `sendMail`、EWS `CreateItem`、真实 IMAP `APPEND` 未在 UI 侧跑过。
2. **「sent 但 Sent 副本失败」**：契约里 `status=sent` + `emailId=null` 时 UI 显示「已发送；本地副本未写入」且**不给重发**——该分支已按响应字段实现，但**未能构造**出这个服务端状态（需要 SMTP 成功 + APPEND 失败），因此只有代码路径，没有黑盒证据。
3. **服务端 sanitize 本身**：本次验证的是「前端第二道防线」；HTML 是从 API 拦截注入的恶意内容，不是真实 provider 下发的 html（fixture 账号连不上真实服务器，`body.html` 为 null）。
4. **草稿跨进程恢复**：只验证了「页面重载后草稿从列表恢复」，没有重启 server 进程。
5. **已读 PATCH 的成功路径**：fixture 账号的远端不可达，服务端先改远端再落库，所以 PATCH 返回 502；截图里能看到 UI **回滚 + 可读错误**（这正是契约要求的 reconcile 行为），但「成功标记已读」没有在黑盒里跑过。
6. **IMAP/POP3/Graph 同步、文件夹未读数来源**：未读数来自 `seed-extra.ts` 写出的文件夹快照（真实同步才由适配器写），不是同步实测。
7. **视觉 QA**：人工看过 01/05/05b/08/09/10，其余截图只做了 `body 非空 + 无 pageerror` 断言；没有做像素级基线对比。
8. 发送弹层的「HTML 正文」是**纯文本 + 换行转 `<br/>`** 的最小实现（不是富文本编辑器），这是刻意的最小 diff；`bodyHtml` 为空时退化为纯文本单体。

## 5. 复跑步骤

```bash
# 1) 浏览器（一次性，~150 MB，装在 gitignore 的 node_modules/.cache）
PLAYWRIGHT_BROWSERS_PATH=$PWD/node_modules/.cache/ms-playwright npx playwright install chromium

# 2) 跑证据（会自己起 server + 静态服务，用完即关）
node evidence/ui/mail/run.mjs
```

`.runtime/` 是脚本自己的一次性数据目录（每次开头删除重建），内含 sqlite 与测试密钥，**不属于交付物**。
