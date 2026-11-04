# MailCollect — 需求与验收标准

> 版本 v1 · 2026-11-04 · 单用户本机版（数据模型按多用户设计）

## 1. 目标

把邮箱里"需要我本人去做的事"自动抽出来，区分「点名给我的」和「群发广播」，
把有时效/时段要求的自动排成甘特图。桌面优先，一套代码覆盖 Web / Win / macOS / Linux，
预留云同步接口。

## 2. 非目标（v1 明确不做）

- 不做邮件客户端本身（不替代 Foxmail/Outlook，只做"待办抽取"这一层）
- 不做邮件发送/回复（只读）
- 不做 EWS 适配器（微软正在退役，Exchange Online 走 Graph、本地 Exchange 走 IMAP）
- 不做真实云同步服务端（只留 `changes(since)` 接口与 outbox）
- 不做多用户登录（表结构预留 `user_id`）

## 3. 功能需求

### R1 多 LLM 接入
- 用户自带 Key。至少支持：OpenAI 兼容端点（DeepSeek / Kimi / 通义 / 任意兼容商）、
  Anthropic（其官方 OpenAI 兼容层）、Ollama 本地。
- 单一 `LlmPort` 抽象，供应商可切换、可配置 baseURL/模型名/超时/重试。
- 允许配置一个"外部网关 baseURL"（one-api / LiteLLM），填地址即用，不改代码。
- 结构化输出必须有 **修复重试**：DeepSeek json 模式可能返回空白且 `finish_reason=stop`，
  必须当作可重试解析失败，绝不当成"没有待办"。

### R2 邮件自动收集
- 适配器：IMAP（imapflow，含 IDLE 增量）、POP3（node-pop3，只读拉取 + UIDL 去重）、
  Microsoft Graph（设备码登录）。
- 增量同步：记录游标（IMAP UIDVALIDITY+UID / POP3 UIDL / Graph deltaLink），
  重复同步不产生重复邮件。
- 凭据加密落盘（本机密钥），日志与错误信息不得包含密码/Token。

### R3 按姓名精准识别待办
- 用户档案：姓名 + 邮箱别名列表（多邮箱、多写法）。
- 抽取结果必须给出：`owner ∈ {me, other, unassigned, everyone}` + 原文证据引用。
- 只有 `owner = me` 才进入"待办"；`other` 只记录不打扰；`unassigned` 进候选区。

### R4 群发/广播单独处理
- 判定在**代码层**先做，不交给模型：RFC 2369（List-*）、RFC 2919（List-Id）、
  RFC 3834（Auto-Submitted）、`Precedence: bulk/list`、To/Cc 基数、
  用户是否在 To（而非仅 Cc）、no-reply 发件人、去重正文哈希。
- 三态输出 `personal | broadcast | uncertain`。
- `broadcast` 不自动进待办：以卡片形式提醒"这是群发，可能与你有关"，
  由用户点「加入待办 / 忽略」，并记住决定（同一 List-Id 可批量套用）。

### R5 时效与甘特图
- 模型只返回**时间短语**（"周五下班前"、"下周一至周三"），
  由 `chrono-node` 结合邮件 `Date` 头 + 用户 IANA 时区确定性地解析。
- 结果存 `{phrase, resolved_utc, timezone, confidence}`。
- 甘特图：拖拽改期、缩放改时长、依赖箭头；支持 touch。
  数据源为 `window_start/window_end/due_at`。

### R6 一端开发全端部署
- 单一 React 前端 + 单一 Hono 服务端（业务逻辑在 `packages/core`）。
- 桌面：Electron 外壳托管本地服务；Web：同一服务部署在服务器；
  移动：PWA 指向同一服务（后续可加 Tauri 2 mobile 外壳）。
- 前端只通过 HTTP/SSE 与服务通信，不存在第二套传输层。

### R7 预留云同步接口
- 所有写操作落 `change_log(seq, entity, entity_id, rev, device_id, op, payload, ts)`。
- 对外暴露 `SyncPort.changes(since) -> ops[]`，v1 只做本地实现。
- 将来接 ElectricSQL / PowerSync / Turso Sync 是加适配器，不是重写。

## 4. 界面规范（用户指定方向）

- 圆角：大卡片 20px、常规控件 14px、小标签 10px
- 毛玻璃：`background: rgba(255,255,255,.62)` + `backdrop-filter: blur(18px) saturate(1.4)`
- 浅蓝基调：底色 `#EEF5FD → #DBEAFE` 微渐变；主色 `#2F7CF6`；文字 `#0F2540` / 次级 `#5B7290`
- 阴影极轻：`0 8px 28px rgba(31,86,160,.12)`
- 禁止：纯白刺眼大背景、粗黑边框、密集表格线、系统默认灰按钮

## 5. 验收标准（可测）

1. 配置一个真实 IMAP 账号 → 点同步 → 30 秒内列表出现邮件，重复同步不重复。
2. 输入姓名后跑抽取 → 得到带证据引用的待办条目；广告/群发不混进"我的待办"。
3. 一封含"周五前提交"的邮件 → 甘特图出现一根可拖动、可改时长、带到期标记的条。
4. 群发邮件 → 出现在"待确认"卡片区，点忽略后不再出现。
5. 5 个 LLM 供应商中任选 2 家切换，抽取结果结构一致（同一 Zod schema 校验通过）。
6. `pnpm typecheck` 与 `pnpm test` 全绿。
7. 桌面应用冷启动 < 5 秒；断网时已同步数据仍可浏览。
