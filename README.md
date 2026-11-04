# MailCollect

把邮箱里「需要我本人去做的事」自动抽出来：区分点名给我的待办与群发广播，
把有时效/时段要求的事项自动排成甘特图。桌面优先，一套代码同时供 Web / Windows /
macOS / Linux 使用，并预留云同步接口。

## 为什么不直接用现成的开源项目

2026-11 在 GitHub 上逐字核对了 6 个候选（star ≥ 100）：

| 项目 | ★ | 许可证 | 结论 |
|---|---|---|---|
| elie222/inbox-zero | 12,906 | AGPL-3.0 + 附加条款（禁止商业化；5 人以上组织需企业授权） | 不可商用，且无甘特图/按人抽取 |
| cloudflare/agentic-inbox | 8,592 | Apache-2.0 | 连不上现有邮箱，锁定 Workers，1 名贡献者 |
| dbish/DispatchMail | 188 | Apache-2.0 | Alpha，已停更 13 个月 |
| herald-mail-app | 148 | FSL-1.1 | 终端 TUI，2 年内禁竞争性商用 |
| NeatMail | 146 | Elastic License 2.0 | 禁托管服务，单模型，无甘特图 |
| aomail-app | 67 | AGPL + 禁转售 | 停更 19 个月 |

没有任何一个同时满足「商用无风险 + 功能完整 + 成熟」，且 6 个项目里 0 个有甘特图。

## 技术选型（许可证均已核实）

- 单代码库全端：**Electron 45 + React 19 + Vite 8 + TypeScript 7**
- 甘特图：**dhtmlx-gantt v10 Community（MIT）** — 唯一同时满足 MIT + 拖拽/缩放/依赖箭头 + iOS/Android 触控
- 邮件：**IMAP（imapflow）/ POP3（node-pop3）/ Microsoft Graph**，零厂商审核
- 多模型：**Vercel AI SDK 7（Apache-2.0）** + 单一 OpenAI 兼容适配器（DeepSeek / Kimi / 通义 / Claude 兼容层 / Ollama / one-api / LiteLLM 全通）
- 存储：**node:sqlite**（零原生模块）+ 追加式 `change_log` 作为云同步缝

## 结构

```
packages/shared   契约：领域类型 / LLM 输出 schema / HTTP API
packages/core     业务：mail 适配器 / pipeline / llm port / store / sync
apps/server       Hono HTTP+SSE，桌面与 Web 共用的唯一服务
apps/desktop      Electron 外壳（薄窗口，不含业务）
apps/ui           React 界面
```

## 快速开始

```bash
npm install
npm run dev            # 浏览器里看界面（:5173，mock 数据可直接演示）
npm run dev:server     # 只起 API（:8787）
npm run dev:desktop    # 起完整桌面应用
```

首次启动后到「设置」填写：姓名 + 邮箱别名 + 时区，添加一个 IMAP 账号，配一个 LLM Key。
