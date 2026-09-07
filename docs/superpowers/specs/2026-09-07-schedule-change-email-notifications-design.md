# 课表变更邮件通知设计

日期：2026-09-07

涉及仓库：

- `cqu-moe/auth`
- `cqu-moe/schedule-cloudflare`

## 目标

个人课表成功同步后，如果未来的课程或考试安排相对上一次成功同步发生了有意义的变化，向用户当前 Auth 已验证邮箱发送一封合并通知。

该功能是管理员可授予或撤销的权益；获得权益的用户在 Schedule 网站中自行决定是否开启。首次同步只建立基线，不发送通知。自动同步和手动同步使用相同规则。

## 已确认的产品规则

- Auth 管理 `calendar.change_notification` 权益。
- 用户开关位于 Schedule，而不是 Auth 设置页。
- 收件地址始终是 Auth 账户当前已验证邮箱，Schedule 不允许另填地址。
- 课程表与考试安排同时处理，并在同一次同步中合并为一封邮件。
- 只通知同步时尚未结束的未来事件。
- 邮件必须显示具体年月日、星期和时间，不能只显示教学周。
- 首次成功同步只建立基线。
- 用户关闭通知或权益被撤销时仍更新基线，因此重新开启或重新授权后不补发历史变化。
- 不使用通知 Outbox；Queue 入队失败时保留旧通知基线，下次成功同步重新计算并尝试发送。

## 架构与职责

### Auth

1. 在能力目录中增加 flag：

   ```text
   calendar.change_notification = 课表变更邮件通知
   ```

2. 将该 flag 纳入 `CalendarCaps` 和 `getCaps()` 的 calendar 切片。现有权益管理台和权益预设无需新增一套管理机制。
3. 作为 `schedule-notifications` Cloudflare Queue 的唯一 Consumer。
4. 消费消息时：
   - 校验消息版本、字段类型和长度；
   - 重新读取用户当前权益，撤销后直接丢弃；
   - 查询 Better Auth user，要求用户存在、邮箱非空且 `emailVerified=true`；
   - 固定发件人为 `重庆大学课表 <noreply@cqu.moe>`；
   - 使用现有 Resend 密钥发送 HTML 与纯文本正文；
   - 使用稳定通知 ID 作为 Resend idempotency key；
   - 成功后 ack，网络、限流和 5xx 错误 retry，永久输入错误 ack 并记录错误类别。

Auth 不接受消息中的收件地址，也不允许消息改变发件人。

### Schedule

1. 在 Dashboard 顶部的自动同步状态附近显示“课表变更通知”开关。
2. 只有 `caps.calendar.change_notification=true` 时显示开关；用户开启时服务端再次检查权益。
3. 保存用户选择和最近通知基线。
4. 个人课表 harvest 成功后，对同一用户只执行一次课程与考试差异计算。
5. 满足权益、用户开关和有效差异时，渲染已确认的邮件模板并向 `schedule-notifications` Queue 入队。
6. Queue 接受消息后更新通知基线；入队失败只记结构化日志并保留旧基线，不改变同步成功状态。

Schedule 是 Queue Producer；Auth 是 Queue Consumer。消息中不包含邮箱。

## Schedule 数据模型

只新增一张表 `notification_state`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | TEXT PRIMARY KEY | Auth `user.id` |
| `enabled` | INTEGER NOT NULL DEFAULT 0 | 用户开关 |
| `snapshot_json` | TEXT | 上次成功处理的规范化课程与考试快照 |
| `snapshot_hash` | TEXT | 规范化 JSON 的 SHA-256 |
| `created_at` | TEXT NOT NULL | ISO 时间 |
| `updated_at` | TEXT NOT NULL | ISO 时间 |

该快照包含当前 harvest 返回的完整个人课程和考试数据，不依赖用户是否创建了 `personal_all`、`personal_courses` 或 `personal_exams` 中的某一条订阅。

## 用户 API

### `GET /api/v2/notification-settings`

需要当前 Schedule 登录会话，返回：

```json
{
  "eligible": true,
  "enabled": false
}
```

`eligible` 来自当前 session caps；没有状态行时 `enabled=false`。

### `PUT /api/v2/notification-settings`

请求：

```json
{
  "enabled": true
}
```

- `userId` 只取当前 session，不接受客户端传入。
- 开启时必须具有 `calendar.change_notification` 权益，否则返回 403。
- 关闭始终允许并保持幂等。
- 更新开关不清空快照。

## Queue 消息契约

```ts
interface ScheduleNotificationMessageV1 {
  version: 1;
  notificationId: string;
  userId: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
}
```

建议限制：`notificationId <= 128`、`userId <= 128`、`subject <= 200`、`html <= 100 KiB`、`text <= 50 KiB`，总消息显著低于 Queue 限制。Auth 对消息执行运行时校验，不能只依赖 TypeScript。

通知 ID 由协议版本、用户 ID、旧快照 hash 和新快照 hash 确定性生成。相同差异即使重复入队，也得到相同 Resend idempotency key。

## 规范化与差异算法

### 快照

快照版本为 1，包含：

- `semesterStart`
- 规范化、稳定排序的 `courses`
- 规范化、稳定排序的 `exams`

字符串去除首尾空白；周次数组去重并升序；课程和考试数组按稳定字段排序。只因 API 返回顺序变化不会产生通知。

### 未来时间

