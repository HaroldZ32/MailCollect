# 证据 — 初始化向导 + 设置页（T31 / ui-onboarding）

采集时间：2026-11-09（Asia/Shanghai）· 采集人：`se-ui-onboarding`（Senior Engineer，写者）
本目录只放证据与采集脚本，不参与构建。

## 环境

| 项 | 值 |
|---|---|
| Node | v24.21.0 |
| 浏览器 | Microsoft Edge 156.0.4314.58（Chromium 内核，Playwright `channel: "msedge"`） |
| Playwright | 1.64.1 |
| UI | Vite 8 dev server `127.0.0.1:5173`（`/api` 代理到 `127.0.0.1:8787`） |
| API | `apps/server` 真进程，`MAILCOLLECT_DATA_DIR=$(mktemp -d)`（全新空数据目录），token `dev-local-token` |

为什么不用 Playwright 自带 Chromium：本机 `$HOME` 只读，Playwright 浏览器缓存
（`~/.cache/ms-playwright`）不存在且不可写；`npx playwright install` 装到 `/tmp`
的副本在命令结束后随 tmpfs 消失。改用系统安装的 Edge（同为 Chromium 内核），
通过 `SHOT_CHANNEL=msedge` 传入，脚本本身不改。

## 复现步骤

```bash
# 1. 全新数据目录起 API（8787，与 vite proxy 对齐）
DATA=$(mktemp -d)
MAILCOLLECT_PORT=8787 MAILCOLLECT_TOKEN=dev-local-token MAILCOLLECT_DATA_DIR="$DATA" \
  node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts &

# 2. 起 UI（5173）
(cd apps/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort) &

# 3. 抓图 + 断言（HOME 需可写；本机用 /tmp 覆盖）
mkdir -p /tmp/pw-home
HOME=/tmp/pw-home SHOT_CHANNEL=msedge node evidence/ui/onboarding/capture.mjs
```

脚本退出码即门禁：`checks` 全 PASS 且 `consoleErrors=0` 才 exit 0。

## 采集结果（本次运行，观察值）

```
SUMMARY checks=21 failed=0 consoleErrors=0 benignFavicon404=1
CAPTURE_EXIT:0
```

21 条断言（脚本内 `check(...)` 逐条打印 PASS）：

| 断言 | 对应 |
|---|---|
| 首次启动自动全屏向导 | AC-01 |
| 完成后进入种子规则页 | AC-03 |
| 种子规则两条（点名给我 / 群发通知） | AC-03 |
| 完成标记持久化（`GET /api/onboarding` = completed:true） | AC-01 |
| API 返回两条种子规则（`seed-rule-personal` / `seed-rule-broadcast`） | AC-03 |
| 设置页「重新打开初始化向导」入口 | C3 |
| 设置页展示已完成状态 / 旧 profile 只读卡 | C3 |
| 设置页未配置联动（还缺：…） | C3 / AC-02 |
| 账号表单提供 EWS 端点与认证方式 | C4 |
| 账号表单提供 SMTP 发信字段 | C5 |
| 密码类输入框 `type=password` 且 value 为空（不回显） | C2 |
| 重置后再次自动全屏（新会话） | AC-01 |
| 全部跳过后 body 非空 / 不再显示全屏向导 / 侧栏出现未配置提示 | AC-02 |
| 跳过标记持久化（skipped:true） | AC-01 |
| 刷新后不再自动全屏 | AC-01 |
| 设置页可重新打开向导 | C3 |
| IMAP 表单仍有收信字段（服务器/端口/用户名/密码） | 回归 |
| EWS 不渲染空的端口输入（改显示 EWS 端点） | 队长复核项 |

## 截图

