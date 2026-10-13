# 工作室本地开发协作契约

## 通用约定与权限

源码业务类型以 `src/types/studio.ts` 为准，外观和概览分别见 `src/types/appearance.ts`、`src/types/overview.ts`。业务金额为整数分，比例为万分比（5%=500），日期为 `YYYY-MM-DD`，时间为 ISO8601，统计使用 `Asia/Shanghai`。编号和游戏 ID 是字符串，不将前导零或长编号转为数值。

所有接口前缀 `/api/studio`。成功 JSON 直接返回对象，错误为 `{message}`；401 表示未登录/登录失败，403 表示无权限，409 表示状态、版本或备份凭据冲突，日志容量不足返回 503。认证采用 HttpOnly、SameSite=Lax cookie，前端 fetch 使用 `credentials:'same-origin'`。业务实体与审计在 SQLite `BEGIN IMMEDIATE` 事务中一并提交或回滚。

权限名称：`orders.view`、`orders.create`、`orders.edit`、`finance.review`、`finance.refunds`、`finance.withdrawals`、`finance.expenses`、`salary.view`、`salary.all`、`salary.manage`、`profit.view`、`users.manage`、`templates.manage`、`settings.manage`、`attendance.manage`、`logs.view`、`reports.export`。

默认权限与个人覆盖由服务端逐次计算，`bootstrap.roleDefaults` 是前端展示来源。老板和店长默认可看经营数据；财务默认有财务业务操作；普通管理员维护账号和配置，默认不开放财务、工资和利润。店长默认没有 `finance.review`，状态更正不扩大其验收或金额权限。超级管理员拥有全部权限，普通管理员不能维护超管。客服/客服主管即使个人覆盖 `reports.export=true` 也禁止导出，其他角色默认有导出权限，但仍只能导出其可见模块/字段。

## 会话、资料、外观与概览

| 方法 / 路径 | 请求 | 响应及约束 |
| --- | --- | --- |
| GET `/session` | 无 | `{user:Staff\|null}` |
| POST `/login` | `{username,password}` | `{user,maintenanceNotice?:string}`，成功设置 12 小时会话 cookie；密码错误或停用账号 401 |
| POST `/logout` | 无 | 撤销当前会话并清 cookie |
| GET `/bootstrap?month=2026-10` | 月份可选 | `StudioData`，工资、经营报告、人员、客户、日志等按当前权限投影 |
| POST `/profile` | `{name}` | 修改本人称呼 |
| POST `/profile/password` | `{currentPassword,newPassword}` | 验证旧密码后修改并撤销全部会话 |
| POST `/uploads` | `{name,mime,data:base64}` | `Attachment`，仅 PNG/JPEG/WebP，签名匹配且不超过 8 MB |
| GET `/uploads/:id` | 无 | 需登录及附件所有权/关联记录查看权限 |
| GET `/appearance` | 无 | 登录后读取共享 `AppearanceConfig`，bootstrap 也带此配置 |
| POST `/appearance` | `{config,revision}` | 需 `settings.manage`；保存后版本递增，版本冲突 409 |
| POST `/appearance/reset` | `{revision}` | 同上，恢复默认并留审计，不删除旧上传图片 |
| GET `/appearance/public` | 无 | 匿名仅返回 `{studioName,logo,login,glass}`；不返回业务背景、图标、版本或修改人 |
| GET `/public-assets/:id` | 无 | 匿名仅允许当前已保存 Logo 与已启用登录背景，其余 ID 404 |

外观允许指定模式、HEX 颜色、整数遮罩、预设图标、登录文案/背景和玻璃样式。图片必须为本站真实上传附件：新图片属于当前配置人，已有配置图片可继续复用；不能借用他人订单/金融凭证，不能传任意 URL、SVG、HTML 或 CSS。登录后的品牌图片和启用业务背景可共享下载，配置管理员可预览当前配置中的未启用图片；共享只用于下载，不授予业务附件复用权限。匿名投影图片 URL 使用 `/api/studio/public-assets/:id`。