- 课程使用现有 `calculateCourseEventTime()`，由 `semesterStart + teaching week + day_of_week + TIME_SLOTS` 展开具体开始和结束时间。
- 考试使用现有 `start_time`、`end_time`。
- 只保留结束时间严格晚于本次同步时刻的事件。
- 所有展示按中国时区格式化为具体日期、星期和时间。

### 课程匹配

上游数据没有稳定课程 ID，因此采用保守匹配：

1. 先按课程名与实验内容分组。
2. 组内优先匹配教学周重叠最多的旧、新课程行。
3. 若不存在教学周重叠，仅在教师相同且时间位置足够接近时匹配。
4. 不能可靠匹配时显示“原课程取消 + 新课程加入”，不猜测为调整。

匹配后比较教师、地点、星期、节次和教学周：

- 星期或节次变化：时间调整；
- `room` / `position` 变化：地点调整；
- 教师或实验内容变化：信息调整；
- 教学周新增：新增对应具体日期；
- 教学周删除：取消对应具体日期。

### 考试匹配

1. 按考试名称分组。
2. 同名多项时选择开始时间最接近的旧、新记录。
3. 比较日期、开始时间、结束时间、地点和座位。
4. 无匹配记录分别视为新增或取消考试。

### 合并与截断

- 一次用户 harvest 最多生成一封邮件。
- 邮件按“课程表”和“考试安排”分组。
- 同一课程最多展示 5 个具体受影响日期，其余显示“另有 N 个日期”。
- 邮件不得包含学号、日历 token、CQU 凭据或完整原始 API 响应。

## 同步时序

1. 读取用户现有 `notification_state`。
2. 完成个人 harvest，生成规范化新快照和 hash。
3. 正常写入所有现有个人订阅的 ICS / courses / exams 数据。
4. 没有旧快照：写入新快照，不发送。
5. 快照 hash 相同：更新 `updated_at`，不发送。
6. 通知关闭或权益不可用：写入新快照，不发送。
7. 计算仅包含未来事件的差异；无有效差异时写入新快照，不发送。
8. 有差异时渲染 subject、HTML、text，调用 Queue `send()`。
9. Queue 接受后写入新快照；入队失败时保持旧快照并记录 `queue.schedule_notification.enqueue_failed`，但同步仍为 success。

同一 batch 中若存在同一用户的多条个人订阅消息，通知计算必须通过 userId 级 single-flight 合并。稳定通知 ID 和 Resend 幂等键作为第二道去重。

## 邮件设计

- 主题：`课表与考试安排有更新`，可附变化数量。
- 单栏、600–620px、表格布局、关键样式内联，兼容常见邮件客户端。
- 使用简洁事务通知风格，不使用统计卡、渐变、装饰图标或大号数字。
- 正文约 15px，日期和课程名约 16px，标题约 24px。
- 标题、分组标题、日期和课程名形成层级；新旧详情使用常规字重。
- 保留纯文本版本。
- 主操作只有“查看最新课表”；页脚提供“管理通知设置”。

已确认的视觉样稿位于当前 Codex 可视化目录中的 `schedule-change-email-preview.html`，实施时将其改为数据驱动模板。

## 失败处理

- Queue 入队前失败：保留旧通知基线，下次成功同步重新计算；不回滚课表数据。
- Queue 接受后：由 Queue 保证持久化和重试。
- Resend 网络错误、429、5xx：retry。
- 非法消息、用户不存在、邮箱未验证、权益已撤销：ack 并记录原因。
- 用户关闭开关只影响尚未生成的新消息；已经被 Queue 接受的消息仍可能发送。
- 日志只记录通知 ID、用户 ID、事件名和错误类别，不记录完整邮箱、课程内容或 HTML。

## 测试

### Schedule

- 课程日期展开、中国时区、结束边界和过去事件过滤。
- 规范化对顺序、重复周次和首尾空白不敏感。
- 课程新增、取消、时间、地点、教师、实验内容和周次变化。
- 考试新增、取消、时间、地点和座位变化。
- 同名课程和同名考试的保守匹配。
- 首次同步不发；无差异不发；关闭不发；无权益不发。
- 自动、手动同步都能发送；个人三订阅合并为一封。
- 入队成功后更新基线；入队失败保留旧基线且同步仍成功。
- 设置 API 的 session 所有权、开启权益门和幂等关闭。
- Dashboard 的显隐、开关保存、失败回滚和无障碍标签。
- HTML / text 模板包含具体日期、两个分组和管理链接。

### Auth

- Queue 消息运行时校验和大小限制。
- 权益撤销、用户不存在、邮箱未验证时不发送。
- 收件地址只来自 Auth user，忽略消息中任何额外字段。
- 固定发件人、稳定 idempotency key、HTML 与 text 同时发送。
- 临时错误 retry；永久错误 ack。

### 验证门

- 两仓相关单元和集成测试。
- 两仓 TypeScript typecheck。
- Auth 与 Schedule 前端构建。
- Auth 前端测试和 Schedule 前端测试。
- 检查迁移、Wrangler Queue producer / consumer 配置和最终 git diff。

## 上线顺序

1. 先发布 Auth：权益目录、Queue Consumer 和邮件发送。
2. 再发布 Schedule：D1 migration、设置 UI、差异逻辑和 Queue Producer。
3. 仅给受控账户授予权益，完成一次真实同步和实际收件验收。
4. 实际发信是外部动作，执行受控验收时明确目标账户，不向全体用户自动开放。

常规部署遵循各仓现有流程：Auth 通过 GitHub Actions，Schedule 通过 Cloudflare Git Connector。除非连接器不可用或用户明确要求，不额外手动 deploy。