| 文件 | 路径 |
|---|---|
| `01-complete-step1-autofullscreen.png` | 完成路径 · 第①步（自动全屏） |
| `02-complete-step2-account.png` | 完成路径 · 第②步（账号 / 自动发现） |
| `03-complete-step3-llm.png` | 完成路径 · 第③步（LLM） |
| `04-complete-seed-rules.png` | 完成路径 · 两条种子规则（可确认/编辑/删除） |
| `05-complete-seeds-confirmed.png` | 完成路径 · 确认保留后 |
| `06-complete-inbox.png` | 完成路径 · 进入收件箱 |
| `07-complete-settings.png` | 设置页 · 已完成 + 初始化与引导 + 旧 profile 卡 |
| `08-settings-ews-send-fields.png` | 设置页 · Exchange(EWS) + SMTP 发信字段 |
| `08b-settings-imap-receive-fields.png` | 设置页 · IMAP 收信字段仍完整（无回归） |
| `09-skip-inbox.png` | 跳过路径 · 全部跳过 → 收件箱（空态 + 侧栏未配置提示） |
| `10-skip-reload-no-fullscreen.png` | 跳过路径 · 刷新后不再全屏 |
| `11-reopen-settings-before.png` | 重开路径 · 设置页入口 |
| `12-reopen-wizard.png` | 重开路径 · 向导重新打开 |

## 门禁（写者自测，观察值）

| 命令 | 退出码 |
|---|---|
| `npm run typecheck -w @mailcollect/ui` | 0 |
| `npm run typecheck`（repo 全量） | 0 |
| `npm run build -w @mailcollect/ui` | 0 |
| `npm run build`（根，声明门禁） | 0 |
| `node evidence/ui/onboarding/capture.mjs` | 0（21 PASS / 0 console error） |

## 已知边界 / 未验证项

1. **顶栏「初始化未完成 · 去完成」在写标记后不即时消失**：App.tsx 的
   `needsOnboarding` 读 useMailData 缓存的 onboarding 资源，向导写完后该缓存不
   刷新；整页刷新后正确（见 `10-skip-reload-no-fullscreen.png`）。App.tsx /
   useMailData.ts 不在 T31 写域，属越界发现，需要对应 lane 监听
   `mailcollect:onboarding-changed` 事件。
2. **`/favicon.ico` 404**：`index.html` 未声明 icon，浏览器自动请求，产生 1 条
   console error（脚本按 URL 归为 benign，未计入失败）。index.html 不在写域。
3. **真实协议连接未验证**：向导/设置页只做「保存非密文字段 + 提交密文」与
   `POST /api/accounts/discover` 探测；没有真实 IMAP/POP3/Graph/EWS 服务器可用，
   收信/发信的端到端连通性不在本次证据范围（由 manual-verification-*.md 与
   适配器测试覆盖）。
4. **「编辑」种子规则跳转到规则页**：条件树编辑器属 ui-rules lane（`RulesPage.tsx`
   / `RuleTreeEditor.tsx`），向导里的「去规则页编辑条件」只做跳转，不内联编辑器。
5. **Sidebar.tsx 不在冻结契约的 Allowed write scopes 内**：作业要求（自动全屏、
   侧栏入口、设置页重开）只能经 Sidebar 的 `onNavigate` 落地（App.tsx 无 router、
   OnboardingPage 无 props）。已请队长把该路径补进契约；若契约不补，AC-1 的
   「changed path 都在写域内」需要按队长授权解释。


---

# T66 修复证据（T31 评审的两条 Medium）

采集时间：2026-11-09（Asia/Shanghai）· 采集人：`se-ui-onboarding`
脚本：`capture-t66.mjs` · 输出：`t66-*.png` + 下面这份断言

## 改了什么

| 问题 | 修法 | 文件 |
|---|---|---|
| A 完成后再重开向导，停在种子终结页 | 路由事件 `mailcollect:route` 且 detail=`onboarding` 时，若向导正处 `phase:"seeds"`（上一轮已走到结束页）就重置到第 1 步；中途退出再进保留已填输入。侧栏「初始化」条目改为走 `requestShellRoute("onboarding")`，与设置页重开入口共用同一条事件（不新增事件系统、不改 App.tsx）。 | `OnboardingWizard.tsx`、`Sidebar.tsx` |
| B 向导写入后壳层/侧栏陈旧 | 新增 `DATA_CHANGED_EVENT = "mailcollect:data-changed"`（与 T61 的 `mailcollect:onboarding-changed` 同一套窗口事件约定）+ `notifyDataChanged({profile\|accounts\|llm})`；向导与设置页每次成功写入后广播，`useMailData` 监听后按范围重取 profile/accounts/llm 切片（不整包 reload，避免覆盖 SSE 已推进的 tasks），`Sidebar` 收到后重取 health，设置页旧 profile 卡也顺手重取。 | `OnboardingWizard.tsx`、`Sidebar.tsx`、`SettingsPage.tsx`、`lib/useMailData.ts` |