GET `/overview?start=2026-10-07&end=2026-10-13` 返回 `OverviewReport`。有效日期为 1900-01-01 至 9998-12-31，开始不得晚于结束，最多 366 天。比较区间是紧邻上一同长区间；无法比较的零基数变化或无权限/无法核实指标为 null。普通区间经营利润不扣月度底薪，完整月份区间另提供扣底薪利润；当前钱包余额不做历史回溯或区间同比。收入、退款和订单成本回到原付款日；完成业绩与工资佣金按完成日期/月归属。

Staff/Customer 的可选 `createdAt` 仅在新建时保存真实时间，编辑保留原日期，旧档案未知时不补造。人员建档日期按人员权限投影；概览单独标明日期覆盖与未知数量。

## 来源配置与客户关联编号

POST `/platforms` 请求 `{id?,name,rules}`，`rules` 包含四个严格布尔值：`requiresShop`、`requiresExternalOrderNo`、`requiresReceipt`、`allowPayOnArrival`。POST `/shops` 请求 `{id?,platformId,name}`，POST `/levels` 请求 `{id?,name,delaySeconds}`；三者均需 `settings.manage`。所有平台均可建店铺，名称仅在同平台唯一；已被订单使用的店铺不能改平台。平台/等级名称保持各自唯一。

旧配置缺少 rules 时使用兼容默认：闲鱼需要店铺和平台编号、不强制凭证；游戏大厅需要凭证、允许落地付；其他平台需要凭证、不允许落地付。保存后以实际 rules 校验，不再硬编码下单来源。`operatorCommission` 仅作为旧字段兼容，不再作为新平台参与提成开关；非大厅工资 `platformRates` 为 0 表示不参与，null 为待配置，大厅运营提成始终固定 0。

POST `/customers` 请求 `{id?,name,contact,gameId,remark,platformId?}`，需 `orders.create` 或 `users.manage`。界面使用“客户名称”；主要来源可空，客户可跨来源下单。关联编号由独立接口逐条维护，不整体提交 refs 数组：

- GET `/customers/:id/order-references?current=1&size=20` -> `{records,total,current,size}`，size 最大 100；需客户查看权限。
- POST `/customer-order-references` `{customerId,platformId,shopId,externalOrderNo}` -> `CustomerOrderReference`。
- POST `/customer-order-references` `{customerId,id,action:'remove'}` -> `{ok:true}`。

维护关联需 `orders.create` 或 `users.manage`。仅要求平台编号的来源可添加，店铺按来源规则校验；同客户、平台、店铺、编号重复返回 409。编号不创建订单、不产生营收，无固定总条数上限。bootstrap 只带最近 20 条和 `orderReferenceCount`，完整列表分页读取；导出按授权读取全量。新增和删除分别记录独立审计，即使原关联已删除仍保留历史值。

POST `/templates` 新建/编辑订单模板需 `templates.manage`，省略 id 为新建。

## 订单和状态更正

POST `/orders` 需 `orders.create`。请求包含 `templateId customerId platformId shopId externalOrderNo roomCode gameId map amount reward remark dispatchMode assignedTo receivedAmount paidAt receipt payOnArrival?`。房间码/客户游戏 ID 至少一项；店铺、平台单号、凭证和落地付使用当前平台规则。普通订单派单前须全额收款。新建不接受沟通渠道录入，服务端 `channel=''`；历史字段保留，旧编辑接口可兼容旧 channel，但新界面不提供录入。

POST `/orders/:id/action` 支持：

