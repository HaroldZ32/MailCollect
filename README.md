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

## 打包与分发

### 三端各自的命令

```bash
npm run dist:linux        # AppImage（Linux 本机可直接交叉，已验证）
npm run dist:win          # NSIS 安装包——需要 Windows 或 wine，见下
npm run dist:mac          # dmg——必须在 macOS 上打
```

### Windows 端怎么拿

**路线 A：GitHub Actions（推荐，能出正经安装包）**

仓库里已经放好 `.github/workflows/build.yml`：推一个 `v*` 标签，或在 Actions 页面手动
Run workflow，三端安装包会一起构建并作为 artifact 上传。Windows 那台 runner 是原生
Windows，NSIS 安装器不需要 wine。

**路线 B：在 Linux 上出一个免安装的 zip（不需要 wine）**

```bash
npm run dist:win:portable
# → apps/desktop/release/MailCollect-win-portable-x64.zip（解压后双击 mailcollect.exe）
```

原理：electron-builder 能在 Linux 上完成 `win-unpacked`（含 `mailcollect.exe` 与
`resources/app.asar`），只有最后把它包成 NSIS 安装器那一步要调 `wine` 里的 `elevate.exe`。
所以「免安装 zip」可交叉，「安装程序」不能。

**路线 C：在 Windows 机器上直接打**

```powershell
git clone <repo> && cd MailCollect
npm install
npm run dist:win     # 产出 apps/desktop/release/MailCollect Setup 0.1.0.exe
```

### 两个已知事项

- **未签名**：没有代码签名证书时，Windows 首次运行会弹 SmartScreen「未知发布者」。
  要消除就配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 两个 secret（workflow 已经接好）。
- **图标**：目前用 Electron 默认图标。放一个 `build/icon.ico`（Windows）/
  `build/icon.icns`（macOS）/ `build/icon.png`（Linux）到 `apps/desktop/` 即可替换。

### 数据放在哪

- Windows：`%APPDATA%\MailCollect\data\`（SQLite + `secret.key` + Graph token 缓存）
- macOS：`~/Library/Application Support/MailCollect/data/`
- Linux：`~/.config/MailCollect/data/`

## 许可证

本仓库采用 **GPL-3.0**（见 `LICENSE`，与 GitHub 仓库创建时选择的许可证一致）。

依赖许可证均与之兼容：React / dhtmlx-gantt Community / imapflow / chrono-node 为 MIT，
Vercel AI SDK 与 Hono 为 Apache-2.0。注意 GPL-3.0 是强著佐权：对外分发二进制时
必须同时提供对应源码；若日后要做闭源商业版本，需要替换协议或取得全部版权人同意。