T61 已建立的监听模式（onboarding 资源失效 + 重拉）原样保留；没有新增缓存层。

## 采集结果（本次运行，观察值）

```
SUMMARY checks=12 failed=0 consoleErrors=0 navigations=1
T66_CAPTURE_EXIT:0
```

| 断言 | 结果 |
|---|---|
| 复位初始化状态 | PASS |
| B 完成后侧栏不再显示「未设置档案」 | PASS（侧栏尾部：李四 / Asia/Shanghai · lisi@corp.example） |
| B 完成后侧栏显示新档案名 | PASS |
| B 完成后侧栏「未配置」不再含档案 | PASS（只剩「未配置：邮箱账号」） |
| B 设置页未配置提示不再含用户档案 | PASS（还缺：邮箱账号、LLM 供应商） |
| B 设置页旧 profile 卡已显示新名字 | PASS |
| B 设置页初始化状态已完成 | PASS |
| A 设置页重开 → 显示第 1 / 3 步 | PASS |
| A 重开后不再停在「初始化完成」终结页 | PASS |
| A 侧栏重开 → 显示第 1 / 3 步 | PASS |
| A 未完成时切面板回来保留输入（不被重置） | PASS（王五） |
| 全程未发生页面级跳转（同会话验证） | PASS（navigations=1） |

## 截图

| 文件 | 路径 |
|---|---|
| `t66-01-after-complete-sidebar.png` | 完成后（未刷新）侧栏：李四、未配置只剩邮箱账号 |
| `t66-02-settings-consistent.png` | 完成后设置页：「已完成」+「还缺：邮箱账号、LLM 供应商」+ 旧 profile 卡显示李四 |
| `t66-03-reopen-step1-from-settings.png` | 设置页「重新打开初始化向导」→ 第 1 / 3 步 |
| `t66-04-reopen-step1-from-sidebar.png` | 侧栏「初始化」→ 第 1 / 3 步 |

## 回归

改完后重跑 T31 的三条路径（`capture.mjs`，同一服务）：

```
SUMMARY checks=21 failed=0 consoleErrors=0
T31_REGRESSION_EXIT:0
```

（本次 T31 回归脚本改了一处选择器：InboxPage 空态里也有「设置页添加账号」按钮，
keep-alive 面板里隐藏但仍存在，断言改为只点可见元素。）

## 门禁（T66 结束时观察值）

| 命令 | 退出码 |
|---|---|
| `npm run typecheck -w @mailcollect/ui` | 0 |
| `npm run build`（根） | 0 |
| `npm run typecheck`（根全量） | 0 |
| `node evidence/ui/onboarding/capture-t66.mjs` | 0（12 PASS / 0 console error） |
| `node evidence/ui/onboarding/capture.mjs`（T31 回归） | 0（21 PASS / 0 console error） |

## 本次验证环境补充

UI 走 `apps/server` 的静态托管（`MAILCOLLECT_UI_DIR=apps/ui/dist`，端口 8899，全新
`MAILCOLLECT_DATA_DIR`），因此没有 vite dev 代理、也没有 favicon 404；浏览器仍是系统
Edge 156（Chromium 内核）。`navigations=1` 证明所有断言都在同一个页面会话里完成，
没有用刷新掩盖陈旧状态。


---

# T69 证据（设置页每账号签名 / 显示名编辑器）

采集时间：2026-11-09（Asia/Shanghai）· 采集人：`se-ui-onboarding`
脚本：`capture-t69.mjs` · 输出：`t69-*.png`

## 交付

`apps/ui/src/pages/SettingsPage.tsx` 的账号编辑区（按钮从「发信设置」改为「签名 / 发信」，
**所有 provider 都有**，Graph 账号只显示身份字段）：