| action | 主要字段 | 权限与状态 |
| --- | --- | --- |
| `edit` | roomCode/gameId/map/remark/amount/reward/reason | `orders.edit`，待接单/接单中/待验收可用；金额改动必须原因 |
| `confirm-payment` | receivedAmount/paidAt/receipt | `orders.edit`，不能重复确认或确认已取消订单 |
| `dispatch` | dispatchMode/assignedTo | `orders.edit`，仅待接单 |
| `release` | reason | `orders.edit`，仅接单中，保留解除历史 |
| `remark` | remark | `orders.edit` |
| `cancel` | reason | 普通状态 `orders.edit`，已完成订单取消需 `finance.review` |
| `review-pass` / `review-return` | 退回需 reason | `finance.review`，仅未审核的最新完成材料；验收不可重复 |
| `adjust` | amount/reward/reason | `finance.review`，仅完成/取消订单的金额更正 |
| `cancel-settle` | reward/teammateId/reason | `finance.review`，确认取消订单最终补偿，不能重复 |
| `correct-status` | status/reason/leaderId?/teammateId? | 财务、店长、老板、超管四类角色且 `orders.edit` |

`correct-status` 可选 pending/active/review/completed/canceled，必须说明原因。普通管理员即使覆盖授权 `orders.edit` 仍禁止。执行/验收/完成须真实启用的负责人；完成须足额收款；待验收须有效完成材料；执行状态还受接单上限限制。`teammateId:null` 明确清空队友，未提供则沿用原值。

已结算终态回退建立冲正扣补流水，不能裸改状态或抹去已付历史；超出可用余额的差额交人工处理。恢复只使用原负责人、队友和原报酬，保留原 completedAt/佣金月份；改结算人员或金额须另走财务差额处理，缺条件返回明确错误。已完成更正到待验收保留原材料审核历史，新增带 `recheckBy/recheckedAt/recheckReason/previousSubmissionId` 的复核材料，正常再次验收不重发奖励。

直接指定仍须打手接受，因此创建/派单后显示待接单是当前流程。后台没有代打手完成上报接口。双人固定平分报酬必须为偶数分。

## 退款、提现、费用与人工扣补款

- POST `/refunds` `{orderId,amount,reason}`：`finance.refunds` 可直接设 paid，`orders.edit` 可申请 pending；游戏大厅不提供退款流程。POST `/refunds/:id/action` `{action:'approve'|'reject'|'resolve',reason}` 需 `finance.refunds`。
- POST `/withdrawals/:id/action` `{action:'approve'|'reject'|'pay',reason?,receipt?}` 需 `finance.withdrawals`，发放须真实凭证，不可重复。
- POST `/expenses` `{category,amount,date,purpose,receipt}` 需 `finance.expenses`；POST `/expenses/:id/action` `{action:'delete'|'restore'}` 为软删/恢复并回改费用所属日利润。
- POST `/player-adjustments` `{userId,kind:'deduction'|'supplement',amount,reason,orderId?}` 需 `finance.withdrawals` -> `PlayerAdjustment`。
- POST `/player-adjustments/:id/action` `{action:'resolve',resolution:'recovered'|'waived',reason}` 同权限，仅未处理的人工差额，不能重复。
- POST `/reward-reviews/:id/action` `{action:'resolve',reason}` 同权限，为旧报酬更正人工差额保留处理说明。

`PlayerAdjustment` 记录 `id,userId,orderId,kind,amount,appliedAmount,manualAmount,status,reason,createdAt,createdBy,source?,resolution?,resolvedAt?,resolvedBy?,resolutionReason?`。`status` 为 applied/manual/resolved；source 区分 manual 和 status-correction。补款全部进入可用余额；扣款只实际扣 `min(amount,available)`，超出部分 manualAmount 待财务线下追回，不动在途/已付款，不建立负余额，不自动扣未来收入。recovered 表示线下已追回，waived 需说明免除原因；处理不修改原提现已付金额。流水及审计按 `finance.withdrawals` 或本人范围投影。

已提现后退款/旧金额更正仍保留人工核对流程，系统不自动追回。旧 rewardCredit 更正不足覆盖在途提现时明确拒绝，须先处理占用；新的独立扣补款只扣可用余额，不改变占用。人工-origin 扣补按财务费用口径计统计，订单状态冲正由原订单奖励成本计算，避免重复扣成本。

