# MailCollect UI Design System

## 0. Research Log

- Embedded refs: 设计方向由用户亲自指定（`docs/requirements.md` §4：圆角矩形 + 毛玻璃 + 浅蓝基底），
  作为视觉契约直接采纳；Layer B 品牌参考库仅挂载了索引与 asis 单文件，未挂载 taste 风格库，
  因此不套用其他品牌 Token —— 记录为一次有意的替代（substitution），不是遗漏。
- Lazyweb / Imagen: 跳过 —— 本机无浏览器与图像生成工具，且用户已给出完整 Token 契约。
- 参考实现约束: dhtmlx-gantt 10 Community（MIT）只在 Community 能力内定制，PRO 专属
  （deadline 元素、export、auto-scheduling）一律不用；到期标记用自定义 task layer 绘制。

## 1. Atmosphere & Identity

清晨的玻璃书桌：浅蓝空气、磨砂玻璃、圆润边角。界面像一层层半透明的亚克力板浮在
淡蓝渐变上，信息靠色阶与留白分层，而不是靠边框和线。签名的视觉母题是「一片被晨光
打亮的磨砂玻璃」——所有卡片都有 1px 高光边与轻微下沉的阴影，页面顶部两团柔光让玻璃
有真实的透光感。整体克制、安静、密度适中，不用纯白大面积、不用粗黑边框、不用表格线。

## 2. Color

### Palette

| Role | Token | Light | Usage |
|------|-------|-------|-------|
| Canvas/base | --bg-gradient | #EEF5FD → #DBEAFE | 应用底色（160deg） |
| Surface/glass | --glass-bg | rgba(255,255,255,.62) | 毛玻璃卡片、侧边栏 |
| Surface/raised | --surface-raised | rgba(255,255,255,.78) | 输入框、浮层 |
| Text/primary | --text-primary | #0F2540 | 标题、正文 |
| Text/secondary | --text-secondary | #5B7290 | 说明、元信息 |
| Text/tertiary | --text-tertiary | #8CA2B9 | 占位、禁用 |
| Accent/primary | --accent | #2F7CF6 | 主按钮、选中、链接 |
| Accent/hover | --accent-strong | #1E67DC | 主色 hover/active |
| Accent/wash | --accent-soft | rgba(47,124,246,.12) | 选中底色、聚焦环 |
| Status/success | --success | #1E9E71 | 已完成、验证通过 |
| Status/warning | --warning | #C9803A | 待确认、提醒 |
| Status/danger | --danger | #D45B63 | 忽略、错误 |
| Status/iris | --iris | #6C7CF5 | 群发/广播语义（唯一第二色相） |
| Status/today | --today | #E4705F | 今日线、到期点 |

### Rules

- 主色只出现在「最可能的动作」与选中态上；群发语义固定用 iris，其余不加装饰色。
- 所有颜色必须走 Token；组件里不写裸 hex。
- 状态用 tonal wash + 图形标记表达，不用彩色侧边条。

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| Page title | 26px | 700 | 1.25 | 每页主标题 |
| Card title | 17px | 650 | 1.4 | 卡片标题 |
| Body | 14px | 400 | 1.65 | 正文、邮件正文 |
| Body/sm | 13px | 400 | 1.55 | 列表摘要、说明 |
| Caption | 12px | 500 | 1.4 | 元信息、标签 |
| Overline | 11px | 650 | 1.3 | 分区标签（字距 .06em） |

### Font Stack

- Primary: `system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
- Mono: `"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace`（仅路径/ID）

### Rules

- 正文不小于 13px；标题不靠超大字重制造层级，用色阶与留白。

## 4. Spacing & Layout

### Base Unit

4px。Token：`--space-1` 4 / `-2` 8 / `-3` 12 / `-4` 16 / `-5` 20 / `-6` 24 / `-8` 32 / `-10` 40。

### Shell

- `grid`：侧边栏 256px + 主区 `minmax(0,1fr)`；间距 16px；四周内边距 16px。
- 高度用 `100dvh`；主区滚动容器 `min-height:0; overflow:auto`，顶栏与侧边栏固定。
- ≤1180px 侧边栏收为 84px 图标轨；≤900px 改为顶部横向导航 + 单列主区；
  ≤980px 收件箱列表/详情改为单栏切换（详情打开时列表隐藏）。

### Scroll ownership

- 页面内容由 `.page-scroll` 唯一拥有纵向滚动；邮件列表由 `.mail-list` 独立滚动（有自己的职责）。
- 甘特图内部滚动属于 dhtmlx-gantt 自身（`.gantt_host` 有界高度）。

## 5. Components

| Component | Reuse | Notes |
|-----------|-------|-------|
| GlassCard | 4 页 | 20px 圆角、毛玻璃、1px 高光边；`padding` 可调 |
| Sidebar | 全局 | 品牌 / 导航 / 档案与连接状态 |
| TaskCard | 待办、时间线侧栏 | 标题、证据引用、时间胶囊、动作组 |
| BroadcastPrompt | 待办 | 群发提醒卡：加入待办 / 忽略 / 记住列表 |
| GanttChart | 时间线 | dhtmlx-gantt 10 + 自定义 task layer 画到期点 |
| EmptyState | 4 页 | 渐变光球 + 图标 + 标题 + 说明 + 可选动作 |
| Button / Input / Chip | 全局 | 14px / 10px 圆角，状态齐全 |

### States

- hover：背景提高一档亮度，位移 ≤1px；active：缩到 .99；focus-visible：3px 主色 35% 环。
- 禁用：`opacity:.5; pointer-events:none`。
- 空状态、加载（骨架 shimmer）、错误（toast + 重试）三种必须都有。

## 6. Motion

- Token：`--dur-fast` 140ms / `--dur-base` 220ms / `--dur-slow` 320ms，`--ease-out: cubic-bezier(.22,.61,.36,1)`。
- 只动 `transform` / `opacity`；列表入场 `rise` 8px，交错 40ms，一次性。
- `prefers-reduced-motion: reduce` 关闭全部入场动画与过渡。

## 7. Depth & Radius

- 圆角：大卡片 20px、控件 14px、标签 10px、胶囊 999px（嵌套同心：卡片内元素 ≤ 卡片 - 4）。
- 阴影：卡片 `0 8px 28px rgba(31,86,160,.12)`；轻浮层 `0 2px 10px rgba(31,86,160,.07)`；
  覆盖层 `0 16px 44px rgba(31,86,160,.16)`。禁止重阴影/黑色阴影。
- 玻璃：`rgba(255,255,255,.62)` + `backdrop-filter: blur(18px) saturate(1.4)`，
  配 1px `rgba(255,255,255,.8)` 高光边 + 顶部白色微渐变高光。

## 8. Accessibility Constraints & Accepted Debt

- 正文对底色的对比度 ≥ 4.5:1（#0F2540 on #DBEAFE ≈ 12:1）；次级文字 ≥ 4.5:1。
- 键盘可达：导航、列表项、按钮均为原生 button/a；可见 focus ring；图标按钮有 `aria-label`。
- 布局在 390px 宽可单列回流，无横向滚动；长标题截断 + `overflow-wrap:anywhere`。
- 已接受的债：
  1) 未做深色主题（v1 只有浅蓝）。
  2) 邮件列表未上虚拟滚动（MVP 数据量 < 200，普通滚动 + 分页游标）。
  3) 无浏览器环境，未跑 `/visual-qa` 的截图矩阵；以构建门禁 + 静态复核代替，转交验证者。
