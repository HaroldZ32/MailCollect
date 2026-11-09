# T33 证据 — 规则面板 / 树形条件编辑器 / 分类管理

Cell `cell-20261109T021707097Z` · Board task `T33` · Contract `.mpd/cellwork/cell-20261109T021707097Z/contracts/ui-rules.md`
Writer: `se-ui-rules`（Senior Engineer）· 独立验证：Reviewer（`review-ui-rules`）

## 交付物

| 路径 | 内容 |
|---|---|
| `apps/ui/src/pages/RulesPage.tsx` | 规则面板：规则列表（拖拽 + ↑/↓ 排序、启停、编辑/删除）、新建/编辑弹层、重算进度（SSE + 兜底轮询）、空态/错误态 |
| `apps/ui/src/components/RuleTreeEditor.tsx` | 树形条件编辑器：AND/OR/NOT + 括号分组、字段叶子（21 字段 / 19 操作符，含 `wholeWord`）、语义叶子、深度 ≤ 8 限制与提示、本地逐节点校验（镜像 shared `RuleIssueCode`） |
| `apps/ui/src/components/CategoryManager.tsx` | 分类增删改、`enterTodo` / `broadcast` 开关、删除非空分类的 409→原文确认流程、「未分类」只读 |
| `apps/ui/src/lib/api.ts` | **captain 授权的附加修改**：仅 `api.categories.remove` 增加可选 `{confirm}` 并追加 `?confirm=true`；其余不动 |
| `evidence/ui/rules/capture.mjs` | 可复跑的 47 项断言 + 截图脚本 |

未改 `apps/ui/src/pages/InboxPage.tsx`（收件箱分类多选筛选由 ui-mail 负责；本次运行时已观察到其 `categoryIds` ANY 筛选与多徽章渲染存在，非本任务写域）。

## 如何复跑

前置（一次性数据目录；脚本的空态阶段会删除种子，删除后服务端不会重播）：

```bash
MAILCOLLECT_PORT=8787 MAILCOLLECT_TOKEN=dev-local-token \
  MAILCOLLECT_DATA_DIR=$(mktemp -d) node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts
(cd apps/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort)

# 写入档案（触发「点名给我」种子）+ onboarding 完成
curl -X PUT -H 'authorization: Bearer dev-local-token' -H 'content-type: application/json' \
  -d '{"displayName":"张三","aliases":["San Zhang"],"emails":["zhangsan@corp.example"],"timezone":"Asia/Shanghai"}' \
  http://127.0.0.1:8787/api/profile
curl -X PUT -H 'authorization: Bearer dev-local-token' -H 'content-type: application/json' \
  -d '{"completed":true}' http://127.0.0.1:8787/api/onboarding

PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" node evidence/ui/rules/capture.mjs
```

最近一次运行（2026-11-09，本机）：`SUMMARY checks=47 failed=0 consoleErrors=0 (error-state expected: 3)`，退出码 0。
预期内的 3 条 console 记录：错误态页面故意注入的 1 条 500，以及删除非空分类第一次不带 `confirm` 必然得到的 2 条 409（Chrome 会把 4xx 资源记为 console error）。

## 截图索引