## 储值、押金与资金请求

客户余额读需 orders.view / orders.create / users.manage / finance.refunds 任一项；客户流水和资金写入需 finance.refunds。打手押金财务需 finance.withdrawals，本人仅能读自己的余额与流水。

| 方法 / 路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/customers/:id/balance` | 无 | `{customerId,balance}` |
| GET `/customers/:id/transactions` | current / size | `{customerId,balance,records,total,current,size}` |
| POST `/customer-transactions` | `{customerId,kind:'recharge'\|'deduction'\|'return',amount,reason,receipt?,requestId}` | FundTransaction |
| GET `/players/:id/deposit`、`/players/:id/deposit-transactions` | current / size | `{userId,balance,records,total,current,size}` |
| POST `/player-deposit-transactions` | `{userId,kind:'deposit'\|'penalty'\|'return',amount,reason,receipt?,requestId,exitType?}` | FundTransaction；return / penalty 必须 exitType=leave / absconded |

FundTransaction 为 `{id,accountId,kind,amount,delta,balanceAfter,reason,receipt,orderId,createdAt,createdBy,createdByName,requestId,exitType}`。amount 正整数分，delta 带正负号，账户不透支；记录不可更新 / 删除。客户额外自动种类为 order-payment、order-refund，由真实订单 / 退款事务产生。不同财务可按同类资金授权读取关联 SQLite 凭证；客户余额读权限、普通人员管理不能猜 ID 借读资金图片。

写入请求通过 requestId 幂等，同编号同操作者同操作及内容返回原结果，变化 409，权限总在缓存前检查。资金、订单、审计、请求结果同时提交；无结果确认时重试原操作，不轮换编号制造第二笔。原 /player-adjustments 的 requestId 为兼容可选，新页面始终提供；resolve 继续按原终态规则防重复。

Order 新增 `paymentMethod?:cash\|balance`、`balanceTransactionId?`、`balanceCustomerId?`，旧单默认 cash。余额创建及 confirm-payment 强制 requestId、全额扣款，paidAt 为服务器实际扣款时，内部资金支付不需要重复现金凭证，不与落地付同时创建。已余额收款不能改客户金额、实收或付款方式；退款申请 / 直接退款及 approve 须 requestId，审批后自动回原 balanceCustomerId 的储值账户，通过唯一退款源防重复，不再现金退款。大厅原退款禁令保持。

充值和押金缴纳 / 退还不记经营收入；客户 deduction 及退出 penalty 才按真实登记日计 days / overview 的 otherIncome，利润加入此项且订单营收不重复。报酬钱包扣补沿旧成本调整。导出新增 customerBalances/customerTransactions/playerDeposits/playerDepositTransactions，余额只为当前 snapshot，流水由授权 SQL 筛选后计数 / 读取，实际总计日期含 SQL 最早资金时间，超 100000 明确拒绝。人员 staff 改为非打手，新增 players 档案模块；完整模块数为 34，批选上限 64，白名单授权保持。

## 人员、工资与考勤

POST `/users` `{id?,username,name,role,status,levelId,maxActiveOrders,permissionOverrides,password?,playerAccess?}` 需 `users.manage`；密码创建/重置仅管理员及超管，普通账号不能维护超管。停用、更换角色或重置密码撤销会话。playerAccess 三个严格布尔开关 login / claim / withdraw，旧默认为 true，关闭 login 撤销已有会话；claim 只拒新接单而允许已有提交，withdraw 只拒新申请而不改原报酬 / 在途提现。有未完订单、报酬、押金、在途提现或待追回差额时禁止 player 换角色隐藏资金。

GET `/players?current&size&name&username&levelId&status&login&claim&withdraw` 由 users.manage 或 finance.withdrawals 分页投影名单，财务只拿可见资金 / 基本信息，不扩大账号编辑权限；GET `/players/:id/orders?current&size` 提供真实接单 / 上报记录，按服务端实际订单查看授权返回，不伪造 history。前端人员管理的 employees / customers / players 直接复用原页，旧 /system/user（role=player 切玩家）、/orders/customers 为永久跳转，query/hash 保留，退出后仍有效。

POST `/salary-plans` 使用 SalaryPlan，需 `salary.manage`；`platformRates` 明确保存 0 或 null 的不同含义。POST `/payrolls` `{month}` 需同时有 `salary.manage` 与 `salary.all`，本人薪资授权不能用于全员月结。配置未齐禁止发放，工资保存历史快照；完成月计佣金，退款归原付款日并只扣新增多发佣金差额，补充结算不重发底薪。大厅运营提成固定 0，固定工资佣金为 0，已有有效计提比例/人员归属与发放底薪快照不随未来配置重算。月中换方案当前不按天折底薪，按工时计薪仍未开放。

POST `/attendance` `{id?,userId,date,start,end,status,actualHours?,remark}` 需 `attendance.manage`，同人同日一条。状态含 normal 正常、rest 休息，并保留 scheduled 待登记、present 到岗、leave 请假、absent 缺勤兼容值。

- 未登记日期仅由界面默认展示正常，不写虚构的每日记录、班次或实际工时。
- normal/rest 的 start/end 可同时为空，有值须成对；正常无班次可单独登记 0–24 小时，有班次则不超过班次时长，支持跨夜。
- normal 的 actualHours 为 null/未传时返回 0 且 `hoursRegistered=false`，表示未登记而非确认零工时；过去/当天明确提交数值才标已登记。
- 未来 normal/rest 只作为计划，actualHours 必须为 null/0 且未登记；rest/leave/absent/scheduled 不计实际工时，未来不能标 present。
- present 保留旧班次规则和兼容行为，新界面的正常状态不会自动把计划时长当实际工时；实际工时与工资模式分开。

## 报表导出

GET `/exports/catalog?month=2026-10&periodType=monthly&periodDate=2026-10-13&archived=all` 返回 `{month,period,modules}`。`periodType` 支持 daily/weekly/monthly/total，weekly 是周一至周日自然周，total 截至今天；`periodDate` 用于日报/周报，月报以 month 为准。目录模块与字段由当前服务端权限决定，空数据仍返回允许的表头，不为目录载入全部归档。

POST `/exports/preview`、`/exports/download` 请求：

```json
{
  "month": "2026-10",
  "period": { "type": "monthly" },
  "modules": [{ "id": "orders", "fields": ["orderNo", "amount"] }],
  "filters": {
    "keyword": "0001",
    "keywordField": "orderNo",
    "archived": "all"
  }
}
```

可选筛选包括 `dateRange:[start,end]`、`keyword`、`keywordField`、`personId`、`platformId`、`status`、`orderDateKey:'createdAt'|'paidAt'|'completedAt'`；日志专用 archived 为 all/hot/archive。未知/无权模块或字段拒绝；先按真实完整记录筛选再选列。静态配置不受日期筛选，目录说明此语义。费用 status active 表示未删除、deleted 表示软删；没有 status 的模块不受状态筛选。日志关键词只检索公开操作人/动作/实体/记录号/时间等字段，不按未授权 before/after 搜索或泄漏计数。

响应 `{month,period,generatedAt,sheets:[{id,name,fields,rows,rowCount}]}` 是授权表数据 JSON；前端生成 Excel。预览每表最多 20 行但 rowCount 保留筛选后总数；全量下载合计最多 100,000 行，超限明确拒绝，不静默截断。金额换算为元、比例换算为百分数，待配置保留“待配置”，编号保持字符串。工资和统计按实际期间口径，历史发放按原快照；导出与详情均不从 raw state 补充未授权字段。普通日志 Excel 为脱敏可见内容，不是可恢复的完整审计备份。

## 操作日志、备份与容量维护

审计迁出业务 JSON，保存在 SQLite 热表与归档表，带日期、操作人和实体索引。默认热保留 90 天、最多 10,000 行，超出移归档；归档默认最大 500 MiB，仅统计原始审计 JSON 内容字节，不等于整个数据库/附件磁盘大小。配置环境变量为 `STUDIO_AUDIT_RETENTION_DAYS`、`STUDIO_AUDIT_HOT_MAX_ROWS`、`STUDIO_AUDIT_ARCHIVE_MAX_BYTES`，均为正整数。90% 容量预警；达到上限或待归档内容放不下时返回容量 503，业务和审计事务整体回滚，不自动删除财务历史。

| 方法 / 路径 | 请求 | 响应及权限 |
| --- | --- | --- |
| GET `/logs` | current/size（最大200）、source=hot/archive/all、actorId/entity/entityId、action、keyword、dateStart/dateEnd | `{records,total,current,size}`，需 `logs.view`；实体/人员/记录号精确匹配，action 独立包含匹配 |
| GET `/logs/:id` | 无 | 按当前权限投影的 AuditLog，需 `logs.view` |
| GET `/logs/storage` | 无 | `{hotRows,archiveRows,archiveBytes,archiveMaxBytes,retentionDays,hotMaxRows,warning,canBackup,maintenanceMode,emergencyLoginRows,emergencyLoginMaxRows,emergencyLoginRetentionDays}`，需 `settings.manage` 和 `logs.view` |
| POST `/logs/maintenance` | `{action:'archive'}` | `{affectedRows,candidateRows?,automaticArchiveRows?,storage}`，同上权限，affectedRows 为本请求实际总移动数；无候选不新增审计，近期记录不强制归档 |
| GET `/logs/archive-backup?beforeDate=YYYY-MM-DD` | 截止日期 | 完整原始 JSON 流式附件，需下述完整备份权限组合 |
| POST `/logs/maintenance` | `{action:'purge-archive',beforeDate,backupToken,backupConfirmed:true,reason}` | `{affectedRows,storage}`，同完整权限，reason 必填 |

日志白名单投影保留当时旧值，不从现记录替换历史。人员账号和覆盖权限仅人员管理授权可见；工资日志需 `salary.all` 与 `profit.view`；金融附件、扣补和订单详情遵守对应金融/本人/订单查看范围。只给 logs.view 不开放其他业务数据；未知实体前后内容不直接透传。

完整备份/清理要求同时具备 `settings.manage`、`logs.view`、`reports.export`、`orders.view`、`users.manage`、`salary.all`、`profit.view`、`finance.review`、`finance.refunds`、`finance.withdrawals`、`finance.expenses`。默认老板和超管满足，普通管理员可看容量/主动归档，但不可读取完整金融审计或清理。

备份 cutoff 为所选上海日期零点，仅包含之前的归档行。响应 MIME 为 application/json，文件名 `studio-audit-archive-before-<日期>.json`，结构 `{format:'studio-audit-archive-v1',beforeDate,generatedAt,records:[原始审计对象]}`；通过迭代器流式发送，尊重下载连接背压，不整表加载内存。响应头 `X-Studio-Backup-Token`、`X-Studio-Backup-Count` 分别用于清理凭据和核对条数。

凭据仅在响应完成后就绪，有效期 30 分钟，绑定账号、截止日和归档范围/版本；中断下载、未完成、过期、换人/换日期、归档后来变化或重复使用均拒绝清理。清理须用户保存完整文件后提交 token、确认和原因，只勾确认无效。仅删除已备份截止日之前归档并保留维护审计。完整审计 JSON 备份不替代 SQLite 全库备份。

正常登录的会话和审计同事务，失败 session 不残留。仅专用 `AUDIT_CAPACITY` 503 且正确密码账号满足完整备份权限时，允许签发维护登录会话，响应带 maintenanceNotice；其他错误不能吞，普通账号不能绕过容量阻断。应急记录在独立 `audit_emergency_logins`，只含登录人/时间等基础字段，最多 1,000 条/保留 30 天，不保存密码、token、财务内容。hot/all 日志可读，不混入归档备份。storage 的 maintenanceMode/warning 标示状态；维护登录不豁免业务写入，备份清理后正常审计成功恢复普通模式。

## 只读数据检查

GET `/diagnostics` 返回 `DiagnosticsReport`（类型见 `src/types/studio.ts`）：`generatedAt,readOnly:true,status,summary,checks,issues,scopeNotes`。status 为 ok/warning/error；summary 包含 `checkedRecords,errorCount,warningCount,issueCount,returnedIssues,truncated`，checkedRecords 为各项目核对次数之和。最多返回 100 条问题，错误优先；汇总及每项目数量统计全部问题，超限不假装完整。

权限复用上述完整备份组合，默认老板 / 超管满足，普通管理员、财务、客服默认无权读取。登录鉴权与检查自身都直接读取当前状态，禁止迁移旧 JSON 日志、审计、修改实体或自动修复；测试以 SQLite query_only 及 total_changes 核对真实 HTTP 请求无写入。响应不包含原始凭证、账号秘密或业务金额明细，不能用公开主机探测替代业务检查。

核对关联外键与来源店铺、订单状态与整数金额 / 退款、打手到账及状态冲正、扣补分项和提现占用、独立客户编号、历史工资快照算术 / 重复底薪、实际登记工时。合法指定待接单、状态冲正保留历史、已提现人工差额、同月补结算、负工资差额及未来未登记均遵守原业务规则；配置未齐、取消补偿和待追回列 warning。工资不按当前方案重算，凭证存在不能证明银行已到账。

前端“数据检查”路由使用 `studioPermissionMode:'all'`，只有全部授权时显示菜单并放行深链；其他业务路由保持原任一授权规则。页面需手动开始检查，离开或失去授权时清除报告，不持久化到浏览器。

## 打手接口与当前界限

真实打手五组接口已实现并验证：GET `/player/orders`；POST `/player/orders/:id/claim`；POST `/player/orders/:id/submit` `{screenshots,teammateId}`；GET `/player/wallet`；POST `/player/withdrawals` `{amount}`。仅打手账号可用，遵守指定人、等级延迟、接单上限、最新材料、可用余额与在途占用校验。接口服务连接真实数据库，尚无独立打手端 UI；不能将“没有独立页面”描述为“没有接通接口”。

原源码服务器监控 `src/views/safeguard/server/index.vue` 是随机数和示例 IP 演示，不展示真实主机指标。现有 diagnostics 只检查业务数据；没有主机 health 或自动修复接口，维护入口为数据检查、日志容量、备份、归档及凭据清理，不提供远程命令执行。

## 原框架前端协作

共用原框架 Pinia：`src/store/modules/studio.ts` 保存服务器数据，`src/api/studio.ts` 封装真实接口，`src/hooks/business/useStudio.ts` 返回 refs `data,user,loading,error,selectedMonth` 和 `can,refresh(month?),mutate(path,body,method?),upload,login,logout`。成功修改自动刷新；业务数据不持久化到浏览器。

直接改造原 `src/views/dashboard/console`、`dashboard/analysis` 及 `system/user`、`role`、`menu`、`user-center` 页面。业务按原结构放在各 views 目录；表格复用 `ArtTable`、`ArtTableHeader`、`ArtSearchBar`、`useTableColumns`，图表复用 `ArtLineChart`/`ArtBarChart`，布局采用 art-card、ElCard 与响应式栅格。保留原模板组件/示例；真实业务菜单按服务端默认权限和个人覆盖过滤，不恢复独立应用、页面包装器或另一套全局样式。