1. 预填 `AccountView.signature` / `AccountView.displayName`（null → 空串）；
2. `maxLength` 与字符计数（`n / 2000`、`n / 200`）用 shared 常量做上限 —— UI 只允许
   `shared(types only)`（AGENTS.md §7），所以用 `typeof ACCOUNT_SIGNATURE_MAX_LENGTH`
   的**类型标注**镜像数值：shared 一改，本地常量就在 typecheck 报错，不会漂移；运行时
   不 import shared，避免把 zod 打进首屏 chunk（构建产物已确认无 zod 标记）；
3. 保存走 `PATCH /api/accounts/:id` 的 `send.signature` / `send.displayName`，**空串显式写 null**
   （服务端 `null = 清除`，读回 null）；`lib/api.ts` 只加了一个 UI 侧 `ClearableAccountSendInput`
   类型（类型跟随，无运行行为变化），因为 shared 的 `AccountSendInput` 目前仍是 `string`；
4. 「发信已配置」判定只看连接字段（smtpHost / ewsUrl）：只填签名/显示名时账号行仍是
   「发信：未配置（只收不发）」，身份信息单独显示；
5. 签名与发送端同源：撰写页的「附加账号签名」勾选只负责开/关，签名正文由
   `apps/server/src/routes/send.ts` 从同一份 `config.signature` 追加（单源，不会两处不一致）。

## 采集结果（观察值）

```
SUMMARY checks=20 failed=0 consoleErrors=0 benignEnv=6
T69_CAPTURE_EXIT:0
```

| 断言 | 结果 |
|---|---|
| 准备好一个无发信连接的 IMAP 账号 | PASS |
| 账号行有「签名 / 发信」入口 | PASS |
| 仅签名未设置时「发信：未配置」不变 | PASS |
| 账号行显示签名/显示名状态 | PASS |
| 签名输入框 maxLength = 2000（来自共享常量） | PASS |
| 显示名输入框 maxLength = 200 | PASS |
| 输入 2100 字符被前端拦在 2000 | PASS（`value.length=2000`） |
| 字符计数提示与上限一致 | PASS（`2000 / 2000`） |
| 保存后仍显示「发信：未配置」（仅签名不算配好连接） | PASS |
| 保存后账号行显示签名已设置 / 显示名 | PASS（签名 23 字） |
| 服务端读回 signature / displayName | PASS（`"——\n李四\nlisi@corp.example"` / `"李四（公司）"`） |
| 仅身份字段时 `send` 仍为 null | PASS |
| 重进页面后签名 / 显示名预填 | PASS |
| 密码类输入框不回显 | PASS（`token-input` / `smtp-password` / `llm-key` 全空） |
| 清空后服务端 signature / displayName 读回 null | PASS |
| 清空后账号行回到「签名 未设置 / 显示名 账号地址」 | PASS |

`benignEnv=6` 是本脚本故意用不存在的主机（`imap.corp.example`）建测试账号后，
InboxPage 拉 `/api/folders` 收到的 502；属于环境事实，已在脚本里按 URL 归类，
不计入 console error。

## 截图

| 文件 | 路径 |
|---|---|
| `t69-01-account-row.png` | 账号行：签名未设置、发信未配置 |
| `t69-02-maxlength-2000.png` | 输入 2100 字符被拦在 2000，计数 2000 / 2000 |
| `t69-03-saved.png` | 保存后：签名 23 字、显示名 李四（公司），发信仍未配置 |
| `t69-04-prefilled-after-reload.png` | 整页重载后重进编辑器：签名/显示名预填 |
| `t69-05-cleared-null.png` | 清空保存后：读回 null，账号行回到未设置 |

## 门禁（T69 结束时观察值）

| 命令 | 退出码 |
|---|---|
| `npm run typecheck -w @mailcollect/ui` | 0 |
| `npm run build -w @mailcollect/ui` | 0 |
| `npm run build`（根） | 0 |
| `npm run typecheck`（根全量） | 0 |
| `capture-t69.mjs` | 0（20 PASS / 0 console error） |
| `capture.mjs`（T31 回归，全新库） | 0（21 PASS / 0 console error） |
| `capture-t66.mjs`（T66 回归，全新库） | 0（12 PASS / 0 console error） |