| 文件 | 证明 |
|---|---|
| `01-rules-list.png` | 规则列表 + 分类管理 + 「未分类」只读行；种子规则带「内置」 |
| `01b-category-form.png` / `01c-category-form-filled.png` | 分类表单：名称 + `enterTodo` / `broadcast` 开关 |
| `01d-category-duplicate.png` | 重名分类的表单内错误提示 |
| `02-editor-default.png` | 新建规则默认单条件（深度 0/8） |
| `03-editor-tree.png` | 与 / 或 / 非 + 括号 + 语义叶子 + 整词匹配；表达式预览 |
| `04-editor-invalid.png` / `04b-editor-invalid-summary.png` | 非法输入：叶子旁逐节点错误 + 汇总 + 保存被拦下 |
| `05-saved-toast.png` | 保存成功 + 服务端自动重算进度 |
| `06-editor-reopen-roundtrip.png` | 重新打开编辑器，公式与保存前一致（API 往返一致） |
| `06b-recompute-banner.png` | 「重新计算标签」触发后台重算进度 |
| `06c-rule-delete-confirm.png` | 删除规则的二次确认 |
| `07-depth-limit.png` / `07b-depth-limit-hint.png` | 深度 8/8；最深分组的「与分组 / 或分组 / 否定 / 非」禁用 + 「已达最大嵌套深度 8」 |
| `08-category-delete-confirm.png` | 非空分类删除：服务端 409 原文（含「连带删除 1 条规则与 0 封邮件」）+ 取消/确认 |
| `09-category-deleted.png` | 确认后分类与其规则消失 |
| `10-narrow-list.png` / `11-narrow-editor.png` | 820px 单列布局与编辑器换行 |
| `12-phone-list.png` | 560px 不白屏、列表仍可读 |
| `13-empty-rules.png` / `14-empty-categories.png` | 空态可见文案 |
| `15-error-state.png` | 加载错误态：失败原因 + 重试 |

## 关键断言（脚本输出摘要）

- 编辑器渲染出 `and` / `or` / `not` 节点；公式含括号、且、或、非；
- 操作符下拉提供 `wholeWord`，并显示「Li 不命中 Lion；中文按子串」；
- 空值 + 空语义叶子保存被拦下（2 个问题，逐节点显示）；
- 保存后 API 树与提交树结构性深比较一致；重新打开公式一致；
- 服务端接受深度 8（201）、拒绝深度 9（400 `depth_exceeded`）；编辑器在深度 8 禁用继续嵌套；
- UI 启停开关、↑ 按钮、HTML5 拖拽都写入服务端并持久化；
- 分类：UI 新建/改名/行内开关/删除空分类均落库；重名被拦；
- 非空分类删除：第一次 409 → 原文确认框 → 取消不写入 → 确认后分类与规则连带删除；
- 规则目标下拉不含「未分类」；「未分类」行无任何编辑/删除控件。

## 门禁（本机观测）

```
npm run typecheck -w @mailcollect/ui   → exit=0（tsc --noEmit，无输出）
npm run build -w @mailcollect/ui       → exit=0（vite build：✓ built in 342ms；仅有 chunk >500kB 的既有警告）
npm run typecheck                      → exit=0（desktop/server/ui/core/shared 全部通过）
```

日志：`typecheck.log`、`build.log`（本目录）。

## 验证的边界 / 未证明项

1. **视觉自检不是独立验证**：本席写完后用 Playwright 逐页看截图并做了 1440 / 820 / 560 三档检查；按验证法，独立视觉评审仍应由 Reviewer 完成（写者不能给自己出 PASS）。
2. **UI 工作区没有测试框架**：`apps/ui` 无 `test` 脚本，本任务不声称任何自动化单测覆盖；上面的行为断言是端到端脚本。
3. **服务端 400 的逐节点映射**只做了代码路径：本地校验镜像了 shared 的 issue 路径/代码，先于请求拦下非法树；服务端 400 文案会被解析回逐节点（格式不符时原样展示整条文案）。未构造出“本地通过、服务端拒绝”的用例（两边语义一致）。
4. **空分类删除不弹确认**：服务端对空分类不带 `confirm` 直接删除（契约如此）；只有非空分类走 409→确认。
5. **种子规则可编辑**：服务端允许改/删且删除后不重播（`docs/upgrade-v1.1.md` §4）；UI 用「内置」徽标 + 编辑框内说明表达这一点，没有把它做成只读。
6. **收件箱多标签/多选筛选**：属于 ui-mail 写域，本次仅观察到已存在，未由本席修改或验证。
7. `capture.mjs` 每个数据目录只能跑一次（空态阶段会删掉种子；服务端不会重播）。
