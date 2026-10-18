# 工作室本地开发协作契约

## 打手端落地付提示（2026-10-18）

打手授权订单投影新增布尔 `payOnArrival`，只读参与历史摘要返回 false。大厅／指定接单卡片和接单前后详情顶部，对落地付且未确认付款的当前订单醒目显示“此单为落地付，落地后让老板联系客服付款”；普通未付款、已确认付款、已结束及仅参与历史摘要不显示催付。只改变授权标识与文案呈现，原接单、收款、上报、验收、退款、存单和名额规则保持。

## 取消与退款统一窗口及零元基础报酬（2026-10-18，覆盖下方冲突口径）

本轮经用户确认增量实施于原修复分支，统一取消与退款，不增加打手报酬填写或补偿审批；特殊金额使用既有打手扣款／补款窗口。只交付隔离本地版及更新包，正式站等待用户验收。

### 统一提交与退款去向

`POST /orders/:id/action` 增加 `action:'cancel-refund'`，同一次请求包含原有 `requestId/expectedRevision/reason` 及 `refundAmount`（分，允许0）、`refundDestination:'cash'|'balance'`、`refundChannel:'wechat'|'alipay'|'platform'|'bank'|'other'`、`refundChannelNote`、`actualRefundConfirmed`。0元只取消；未收款或游戏大厅来源只允许0元。原实收、付款日和订单金额不清空。统一命令在一个写事务中完成取消、退款申请或登记、报酬决定、审计和通知，任一校验失败全部回滚。

创建取消仍需 `orders.edit`，已完成订单另外要求 `finance.review`。新退款入口明确默认 `cash`（退给老板，即下单客户，线下退款且不加余额）；选择线下退款必须提供实际渠道，其他渠道填写说明。`finance.refunds` 与实际完成确认同时满足时才能登记新线下退款已付；未实际完成或无该权限时建立待退款申请。有退款权限且明确选择余额时，系统向服务端绑定的原客户账户入账一次，不再线下退款。

独立 `POST /refunds` 使用 `amount/destination/channel/channelNote/actualRefundConfirmed`；新 `Refund` 保存 `destination/channel/channelNote/destinationCustomerId`，保留 `refundMethod` 作为实际处理结果。审批读取已保存的去向和渠道，不允许借审批修改；新显式线下退款审批须确认实际完成。新增字段进入幂等内容及授权审计投影。旧请求、旧待审退款缺目的字段时，继续原付款方式路线；不能套用新窗口默认值，旧已付及余额流水不批量改写。

### 取消可见范围及报酬

新取消记录 `cancellationPolicyVersion:1`，终止履约、失效旧操作及提醒、释放名额，不提供恢复；退款驳回不恢复订单。`status==='canceled'` 从后台日常列表和打手日常任务移除，后台显式已取消筛选按原履约状态查询，因此即使展示为已退款仍能找到。不能在全局授权、财务读取、导出或关联订单集合过滤，原单及审计保留。材料继续原保留与权限规则。

服务端在新取消或实际全退生效时，持久记录 `rewardDisposition`：`mode:'zero-unsettled'|'preserve-settled'`、触发来源、规则版本、时间与操作人。原 `reward` 保留报价历史，新增只读 `effectiveReward` 统一表示有效基础报酬。未结算的取消或全退按0确认，不制造资金流水，不产生新取消补偿待办；部分退款、全退申请中、已完成或本单存在结算／报酬流水／扣补／冲正历史时不自动清零。旧数据不批量补结案决定，旧补偿待办仍保留处理能力。

零元决定不得因之后发生补款而重新判为原报价；成本、经营统计和明细统一使用有效值，关联补扣按原付款日单独计算，不能重复计原报价。新的零元或保留决定不能通过旧补偿入口、改价或状态更正绕过。打手端只取得授权的报酬投影，不获得客户退款金额、去向或渠道。

特殊报酬复用既有 `/player-adjustments`，权限仍为 `finance.withdrawals`；从取消历史进入时自动带入原订单编号。按人分别登记，扣款只扣可用余额、超出部分沿用人工追回，不自动追回已付款或改变原提现记录。取消窗口不增加另一套金额表单、结算审批或后台自动发款。

新增明确退款去向与结案报酬策略纳入发布能力及只读兼容检查；不理解这些字段的旧候选不得接管新记录。开发测试继续使用内存库或专属QA库，不清库、不触及正式账。

## 公网问题修复的统一双端交付（2026-10-18）

本节按用户本轮确认覆盖下方历史分工及冲突规则：本对话统一维护后台、服务端、独立打手端并联调；仅在 `codex/production-fixes-20261018` 独立工作区交付本地预览、报告和更新包，正式站仍由用户审核后部署。本轮不读写正式库、不重置人员/订单/图片、不向真实渠道发送测试通知。

### 统一订单执行资格及退款

保留原 `status:pending|active|review|completed|canceled`、原收款时间及金额，新增只读投影 `displayStatus`（原五态或 `stored|refunded|refund-pending`）、`fullRefund`、`refundPending`、`stored`、`capacityExempt`、`countsTowardsCapacity`、`executionBlockedReason:{code,message}|null`。`executionBlockedReason` 维持退款/存单执行限制；新增同形的 `playerOperationBlockedReason` 进一步表示打手端只读，包含未关闭问题限制，不能借此误拦后台客服的正常处理。后台另有 `refundSummary:{paid,pending,remaining,fullRefund,refundPending}`；打手端不返回客户退款金额。列表、筛选、计数、派单目标、接单/上报/验收写入和通知统一使用服务端执行规则；问题标记与原履约状态并行。

累计已实际退款达到原实收，或已有全退执行关闭记录，显示已退款、禁止再次派单/抢单/上报/验收、移出大厅并释放未完成单名额。读取与执行同时适配旧库中全退却仍 pending/active/review 的异常单，不以新字段存在为前提，不重发退款或报酬。全退生效后的写操作保留 `refundExecutionClosedAt`，历史金额更正不能偷偷重开执行。已完成后退款保留完成时间、材料及原付款日；打手报酬继续遵循原人工核对/补偿/扣补规则。

已退金额加待审批金额达到全部实收，冻结抢单、上报、验收，原来已占名额暂留；驳回仅解除退款冻结，不能解除存单。部分退款不自动结束履约。退款创建及 approve/reject 要求所关联订单的 `expectedRevision`，与 requestId 幂等一同使用；提交后订单版本推进，待接单资格改变时推进派单轮次，旧请求及待发新单提醒失效。resolve 人工差额处理仍按原退款身份和幂等流程。`ORDER_REFUNDED/REFUND_PENDING/ORDER_STORED` 为执行冲突码。财务历史日志按当时保存值投影，不能用今日退款情况覆盖旧快照。

### 存单与免名额续做

POST `/orders/:id/action` 新增 `store`、`resume`，需 `orders.edit`、原因、订单版本和 requestId。只允许 pending/active 存单，保留原负责人、接单身份、材料及进度备注，暂不结算；存单不进大厅、停止履约并释放名额。存单期间该订单在打手端仅可查看，禁止新增订单操作，由后台客服决定恢复或其他处理。待验收须先处理验收，不直接存单。当前 `storage` 与先前 `storageHistory` 记录每轮原因、原身份、保存与恢复时间及操作者，不覆盖历史。

resume 的 `mode:'original'|'pool'`：无人接单默认 pool，重新发布公共大厅及轮次；有原负责人默认 original，直接恢复原任务，不需重新接受，服务端将本轮 `capacityExemption` 绑定存单编号、原负责人和原 assignmentId，直到该轮结束免名额，验收退回仍有效。原负责人停用、关登录或接单身份结束时拒绝恢复并保持存单；单独关闭新接单开关不禁止处理原存单。后台可显式选择 pool 重新分配，清原接单关系；换人/重接按普通单计名额。完成、取消、解除或状态更正不产生新的免名额资格。新字段不能由任意前端附加内容直接赋值。

### 问题单及通知

POST `/orders/:id/action` 新增 `problem-open` 和 `problem-close`，需 `orders.edit`、原因、版本、requestId；close 另须匹配当前 `problemId`。每单最多一个 open 问题；`problem` 保存当前问题，`problemHistory` 保存前轮，含发起、历史反馈、关闭及处理结果。可以对未接单、执行中和已完成订单登记；已取消不新增。按用户后续明确规则：问题未关闭时，打手仅可查看该订单，不得抢单、拒绝指定、提交材料、申请退单或新增问题反馈，由后台客服直接填写处理结果并确认关闭，不等待打手反馈。问题不改变原履约状态，也不额外释放名额；后台客服保留原权限内的处理入口。关闭问题或恢复存单后，仍须重新满足退款、其他暂停及当前接单身份等资格，不能自动绕过其他限制。

旧 POST `/player/orders/:id/problem-feedback` 路径保留兼容身份识别，但一律拒绝新增写入，不再作为打手处理问题入口。数据库已有打手反馈保持只读展示，不能清空或伪装成客服记录。原 family=`problem-feedback` 的历史成功请求仍可通过 operation-result 核对原结果，不重执行，不由旧接口或重试产生新的反馈。

站内通知新增 `problem-open/problem-closed/order-stored/order-resumed/refund-result`。问题发给相关负责人及队友；未接单先记录，后续人员接入再提醒。问题目标附 `problemId`，旧问题/旧接单身份不可操作当前目标，关闭后旧问题提醒及外发任务失效。公共大厅非参与者只看到问题标记，不提前获得原因、反馈、房间或客户私密信息。实际手机到达仍取决于正式推送配置、授权和设备验收。

### 图片与员工排班

POST `/uploads` 保留 JSON/Base64，新增 `Content-Type:image/png|image/jpeg|image/webp` 二进制正文、`X-Upload-Name:encodeURIComponent(name)`，写入仍复用 Actor、会话、8MiB、签名、并发、事务与审计限制，原图字节不变。GET 原附件/内容图片支持 `?variant=thumb|display`（默认保留原图），变体使用有界异步队列并在返回前再次核对当前会话及原附件授权；不以衍生缓存绕过删除、归档、撤权或换号。

私图继续 `private,no-store`，客户端仅有界、账号/会话隔离的内存复用，退出/换号撤销对象URL并拒绝晚响应。公开品牌图在每次公开用途核对后才可条件304；更换或撤销不能借旧ETag绕过。缩略图可再生成，不能替换原始凭证。完成截图现有30天规则保持，open 问题或 active 存单保护材料；问题关闭后回原规则；已删除图片不因开问题或恢复备份复活。

`work-schedules` 与 `attendance` 写入拒绝 player；员工排班选择、默认行、读取、工时及导出排除打手。旧打手考勤和班次不删除，原审计和完整备份保留。

### 数据与发布兼容

新存单、问题及执行关闭记录采用原订单JSON的可选字段，缺省为无存单/无问题；没有清库或重建账号。发布清单提供 `runtimeCapabilities`，核心能力为 `refund-execution-v1/stored-orders-v1/problem-orders-v1/problem-staff-only-v1`。凡业务库存在问题记录，兼容回退候选必须声明 `problem-staff-only-v1`；缺少该能力的旧 rc1 不能直接承接，防止重新开放打手操作。升级和兼容回退前使用只读数据库检查核对旧全退异常、新存单/问题数据及候选程序能力；无新规则能力的旧程序不得直接承接新业务库。Git标签只保留代码，不能代替SQLite一致性备份及配置、私有归档保护；上线后新交易不能用旧库直接覆盖。本轮报告、原始证据及真实公网/手机待验收项目另列。

## 最终上线预检的备份发现与覆盖口径（2026-10-17）

只读上线检查复用既有同源计划备份清单：在已配置的私有备份根目录内有界发现本工具、同一业务库、已声明完成的最新恢复点，再校验SHA、完整性、数据/应用版本及新鲜度。正常轮换淘汰旧 `latestMetadata` 文件名后，不要求人工不断修改启动配置；显式旧手工清单仍兼容。最新同源完成副本损坏、版本不符或过期时不能降级挑旧好副本冒充成功；目录/文件链接、越界及超出扫描边界拒绝判通过。检查不修改清单、备份或业务数据。

预检 `nominalCoverageHours` 表示连续成功恢复点的首尾名义跨度，计算为 `(retentionCount - 1) * intervalMinutes / 60`；3份每小时恢复点约跨2小时。实际覆盖仍以成功清单首尾时间和中间缺口为准，不能将名义跨度当作实际连续备份或可保证的数据丢失时间。没有改变备份周期、3份/4GiB/8GiB保护、图片规则、订单、资金或权限。

## 40GB磁盘的本机备份容量保护（2026-10-17）

按用户授权复用现有SQLite一致性备份、目录锁及同源归属保留器：本机仍每60分钟执行，完成副本最多3份，备份目录常规文件总量最多4GiB，磁盘至少预留8GiB；份数不代表天数，3个连续小时恢复点跨度约2小时。容量不足可少于3份，不能为腾空间删最后一份已验证可恢复副本。手工/他源/未知/损坏或未完成文件计入目录容量但不自动删除；不跟随符号链接，链接目标的占用仍受真实磁盘余量探测约束。

新增可配置 `STUDIO_BACKUP_MAX_TOTAL_BYTES` 与 `STUDIO_BACKUP_MIN_FREE_BYTES`（默认0表示未启用该项限制）；本机私有配置 `backups.maxTotalBytes` / `minFreeBytes` 显式传入既有服务。保留副本预算不等于备份作业的瞬时占用；启动前检查源盘与备份盘，并按主库/WAL/仍需物化归档图片估算3倍复制及副本整理空间，另加64MiB余量。各阶段再次核对剩余空间/本次副本大小，不满足则失败并仅回收本次创建副本，保留最近成功恢复点；其他进程占盘不受本工具配额控制。容量保护模式的实际备份及完整性校验使用工作线程，避免大库同步校验占住API事件循环；普通CLI/旧关闭容量配置保持兼容。

只在既有独占目录锁内清理确实超出份数或容量的旧副本，核验同源清单、完整性/SHA、绝对路径、根目录及文件身份；新副本成功后再次收敛双限额。删除失败/无法满足限额、磁盘探测失败、余量不足和单副本过大均记录明确备份故障，不伪装成功，不循环重启业务。清理不涉及业务库、订单/资金/账号/现有图片、原图清理任务或其他目录。

## 完成订单截图到期删除（2026-10-17，覆盖下方同日归档规则）

按用户最新明确要求：打手上传并用于订单上报的普通截图，从订单 `completedAt` 起满30天（含边界）后，在下一轮原上传清理任务中永久删除图片内容，不再转存同盘归档。订单、原材料编号/名称等历史信息、资金、账号和审计/幂等原记录保留。未完成、争议保留清单、未处理退款/退单/差额/更正核账、收付款凭证、私人收款码、非打手上传及不明确/活跃共享引用继续保护；未知线下争议需运维登记原私有保留清单。

`STUDIO_IMAGE_DELETE_ENABLED=true` 和原 `STUDIO_UPLOAD_GC_ENABLED=true` 共同启用；`STUDIO_IMAGE_DELETE_RETENTION_DAYS=30` 不得小于30。与归档开关互斥；复用原每60分钟调度，单轮扫描/删除均最多50张，不重叠。永久删除只清空图片BLOB并留下到期标记，已有归档图还须安全删除其精确私有文件；删除失败保留待清理映射并重试，不批量清理目录。历史引用只允许普通上报材料，财务/未知用途仍保护。业务记录不因图片到期而删除或重写。

两端现有授权订单材料的附件投影可增加 `retentionStatus:'deleted'`、`deletedAt:ISO时间`，显示“订单完成满30天，图片已删除”，不继续发起图片请求。原 `/uploads/:id` 在完整原权限核对后对到期图返回410；无权者仍403、匿名仍401。旧图片编号不得重新用于提交、付款凭证或其他附件写入；过期图不恢复下载或操作权。既有旧结果只确认原操作，不因当前图已删除而重写原结果。

删除释放SQLite页供后续上传复用，主库不在业务定时任务中自动VACUUM；文件高水位不等于原图仍可读取。新的完整备份保留到期标记，不重新物化已删图，并仅在独立工作线程整理新备份副本空页后再校验发布；不整理业务库，不追删旧备份，旧副本按原保留策略轮换。此规则不保证活跃/受保护图片无限增长时磁盘永不满。

## 图片保留与可读归档（2026-10-17）

本轮用户授权补齐三类图片保留规则，不删除订单、资金流水或账号，不改变两端视觉及附件授权。复用既有上传回收定时器：本机废弃上传按上传时间保留30天，只有无当前业务、历史审计、成功请求、资金及私人图片引用才回收；已完成订单的普通上报截图按完成时间与最近通过验收时间的较晚值保留至少30天，之后可移入私有归档，保留原图、ID、下载URL及原访问权限。收付款凭证、收款码、进行中/资料不全/待退单/退款待处理/未处理报酬差额、后台更正待核对及不明确引用优先保护。历史订单图不采用永久删除。

归档须先在业务事务外写入并核验原图字节和SHA，再在短事务内重读当前订单/引用/人工保留规则，确认仍可归档才登记位置并释放主库BLOB；失败保留原BLOB。已归档图的读取先执行原账号和对象权限检查，再读取私有文件并核验摘要；不返回磁盘位置，不增加公开图片地址或客户端持久缓存。归档不改变订单、金额、会话资格或审计历史。晚到状态变更、重新开单或新争议不会使归档原图丢失或扩大可见范围。

`STUDIO_IMAGE_ARCHIVE_ENABLED=true` 显式启用完成单归档，仍要求原 `STUDIO_UPLOAD_GC_ENABLED=true`；`STUDIO_IMAGE_ARCHIVE_RETENTION_DAYS` 默认30且不得少于30；`STUDIO_IMAGE_ARCHIVE_DIR` 默认业务库旁 `image-archive/`，可配置独立私有磁盘。归档每轮最多5张，单张仍不超过8MiB，同一调度不重叠，暴露独立的最近归档结果和失败计数，不将归档称为删除。缺配置或关闭时不自动迁移历史图。

当前无独立争议状态时，业务异常按既有字段保守保护；另外支持私有 `image-retention-holds.json`（默认业务库旁，或 `STUDIO_IMAGE_ARCHIVE_HOLDS_FILE` 指定）格式 `{ "format":"studio-image-retention-holds-v1", "orderIds":["订单ID"] }`，供运维对线下争议显式保留。畸形/链接文件使归档拒绝执行，不自动忽略。此文件不是新的业务操作或解除争议入口，未配置的线下争议不能声称系统已自动识别。

完整SQLite备份先取得一致性副本，再从已提交归档映射核验并将原图写回备份副本，清除副本的外部文件依赖；缺图/摘要不符则整次备份失败，不产生成功清单。离线恢复仍只创建新库，不依赖源机归档目录，不启动推送。归档原图不参与废弃上传的永久删除，避免破坏历史读取和并发备份。归档文件不放静态目录/Git；同盘归档不减少整盘累计占用，完整备份仍包含原图，主库空页也不保证立即归还操作系统，不自动VACUUM或清理原图/完整备份。

## 本机系统任务守护与监控纳管（2026-10-15）

本机正常服务在存在明确私有 `.ops/local-monitor.json` 时，先校验其local/internal、原库和回环目标、独立绑定及监管状态目录，复用同一 `superviseServices` 纳管原 `studio-monitor.mjs`，而不是建立第二套探测。监控健康检查仅核对当前自建子进程的随机控制身份；被监测API故障不会触发监控器反复重启。独立旧监控占口时拒绝启动，不接管或停止外部进程；隔离fixture继续忽略本机配置。

Windows任务新增显式非秘密 `OpsDirectory` / `OpsEnvironment` 配置，经过私有路径及环境白名单核对，由任务宿主传入guardian，再传入manager/API，保证守护、备份、监控共用同一事件库，不依赖启动终端临时环境。任务按当前账号安装，仅管理本项目创建的Job家族；开机触发配置与实际重启验证分开记录。隐藏窗口及detached只证明可脱离调用终端，不证明脱离上层Windows Job或应用生命周期；实际常驻须核对系统任务运行、祖先及Job归属。

任务宿主解码的manager参数必须是受限UTF-8字符串数组并逐项展开，禁止把整个数组合为单个CLI参数。默认启动入口与guardian共用端口探测辅助模块，避免入口互相导入产生未完成顶层await。状态查询只有实时随机身份握手成功才返回当前services；磁盘旧状态独立放入lastRecordedServices，不再以历史running表示现在存活。

本机显式备份配置仅接入既有一致性调度，周期/份数/私有目录须校验，不自动启用远端或真实告警；同机备份不能当异机灾备。实际启用、退出原因证据边界及数据保留验收另见本轮服务恢复记录，不以历史状态文件中的running证明当前存活。

## 本机监控显式绑定（2026-10-15）

本机 API CLI 可显式读取私有 `.ops/local-monitor-binding.json`：`format=studio-local-monitor-binding-v1`、`environment=local`、项目绝对 `root`、既有库绝对 `databasePath`、`host=127.0.0.1`、整数 `port`、独立随机64位十六进制 `token`。文件缺失仍使用原环境配置；仅回环地址、实际项目/库及端口全部一致才启用。文件/父目录禁止符号链接、文件有大小上限，畸形或冲突只返回固定错误；不得放入静态目录、Git或日志，Windows目录ACL限当前运行账号与SYSTEM。此绑定不改变业务账号、角色、会话或业务库路径，启用时不补种示例数据。

现有监控器配置 `localBinding=true`、`environment=local`、`mode=internal`、`credentialEnv=STUDIO_MONITOR_TOKEN` 后复用同一绑定；摘要和live/ready必须指向同一回环API，显式环境凭据不一致时拒绝启动，不静默切换身份。仍只授予原 `/ops/summary` 与受限诊断摘要读取能力，不授予业务读取/写入权限。该本机适配不替代正式服务器的秘密管理、站外探测或服务管理，也不自动启用真实告警、计划备份或异机复制。实际启用及切换结果以本机激活验收记录为准。

## 上线前运维收尾（2026-10-15，业务规则不变）

复用真实运行指标、原只读诊断、SQLite一致性备份/离线恢复和本地监管器，补运维就绪、独立监控及告警，不修改订单、资金、权限、打手规则或现有界面。新增公开GET `/api/studio/health/live` 返回 `{status:'ok',service:'studio-api',release:64位发布指纹|null}`；GET `/health/ready` 经有界只读SQLite必要表/状态验证返回200 `{status:'ready',service,release,checks:{database:true}}` 或503 `{status:'not-ready',service,release,category,adviceCode}`。公开探针不返回路径、schema细节、身份、业务数据或秘密；release缺失明确null，不表示发布对应关系已核实。磁盘SQLite通过独立工作线程有界等待，重复探针合并，最多1秒短缓存，不计算完整报表或遍历订单。

新增独立监控身份仅可GET `/ops/summary` 与显式启用的低峰 `/ops/diagnostics-summary`，使用独立随机Bearer秘密（32–256字符；服务端仅比较哈希），不复用管理员密码或浏览器Cookie，也不能登录、查询业务私有对象或执行任何写操作。summary只返回运行/资源/任务计数，诊断只复用原规则的汇总及采样时间；原详细指标及人工诊断的权限不变。未配置监控身份返回401，非GET返回405。低峰诊断默认关闭，启用需明确UTC时间窗及最小间隔，单任务读取、不自动改账或修复订单。

告警事件、去重和投递队列独立于业务库/事务，容量及保留有界；未配置发送渠道明确disabled，模拟接收不称真实消息到达。监控区分正常401/403授权、409业务冲突、429限流与5xx/超时。默认外部60秒、3失败开故障、2成功恢复，启动宽限和维护窗口明确；站外尚无独立部署时不得称已启用或覆盖整机断电。守护只对已确认归属的无响应/退出进程有限恢复，数据库/磁盘/配置/证书/外部网络故障不一律重启。Windows安装/恢复使用独立守护和OS归属边界，正式系统/账号未确定时不安装生产服务。

备份默认启用状态必须读实际配置/任务证据，7份不等于7天；本地成功与异机复制失败独立记录。恢复仅到新离线目录，关闭推送、真实告警及计划维护，不继承生产秘密，不覆盖原库或新交易。正式切换必须授权停写/保留最新原库、版本与完整性核对、旧会话/订阅/租约处理、唯一发送实例、重新开放及失败回退。

运维实现入口：`scripts/studio-preflight.mjs`只读输出code/configuration/enabled/verified四维及PASS/WARN/FAIL，生产ready必须有同环境、同发布、最近24小时非模拟证据。`scripts/studio-release.mjs`绑定当前完整源码与两端全部构建文件指纹；清单缺失、源码/构建变化、HTTP资产不一致均不能证明发布对应。`deploy/ops.example.json`为明确未启用的本机示例；站外示例需安装到真正独立主机，不能把本机external模式称为站外已启用。

统一告警数据库为私有运维目录下`events.sqlite`，守护、备份事件和独立监控复用该库。事件只接受固定类别、服务和排查代码，恢复投递由事件模块生成；没有Cookie或业务写入权限。默认最多1000故障、5000事件、5000投递，完成历史保留30天、活动/待发不静默删除；到容量上限明确拒绝并计数。未配置渠道时事件标记disabled，后续启用不会悄悄补发旧事件。正式投递必须同时有授权配置和明确启用参数；HTTPS渠道秘密只从独立环境变量取，禁止输出。HTTP成功仅代表接收端接受，跨网络不能承诺严格一次或手机实际收到。

公开就绪默认等待1.5秒、SQLite锁等待150毫秒；本机守护默认启动宽限30秒、5秒探测、连续3次失败、5秒冷却、有限指数退避及60秒最多5次恢复。数据库/磁盘/配置/证书/外网故障阻断盲目重启。Windows独占Job回收自己的家族，开机触发及每分钟任务触发复用同一个宿主，MultipleInstances忽略重复；宿主与Node守护各自只恢复直接归属对象。预算耗尽或配置错误保留阻断标记，周期触发不再启动子进程，明确Start才清除标记；Stop先停用触发再退出。电脑开机触发需实际重启验证，登记触发器不冒充开机通过。

业务子服务stdout/stderr每文件默认8MiB封顶、90%警告，满后消费流且不阻塞业务，保留已有文件、不自动删日志；管理事件JSONL同为8MiB完整行封顶。原生宿主/bootstrap日志另由容量探测告警并要求归档，不宣称全部日志已轮转。监控每次只记有界摘要，缺采样改为unknown且不发送恢复。诊断默认关闭；低峰最多一个任务、失败也受间隔约束，明确数据异常单次建故障，恢复仍需两次真实成功诊断，不自动更账。

备份新完成清单含时间、schema、应用发布、字节、SHA和状态，缺已核实发布时明确null；旧无SHA备份只标unknown。恢复先核对清单、摘要、schema和完整性，再创建新离线副本；完成快照有非空WAL或复制期间源变化会拒绝。自动清理只删本工具对应源库管理的已完成文件，拒绝越界/链接；跨实例目录锁不凭过期时间偷占。异机复制默认关闭，普通本地目录只能算simulation；真正异机必须对应受控远程身份并传输后核验SHA。本机恢复验证不承诺零丢失、固定生产恢复时间或实际异机可用。

## 统计读取性能收尾（2026-10-15）

本轮保留 v3.4 界面、所有接口字段、统计/资金口径和权限规则，只优化后台概览及其明细的读取计算。一次读取内复用同一当前授权业务快照，其余月份只组装原权限过滤后的报表；日期归一化和事件索引只存活于本次计算，不缓存私人业务快照，不增加客户端轮询。原概览摘要缓存仍先核对当前账号、权限和数据版本；会话、撤权、跨连接写入、资金写入及上海日期变化的检查继续有效。明细保持同一 SQLite 读取事务中的一致状态，不以过期缓存或当前分页替代权威汇总。

## 后台二级界面详细化 v3.4（2026-10-15，展示与只读明细扩展）

按用户确认覆盖管理后台全部业务详情、弹窗、抽屉及新增/编辑/审批表单，参考摘要、分类导航、真实明细与图表的布局。原订单状态、收款/退款/报酬/提现/押金/工资口径、权限、requestId、原 Actor、revision/轮次/材料保护和通知发布规则不变。独立 `player-client/` 不修改；本轮基线已包含打手 v3.3 订单卡图适配及交付记录，下方 v3.3 的“后续接入”保留当时后台交付边界，不代表当前缺项，也不算本轮新增。原框架模板/示例不当作业务功能重新开发。公共详情组件只接收已授权展示值，不发请求、不授予权限、不自动提交。

用户随后确认“所有长界面跳转”：需要下滑的长详情及长编辑/审批界面使用正常业务详情页，保留原侧栏和表单内容，不继续放大弹窗；短末次确认保留紧凑提示及只读对象摘要。跳转沿原已授权业务路由，通过 `secondary` / `secondaryRecord` 数组保存嵌套界面键和业务记录ID，不写入客户资料、金额、凭证URL、密码、完整表单body或私有快照。返回/浏览器Back保留原忙锁与退出检查。刷新按当前账号、当前权限重新读取记录并调用原表单初始化；未保存输入不视为已恢复的原操作body，不自动重试、不产生新的操作资格。临时报表预览等无法核对原生成集合的详情显示失效并返回重新预览，不能用同页序号指向另一条记录。

为跨分页及刷新后准确恢复原授权记录，新增精确只读 GET `/players/:id`、`/players/:id/deposits/:transactionId`、`/players/:id/orders/:orderId`、`/customers/:id/transactions/:transactionId`，各自返回其原对应分页接口的单条记录投影（前者为原 PlayerListRecord），不返回整库或其他资金对象。权限、账号有效性及对象存在要求严格沿对应原分页读取；流水同时核对当前客户/打手归属，错误对象或不存在记录404。订单参与历史只用原后台历史的安全投影，finance-only账号不能借此获取完整订单私人详情；没有当前私有详情权限的历史仍不恢复房间码、客户游戏ID、联系方式、凭证、内部备注或操作权。查询不写业务、资金、审计、消息或requestId，不改变原分页total、余额、佣金或提现次数，也不扩展打手本人接口范围。

### 概览分类和明细读取

新增只读 GET `/overview/details?metric=...&view=...&start=YYYY-MM-DD&end=YYYY-MM-DD&current=1&size=20&keyword=...`。只允许当前有效的非打手后台账号，各指标/视图再按原业务权限裁决；打手即使有权限覆盖也不能通过该接口读取后台明细。日期沿用 `/overview` 的上海自然日、含边界、最多366天和同长前期；size最大100，current正整数，非法输入400。keyword去首尾空白最多100字符，只匹配该视图已公开的标题、工作室单号、姓名或分类名称，不搜索内部备注、联系方式、客户游戏ID或私有凭证。

返回 `{metric,view,range,comparisonRange,generatedAt,summary,overview,columns,records,total,current,size,groups,groupsInfo,notes,capabilities}`。`overview` 为同次读取的原 `OverviewReport`，`summary` 为其完整权威 metrics，不受keyword或分页影响；明细和分类按当前视图授权及日期/关键词筛选后再分页，total是真实筛选数量。columns 为 `{key,label,type:'text'|'money'|'datetime'|'number'|'status'}`；records 仅白名单标量，不附带完整业务对象。groups 为 `{key,label,count,amount:number|null}`；groupsInfo 为 `{dimension,total,returned,truncated,amountLabel,countLabel}`，按完整匹配集聚合后最多返回100组，明确截断，不把当前页当全量。金额与计数标签明确具体口径；received/customers/orders的分类收款图用未扣退款的received，personal分类用本人净业绩，其余沿各视图真实金额字段。图表若另取前若干分类须标明范围，截断数据不能冒充全量占比；未知成本保持null，负差额不取绝对值或画成虚假正占比。

capabilities.views 为 `{id,label,allowed}` 的静态业务视图定义；权限未开放不返回对应数据。terminal 为 `{supported:false,reason}`：当前订单未记录已确认的端游/手游字段，不猜终端分类，`by-terminal`返回400 `OVERVIEW_VIEW_UNSUPPORTED`。游戏分类使用订单项目快照 `order.snapshot.game`；项目/价格快照使用现有项目快照，不增设新的价格标签或改单规则。

| 指标 metric | 视图 view 与原权限 |
| --- | --- |
| received | 默认days：profit.view；paid-orders/by-game/by-project/by-platform：profit.view及orders.view。付款集合为receivedAmount>0且paidAt在区间，不能用足额收款筛选替代。 |
| orders | 默认paid-orders及created-orders/completed-orders/canceled-orders/by-status：orders.view。分别按付款/创建/完成/取消时间，不能混当同一批订单状态占比。 |
| customers | 默认paying-customers及repeat-customers/by-game：profit.view及orders.view。去重付费客户及截至期末的可见付款历史复购，平均金额继续按付款订单数计算。 |
| profit | 默认days：profit.view；cost-orders：profit.view及orders.view。保留原收入与成本拆分、预计报酬、缺配置和完整月份底薪规则。 |
| people | 默认new-staff及new-players/current-people/unknown-date：users.manage或attendance.manage或salary.all，仅档案白名单。当前人数不回算历史，缺日期不补造。 |
| wallet | 默认balances及paid-withdrawals/in-flight-withdrawals：finance.withdrawals。余额及在途为当前权威快照，已发按paidAt区间；不从流水页计算余额，不公开收款码、凭证或完整支付快照。 |
| accepted | 默认assignments及accepted-orders/by-player：orders.view。接单记录逐次计数，去重订单与次数区分，完成率不冒称完整历史状态重建。 |
| expenses | 默认expense-records：finance.expenses或profit.view；reward-adjustments：finance.withdrawals及profit.view。利润视图费用原合计包含费用登记及报酬人工净调整，分项不再重复扣；关联订单调整归原付款日，其他按登记日，非利润费用权限仍仅有登记费用口径。 |
| personal | 默认completed-orders及by-game：orders.view，强制当前本人创建/运营归属；按完成日及原退款扣减口径，不扩展为全店业绩。 |

订单明细白名单为ID/工作室单号/标题/项目/游戏/平台/店铺/状态/相应事件时间及已授权金额，不返回房间码、客户游戏ID/联系、内部备注、图片、完整commissionSnapshot。人员、客户和提现也仅返回对应视图必要字段；点击关联业务仍重新走原详情权限。无权指标/视图403；匿名/过期/撤销会话沿用401；查询不写业务、资金、审计、消息或操作编号。

### 表单、详情和验收边界

全站详情分组及说明复用现有真实读取、权威余额与原提交函数。工资、经营报表与个人中心在首次进入及再次激活时读取原当前月份授权核算；个人中心的原 bootstrap 显式请求 includeReports=true，仍按服务端原本人/全员权限投影，不能用其他模块 includeReports=false 的空快照冒充完整核算。没有新增轮询或核算规则。订单审计最多最近200条、热审计最多最近1000条、导出预览每表前20条及最近待派预览8条均注明读取范围，不补造完整历史。新UI保持已有忙锁、旧版本拒绝、未知操作/重试、撤权清理和凭证保护；新增分区不得卸载必填表单字段或默默改变请求体。配置/人员/内容/财务表单明确对象、现状、影响和原校验，图片/权限/资金仍由原机制裁决。

测试使用新建隔离库、账号及随机回环端口，证据写入 `.qa/secondary-details-20261014/`，不覆盖原交付或向本地业务库写测试数据。新明细先验证授权、总数/分页、统计集合、缺配置/未知维度及只读无副作用，再验证全站关键详情、表单与两端原业务链路；最后回归、类型和生产构建。此前v3.2压力与v3.3图片交付保留对应版本，不能替代本轮新增明细和UI验收。

## 打手订单卡片图片扩展 v3.3（2026-10-14，本节只扩展图片配置，其他规则沿用 v3.2/v3.1）

本次按 `player-client/BACKEND-ORDER-CARD-IMAGE-REQUEST.txt` 实施后台职责；保留现有 UI，不采用四版视觉方案，不修改独立 `player-client/`。后台交付配置管理、读取/下载契约和隔离验证，打手显示及图片失败降级由后续打手任务接入。

### 保存字段与后台管理

`AppearanceConfig` 新增顶层 `playerOrderCardImage:Attachment|null`。只支持一张统一全局图片，无每订单/模板覆盖，无打手编辑入口。旧配置缺字段读取补 `null`，不重写历史配置；兼容旧保存请求缺少该字段时保留当前卡图，明确提交 `null` 才表示移除。默认、移除或恢复默认均为 `null`，打手显示原游戏图标，不自动借用 Logo、轮播、材料或其他图片。

GET `/appearance` 返回完整外观及该字段；POST `/appearance` 沿用 `{config,revision}`，POST `/appearance/reset` 沿用 `{revision}`。保存/恢复仍需 `settings.manage`，当前 revision 校验、写事务内会话/权限核验及审计沿用原机制，冲突409保留草稿。卡图新增、替换、清空只允许非打手配置账号；打手即使已有 `settings.manage` 覆盖也不能更改卡图，原不改变该槽的其他外观字段行为不扩大整改。整套外观恢复默认清空卡图；卡图页移除只改变当前草稿中的该字段，保存后生效。后台新增“打手订单卡片”页签，提供方形缩略图位置预览、上传/替换、移除和原保存入口；预览不写配置、不宣称打手已经显示新图。

附件继续使用 `{id,name,mime,size,url}` 及真实 POST `/uploads`；只接受 PNG/JPEG/WebP、1字节～8MiB及匹配签名，URL 为规范站内 `/api/studio/uploads/:id`。不接受任意外链、data URL、SVG或伪造附件元数据。新图必须为当前配置人上传；其他人图片只能明确复用当前保存配置中的合法图片，仍须通过新卡图用途校验，不凭历史配置恢复复用资格。

新卡图用途校验拒绝已登记私人收款码、客户/资金付款凭证、退款/提现/费用凭证、订单完成材料及其敏感历史引用，包括当前配置人自己的附件。检查当前业务、私人标记、资金流水、冷热业务审计及成功请求权威结果中对应附件字段；图片文件名、任意说明文本或未实际采用的请求附加字段不作为敏感引用判据。当前用作卡图的附件也不得转作业务凭证或私人资料，避免保存后反向形成私图共享。该用途保护限定本次卡图，保留其他既有外观/轮播权限与行为。

### 打手读取与下载

新增 GET `/player/appearance`，仅当前启用且允许登录的打手读取，返回 `{revision:number,orderCardImage:Attachment|null}`，其中 `orderCardImage` 对应保存的 `playerOrderCardImage`。只投影这两个字段，不公开 updatedBy、后台背景/登录配置、内部备注、客户信息或其他账号资料。非打手403；无/过期/撤销/关闭登录会话按现有HTTP认证返回401，服务层停用/关闭登录也拒绝。无配置返回 `orderCardImage:null`，读取无业务、资金、审计副作用。

GET `/player/changes` 新增 `appearanceRevision:number`，与外观全局 revision 一致；沿用原 version/changed，外观保存/移除/恢复默认会推动现有业务变更版本，不新增推送或另一套刷新机制。revision 只表示全局外观版本，不是订单版本或接单资格。

图片仍通过认证 GET `/uploads/:id` 下载。加入当前已保存外观的有效附件共享，仅扩展图片读取，不授予上传复用或订单/金融附件权限。替换、移除、恢复默认后，旧图不能仅凭旧卡图配置/旧审计继续共享；原上传人所有权、其他当前合法外观槽或现有业务授权独立判断，不删除历史二进制。匿名 `/appearance/public`、`/public-assets/:id` 不因卡图增加投影或下载权限；同图若仍属于当前公开 Logo/登录槽，其独立公开授权按原规则保留。回收沿用当前状态、审计及资金引用保护，保留文件不等于共享授权。

JSON读取使用 `Cache-Control:no-store`，认证图片使用 `private,no-store`。后续打手接入：首次进入大厅/任务、恢复网络/页面可见、现有摘要发现 `appearanceRevision` 改变时重新读取；活跃摘要保持现有约15秒节奏，按全局图片及 revision 更新缩略图，不存业务图片到 localStorage/Service Worker，不长期沿用旧配置。读取或图片加载失败、无图、换号/退出/登录失效时恢复原游戏图标并清理旧图片状态。已显示的像素不能远程撤回，但每次新读取/下载均重新裁决当前授权。

### 本次验证和交接边界

只用新建隔离库、账号和随机回环端口验证后台上传/预览/保存、打手读取新图、替换旧图权限、移除/默认、无权编辑、私图拒绝、元数据/MIME/容量、旧 revision 冲突、匿名/会话及既有品牌/登录/轮播回归。不向当前本地业务库写测试配置，不停止现有3006/3007/3008服务。交付真实验证结果及后续打手适配提示词；本次不冒称打手实际卡片已完成接入。

## 最终对接共享契约 v3.2（2026-10-14，本节及下方 v3.1 优先于历史说明）

本轮由后台收尾任务统一负责服务端、后台、契约与最终联合验收。原打手 v3.1 已交付；确认旧任务不再写入后，仅对以下新增读取做必要客户端适配，保留其页面、资金与未知操作保护。v3.1 的 Actor、会话事务检查、原结果 GET 和代理清理均已完成，不能依据下方历史缺项重复开发。

### 当前设备只读核对

GET `/player/push-subscriptions/status?endpointHash=...&subscriptionHash=...`：当前启用打手本人，返回 `{configured:boolean,status:'valid'|'unbound'|'invalid'|'unconfigured',pushEnabled:boolean}`。无浏览器订阅时不传两个指纹；有订阅时两者成对且为 64 位小写十六进制，否则400。`endpointHash` 为规范化 URL 的 `href` 的 UTF-8 SHA256；`subscriptionHash` 为 UTF-8 `JSON.stringify({endpoint:规范化href,keys:{p256dh,auth}})` 的 SHA256，键顺序如示例。不发送完整 endpoint/密钥到查询串。

`valid` 表示当前浏览器的完整订阅与当前账号后台绑定一致；`unbound` 同时覆盖未绑定、已撤销、其他账号，不能区分或透露他人身份；`invalid` 仅表示本人绑定的订阅内容与当前浏览器指纹不符；服务未配置优先 `unconfigured`。`pushEnabled` 是本人设置，关闭开关不等于撤销浏览器订阅。只读不重绑、不入队、不发测试通知、不写审计。普通打开设置页只读取；浏览器订阅、后台绑定、消息入队、发送服务接收和手机实际收到分别表达。

### 本人参与历史及全局安全搜索

GET `/player/orders?current=1&size=20&scope=all|direct|pool|mine&keyword=...&status=...&sortBy=createdAt|participatedAt&sortOrder=asc|desc`。`keyword` 去首尾空白后最多100字符，忽略大小写，仅匹配标题或工作室订单号；超长400，不搜索内部备注、平台私有单号或客户信息。授权与范围/关键词/其他筛选先于分页；`counts` 是这些筛选后的各状态计数，不受 status/分页影响；`total` 是再应用 status 后的真实总数。默认创建时间降序、ID降序，参与排序使用本人最后参与时间并以ID稳定排序。size 最大100。

`mine` 包含当前负责人/队友、本人接单或材料历史、本人退单及拒绝指定历史；仅指定而尚未接受不算参与。投影增加 `participation:'current'|'historical'|'available',lastParticipationAt:string|null,historyOnly:boolean`。历史参与只授予安全摘要：已失去当前私人详情授权时，房间码、客户游戏ID/联系方式、凭证、材料图片、内部备注与历史接单自由文本不可恢复，`historyOnly:true`，不可由历史入口进入详情或执行操作，`canClaim/canSubmit:false`。本人退单、拒绝及其处理原因保留既有白名单，不能读取他人原因。旧详情读取可兼容返回同一安全摘要。关联他人材料的图片下载也必须仍有当前负责人/队友权限；自有上传遵守既有所有权规则。如果新轮次重新授予当前指定/公共池资格，仍独立遵守现有授权及轮次机制，历史记录本身不授予资格。不更改等级、名额、押金或收款规则。

`counts` 按订单当前状态统计：本人曾参与的订单后来被他人执行，仍属于这份历史的 active 分布，不等于本人占用名额；名额继续以 profile/changes 的本人 `activeOrders` 为准。`return-pending` 同样是该订单当前有待审批申请，不宣称是本人申请次数。

客户端关键词交由服务端，界面区分“搜索本人参与历史”和“搜索全部授权任务”，不再以本页过滤冒充全局搜索。打手日期筛选仅支持 createdAt/completedAt；客户 paidAt 属内部信息，传入该日期口径返回403，不能以 total 推断隐藏日期。既有无参数数组读取暂保留兼容；新版客户端始终使用分页。

### 本人提现和账本分页

GET `/player/withdrawals?current=1&size=20&status=all|pending|approved|paid|rejected|canceled&start=YYYY-MM-DD&end=YYYY-MM-DD` 与 GET `/player/wallet/ledger?current=1&size=20&kind=...&start=YYYY-MM-DD&end=YYYY-MM-DD` 均返回 `{records,total,current,size}`，只允许本人，size最大100。日期按记录创建时刻的上海自然日、含边界筛选；记录以创建时间及ID降序。无效状态、类型、日期或反向区间400。kind支持空/all及 `reward,reward-correction,legacy-reward-snapshot,supplement,deduction,withdrawal-request,withdrawal-canceled,withdrawal-rejected,withdrawal-paid`，不新增资金含义；详情字段及收款方式快照保持原投影。

GET `/player/wallet?includeRecords=false` 返回完整权威钱包汇总、自然周次数与收款方式，`withdrawals:[],ledger:[]`；省略该参数保留旧全量数组兼容。新版钱包使用不带记录汇总，记录页使用独立分页，不能从当前页流水计算余额。原金额、原付款日、完成月、自然周次数、撤回、冲正及人工差额规则保持，不改写历史资金。

### 通知业务目标和旧通知跳转

打手消息增加 `target:{orderId:string,dispatchRound:number|null,assignmentId:string|null,submissionId:string|null}|null`，仅公开白名单，不返回内部 validity。创建时固定该条消息所指原轮次/接单/材料；历史未知字段为null，不用最新订单补造。非订单通知 target 为null。

GET `/player/notifications/:id` 只读取当前本人单条消息，404不泄露他人记录；按当前状态重新核验有效性，返回现有消息投影及 target。点击消息先查单条，再按当前权限 GET 当前订单；失效、轮次/接单/材料不符时提示旧目标已变化，不能执行过期操作。历史通知从不授予私人详情权限。未标定目标的旧消息只能读取当前授权状态，不猜历史身份。

### 验收边界

本轮实际复验发现原生 Web Locks 的排队回调可能先于另一 renderer 的存储标记传播。客户端沿用原 requestId 标记机制，将首次保留改为 `ifAvailable` 不排队；被占用且尚未读到原标记时保留发送门禁，收到原标记后只恢复原编号。该等待页没有发送新请求，不持久化或查询未发送的新编号；网络仍不持锁、不自动补发。保留者在写标记前取消且没有标记时，等待页保守保持限制，须重新加载核对，不自动猜测可再次提交。无 Web Locks 不保证首次跨标签原子提交，仍分别保存所有未知编号；本地存储不可用时不保证重载恢复。最终保护结论以增强的真实双标签验证为准，不宣称覆盖所有浏览器跨进程调度或跨 renderer 的绝对原子性。

本轮新证据使用 `.qa/final-closure-20261014/`，隔离真实磁盘库、随机回环端口和隔离账号，测试进程直接加载当前源码。最终测试前后记录包含新增文件的源码指纹；变化则重跑受影响验证及最终检查。完整回归、两端构建、联合UI与真实磁盘压力均须在实现稳定后执行，历史265项和独立打手交付不代替本次验收。模拟推送接收、模拟时钟排队与真实手机到达分开；请求并发不换算为在线人数。恢复仅生成新的离线副本，保留现有数据库/新交易；不发布或推送整个工作区。

联合测试设置 `STUDIO_QA_DECLARATIONS_DIR` 将 Vite 自动组件/API 声明及 lint 派生配置写到本轮输出目录，避免测试时改写源码造成版本指纹变化；普通开发及生产构建默认路径保持原样。最终构建先完成再冻结测试版本，磁盘压力单独运行，客户端真实读取负载使用该次构建的静态产物并核对产物指纹。

## 稳定性整改共享契约 v3.1（2026-10-14，本节优先于下方旧接口说明）

职责：后台任务统一维护本契约、服务端、根依赖、代理、管理后台和服务端测试；打手任务仅维护 `player-client/` 及客户端验证。双方使用独立临时数据库、输出目录和随机回环测试端口，不连接正式业务库，不停止对方服务。跨职责需求由后台提供提示词转交，不同时修改共享文件。

验收顺序（2026-10-14 用户补充）：等待手机端完成并交付改动清单、客户端验证和接口依赖，再由后台任务进行最终联合联调、完整回归及最终磁盘压力复测。在此之前的自动测试、后台页面验证及压力报告仅是后台独立验证，不标为双方联合验收或正式部署完成。

### 订单身份、过期保护及成功重试

最终联调发现的接口补充 v3.1：所有带 requestId 的关键 HTTP 写入必须发送 `X-Studio-Actor: 当前操作意图所属账号ID`，在捕获操作时固定，重试不换账号ID。缺失返回409 `PRECONDITION_REQUIRED`，与真实Cookie账号不符返回409 `PRINCIPAL_CHANGED`，保证业务尚未执行；客户端清理过期页面状态并重新确认，不能把失配当成功。服务端在同一写事务内重新核验当前会话令牌有效期、撤销状态、账号和权限，令牌失效返回401 `SESSION_EXPIRED`。响应后的 X-Studio-User 检查不能代替此保护。上传等其他认证写入若提供该头也核验，同时在写事务内验证会话。内部受信任服务调用和隔离造数不依赖HTTP头。

后台重试意图将所属账号固定为 `expectedActorId` 元数据，并由API层用它设置账号头；切换账号不会重写原意图的账号、内容或编号。打手端可沿用其现有 `operation.owner` 设置同一账号头，无需猜测或引入新的业务字段。

GET `/player/operation-results/:requestId?family=claim|reject|return|submit|withdraw|cancel-withdrawal` 是只读核对：只查询当前启用打手本人的原编号及匹配操作族，返回 `{requestId,family,status:'succeeded'|'not-recorded',operationConfirmed,result:'confirmation-only',createdAt:string|null,lateCommitPossible,canCreateNew:false,canRetryWithOriginal,legacy?}`。不返回旧订单快照、目标、金额、截图、收款码或请求体。本人失去订单可见范围后可确认本人原操作曾成功，但不得据此重新读取私有订单或重试。

`succeeded` 只确认原操作已成功，之后按当前权限读取现状；可能从升级前本人资金记录得到 `legacy:true` 的确认，但不授予编号复用权。`not-recorded` 只表示查询时未找到匹配成功记录，`lateCommitPossible:true`，不能证明原请求不会迟到，也不能解锁创建新编号；有原完整请求时可按当前授权重试同编号/同内容，无原请求体的恢复标记继续限制并交人工核对。未记录不伪装为已拒绝或仍处理中，查询本身不创建操作、幂等记录或审计。其他账号/其他族的编号等同未记录，避免存在性泄漏。

每笔订单返回 `revision:number`（独立递增）、`dispatchRound:number`（重新派单递增）、`assignmentId:string|null`（当前实际接单记录）、`submissionId:string|null`（最新材料记录）。接单历史新增 `id/dispatchRound`，材料及退单记录新增 `assignmentId/dispatchRound`。历史字段、接单、材料、结算和审计保留；旧记录使用稳定的兼容编号初始化，不公开历史自由备注。

以下关键提交必须有 `requestId`（1～128 字非空字符串）。订单操作还必须有 `expectedRevision`，不能从最新页面默默补值后重试：

| 操作 | 必要校验字段（除 requestId） |
| --- | --- |
| POST `/orders` | 新建不需版本；包含 `playerRemark`，旧 `remark` 为内部备注 |
| POST `/player/orders/:id/claim`（含接受指定单） | `expectedRevision,dispatchRound` |
| POST `/player/orders/:id/reject` | `expectedRevision,dispatchRound,reason` |
| POST `/player/orders/:id/submit` | `expectedRevision,assignmentId,leaderId,screenshots,teammateId?` |
| POST `/player/orders/:id/return-request` | `expectedRevision,assignmentId,leaderId,reason` |
| POST `/orders/:id/action` 编辑、派单、取消、备注、确认收款、金额更正、补偿结算、状态更正 | `action,expectedRevision` 与原业务字段；解除另需 `assignmentId,leaderId` |
| 同接口 `review-pass/review-return` | `expectedRevision,submissionId`，退回另需原因 |
| 同接口 `return-approve/return-reject` | `expectedRevision,assignmentId,leaderId,returnRequestId,reason` |

关键资金提交（订单收款、退款及审批、提现申请/撤回/审批/发放、工资发放、费用登记/软删除、打手补扣款/处理结果、储值和押金流水）同样要求 `requestId`。先验证当前登录、角色、操作权限及可见范围，再查成功记录。相同编号、操作者、操作路径/目标、完整请求内容返回原成功结果；首次执行才核对版本/轮次/身份。原结果是成功确认，不是当前状态，收到结果后必须重新读取。不同内容/操作者/目标复用编号返回 409；新编号不能绕过过期检查。检查、业务、资金、审计、消息与成功记录在同一事务提交或回滚。权限撤销后拒绝读取历史成功结果。

错误 JSON：`{message,code?,details?}`。缺校验字段返回 409 `PRECONDITION_REQUIRED`；版本不符 `ORDER_REVISION_CONFLICT`；派单轮次不符 `DISPATCH_ROUND_CONFLICT`；接单记录/负责人不符 `ASSIGNMENT_CONFLICT`；材料不符 `SUBMISSION_CONFLICT`；编号冲突 `REQUEST_ID_CONFLICT`。409 不自动再次执行，保留输入，刷新后重新确认并建立新操作意图。无响应/网络错误只重试原编号和原请求体。401/403 仍为认证/授权失败，429 带 `Retry-After`。

请求示例：`POST /player/orders/ORDER-ID/submit`，`{"requestId":"UUID","expectedRevision":4,"assignmentId":"ASSIGNMENT-ID","leaderId":"MY-USER-ID","screenshots":[{"id":"UPLOAD-ID"}],"teammateId":null}`。验收示例：`POST /orders/ORDER-ID/action`，`{"action":"review-pass","requestId":"UUID","expectedRevision":5,"submissionId":"SUBMISSION-ID"}`。不得使用缓存猜测缺少的身份字段。

### 本轮接单、付款和备注口径

名额只统计本人作为有效负责人的 `active` 接单中订单，退单待审批继续占名额；`review` 待验收释放名额，验收后才产生报酬。队友与指定待接受不占负责人名额。验收退回和下调上限保留已有订单，达到/超过上限拒新接单。后台状态更正允许原有必要例外，须说明原因，界面展示超限、停用账号等提醒，审计保留操作人及前后值。派单目标返回 `activeOrders,maxActiveOrders,pendingAssignments`。

足额收款才允许正常上报。落地付可先接单，未付款仍不可上报；手工取消须原因。没有押金门槛、自动处罚或付款超时取消。服务端事务最终裁决资格、名额、余额和付款；只读缓存不用于放行。

打手订单投影增加 `paymentConfirmed:boolean,canClaim:boolean,canSubmit:boolean,claimBlockedReason:{code,message}|null,submitBlockedReason:{code,message}|null,playerRemark:string`，保留 `claimEligible` 兼容别名。只提供是否足额收款，不返回客户金额、付款凭证或内部备注。`playerRemark` 是管理员明确维护的打手说明；历史 `remark` 保留为内部备注，兼容初始化为 `playerRemark:''`。

现金金额变更必须说明 `amountChangeKind:'historical-correction'|'price-change'` 和 `affectsHistoricalReceived:boolean` 并填写原因。已收款现金订单只有明确的历史录错更正可同步更正旧实收，仍归原付款日；普通改价不能伪造新增收款或退款。未付款改价不影响历史实收。真实补收的分笔收款、归属日期及退款顺序尚缺业务确认，本轮不新增该流程；使用原实际退款流程。保留整数分、原付款日经营统计、完成月工资、独立资金流水和结算冲正。

### 分页、轻量刷新和提醒

GET `/orders?current=1&size=20&...` -> `{records,total,current,size,counts}`；筛选采用管理页既有字段，日期为 `start/end/dateKey`。GET `/orders/:id` -> `{order,refunds,logs}`，按权限投影。

GET `/orders/dispatch-targets` 需内部账号 `orders.create` 或 `orders.edit`，返回 `{records:[{id,name,status,levelId,maxActiveOrders,activeOrders,pendingAssignments,playerAccess}]}`。GET `/changes?since=VERSION` 为后台轻量摘要 `{version,changed,serverTime,orderCounts,unreadCount}`；订单数量含 unpaid、compensation，按当前订单查看权限计算。`version` 是不透明字符串，包含账号/权限/业务版本和本人消息版本；异步消息入队、标已读、失效也会变更，不能当成订单 revision 使用。

GET `/player/orders?current=1&size=20&status=&scope=all|direct|pool|mine` -> `{records,total,current,size,counts}`，size 最大100。未传分页参数的旧读取短期保留数组格式，但危险写入不兼容缺校验字段。GET `/player/changes?since=VERSION` -> `{version,changed,serverTime,unreadCount,activeOrders,maxActiveOrders,pendingAssignments}`；每15秒及恢复网络/可见时读取，仅 changed 时刷新当前分页和当前详情。该摘要不能用于决定接单资格或余额。

GET `/notifications/timeouts?current=1&size=20` -> `{records,total,unread,current,size}`：直接查询仍有效且未读的指派超时，不先截取最新100条。提醒按派单轮次失效；仅编辑文字不重置轮次。公共池提醒使用同一接单资格判断，并核对通知设置；入队和外发前均验证，已接取、取消、重派、停用或关闭相关提醒即不再发旧新单提醒。资金历史消息保留。相同账号同设备重绑保留有效队列，换账号不得继承。保留退出撤销该账号订阅及相关待发任务的当前规则，可能影响该账号其他设备；本轮不更改多设备退出策略。

推送以原子租约领取，外发在业务事务外执行，限制并发，失败重试并处理过期任务。扫描按订单变化、开放时间和持久进度分批；不做每轮全量订单×打手扫描。发送服务返回成功仅表示服务接收，不等于手机实际收到。

GET `/runtime/metrics` 仅老板/超管且具备 `logs.view/settings.manage`：真实请求耗时/错误率、进程内存、磁盘/WAL/日志容量、队列积压和备份状态；演示监控不得冒充真实数据。可信代理列表显式配置，默认不信任转发头。

`bootstrap` 支持 `includeOrders=false/includeReports=false`，仍返回授权配置、人员和 orderCounts。后台订单页使用分页/详情按需读取，财务等尚需完整订单的旧页保持兼容。只在需要且有权限时计算报表；客户/押金余额和打手钱包批量读取。一个请求内复用只读解析，写事务重新读取权威状态。概览派生缓存最多32份，按账号、权限、筛选、业务及SQLite版本隔离，提交后清除；不缓存业务放行决定。

导出目录只返回模块/字段元数据，`rowCount:null` 表示尚未核算，界面显示待预览。预览计算真实总数，只保留前20条授权匹配；下载仅运行选中模块的行生成器。默认下载并发1、等待队列4、等待30秒，超额明确失败，不无限排队。

旧客户端危险写入的升级是必要兼容变化：读取的无分页数组短期保留，但无 requestId/身份/版本的写操作拒绝。重试成功结果受当前角色、开关及可见范围限制，原负责人已失去订单查看范围时返回403，不重新公开历史私有字段。历史接单缺少编号使用稳定兼容ID；若只有有效负责人而缺接单记录，补明确 `legacyInitialized:true`、未知 acceptedAt 空值，不能伪造历史接单时间。`remark` 与已有凭证不批量公开。

### 运行配置与恢复

| 配置 | 默认及用途 |
| --- | --- |
| `STUDIO_TRUSTED_PROXIES` | 空，不信任转发头；仅填写实际反向代理的IP/CIDR，从可信链右侧解析。代理先删除来访者 Forwarded / X-Forwarded-* / X-Real-IP，再设置真实连接来源 |
| `STUDIO_UPLOAD_RATE_PER_MINUTE` / `STUDIO_CLAIM_RATE_PER_MINUTE` | 每账号30次/分钟；另有来源保护，超限429带Retry-After |
| `STUDIO_UPLOAD_CONCURRENCY` / `STUDIO_UPLOAD_PER_USER` | 全局8、每账号2；图片签名和8MiB上限保持 |
| `STUDIO_EXPORT_CONCURRENCY` | 1，有限等待队列；指标包含等待时间 |
| `STUDIO_DISK_WARNING_MIB` / `STUDIO_DISK_MINIMUM_MIB` | 可用磁盘256MiB告警，低于64MiB拒上传；不伪装写入成功 |
| `STUDIO_WAL_WARNING_MIB` | WAL达到256MiB告警；不在请求中强制VACUUM或长时间阻塞 |
| `STUDIO_BACKUP_INTERVAL_MINUTES` | 0关闭；显式配置正数启用完整SQLite计划备份，线上一致性复制及完整性检查 |
| `STUDIO_BACKUP_DIR` / `STUDIO_BACKUP_RETENTION_COUNT` | 数据库旁backups，默认保留7份，最多90份；生产应配置独立备份介质/异地复制 |
| `STUDIO_BACKUP_FAILURE_WEBHOOK` | 可选HTTPS失败提醒接入点；不发送业务/秘密配置，失败状态显示于真实指标 |
| `STUDIO_UPLOAD_GC_ENABLED` | 默认false；true才启用至少7天前未引用上传回收 |
| `STUDIO_UPLOAD_GC_INTERVAL_MINUTES` / `STUDIO_UPLOAD_GC_RETENTION_DAYS` | 默认60分钟/7天，每批最多50，持久游标；保留当前状态、冷热审计、资金、成功请求及私人图片引用，不清除历史业务凭证 |

回收只删除可证明未引用的二进制，保留上传审计；引用不明确就保留。历史审计规模大时回收仍可能较慢，默认关闭，引用索引及实体表迁移留作后续容量方案。

恢复命令为 `node scripts/studio-backup.mjs --restore 已验证备份.sqlite 新的离线副本.sqlite`，不覆盖已有路径。先在独立目录启动副本、检查SQLite完整性和订单/资金/附件/消息数量，再制定正式切换窗口；保留切换前最新完整库，不能覆盖上线后的新交易。正式切换需部署授权；恢复前核对并清除副本中旧会话、推送订阅和待发任务，通知用户重新登录/绑定。库含私有业务资料，备份受控保管。

测试必须显式使用独立 `dbPath`；库实例默认 `maintenanceFromEnv:false`，不继承真实备份、回收、推送秘密或外发配置。CLI正式启动才显式读取部署环境配置；测试显式传入假密码和假推送配置，不读取真实初始密码文件。测试助手拒绝正式目录及3006/3007/3008，原始HTTP安全回归不使用助手补字段。

推送发送采用租约并在每项实际外发前续租，网络在事务外进行。两个发送器不会同时领取同一有效租约；服务接收后进程崩溃、尚未登记成功时，恢复可能至少一次重试，不能保证第三方绝对去重，也无法撤回已经在途的通用提醒。手机到达情况仍需真实设备验收。

## 通用约定与权限

源码业务类型以 `src/types/studio.ts` 为准，外观和概览分别见 `src/types/appearance.ts`、`src/types/overview.ts`。业务金额为整数分，比例为万分比（5%=500），日期为 `YYYY-MM-DD`，时间为 ISO8601，统计使用 `Asia/Shanghai`。编号和游戏 ID 是字符串，不将前导零或长编号转为数值。

所有接口前缀 `/api/studio`。成功 JSON 直接返回对象，错误为 `{message,code?,details?}`；401 表示未登录/登录失败，403 表示无权限，409 表示状态、版本或备份凭据冲突，日志容量不足返回 503。认证采用 HttpOnly、SameSite=Lax cookie，前端 fetch 使用 `credentials:'same-origin'`。业务实体与审计在 SQLite `BEGIN IMMEDIATE` 事务中一并提交或回滚。

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
| GET `/public-assets/:id` | 无 | 匿名仅允许当前已保存 Logo、已启用登录背景和登录左图，其余 ID 404 |

外观允许指定模式、HEX 颜色、整数遮罩、预设图标、登录文案/背景和玻璃样式。图片必须为本站真实上传附件：新图片属于当前配置人，已有配置图片可继续复用；不能借用他人订单/金融凭证，不能传任意 URL、SVG、HTML 或 CSS。登录后的品牌图片和启用业务背景可共享下载，配置管理员可预览当前配置中的未启用图片；共享只用于下载，不授予业务附件复用权限。匿名投影图片 URL 使用 `/api/studio/public-assets/:id`。

`login.illustration={mode:'default'|'image',image:Attachment|null}` 独立控制左侧大图，与 `login.background` 整页背景同时生效。旧配置缺字段自动使用原默认插图；草稿图片保存前不对匿名开放，恢复默认/移除后不再匿名提供旧图。匿名投影与配置审计只返回白名单字段。

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

`correct-status` 可选 pending/active/review/completed/canceled，五种状态可相互更正且无需截图，必须说明原因。普通管理员即使覆盖授权 `orders.edit` 仍禁止。执行/验收/完成须真实的打手负责人（允许历史停用账号），完成须足额收款；后台更正不受当前接单上限限制。`teammateId:null` 明确清空队友，未提供则沿用原值。后台免图记录保存 `source:'status-correction',correctedBy,correctionReason`，验收、日志、导出和诊断共同识别，不能伪装为打手提交截图。

已结算终态回退建立冲正扣补流水，不能裸改状态或抹去已付历史；超出可用余额的差额交人工处理。恢复只使用原负责人、队友和原报酬，保留原 completedAt/佣金月份；改结算人员或金额须另走财务差额处理，缺条件返回明确错误。已完成更正到待验收保留原材料审核历史，新增带 `recheckBy/recheckedAt/recheckReason/previousSubmissionId` 的复核材料，正常再次验收不重发奖励。

直接指定仍须打手接受，因此创建/派单后显示待接单。财务通过状态更正进行后台免图登记；打手本人正常上报仍须完成截图。双人报酬按整数分分配：负责人 `ceil(reward/2)`、队友 `floor(reward/2)`，奇数分多出的 1 分归负责人；所有结算、更正、冲正与诊断采用同一规则，原已结算快照仍按财务差额流程处理。

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

充值和押金缴纳 / 退还不记经营收入；客户 deduction 及退出 penalty 才按真实登记日计 days / overview 的 otherIncome，利润加入此项且订单营收不重复。报酬钱包扣补沿旧成本调整。导出新增 customerBalances/customerTransactions/playerDeposits/playerDepositTransactions，余额只为当前 snapshot，流水由授权 SQL 筛选后计数 / 读取，实际总计日期含 SQL 最早资金时间，超 100000 明确拒绝。人员 staff 改为非打手，新增 players 档案模块；加入固定班次后完整模块数为 35，批选上限 64，白名单授权保持。

## 人员、工资与考勤

POST `/users` `{id?,username,name,role,status,levelId,maxActiveOrders,permissionOverrides,password?,playerAccess?}` 需 `users.manage`；密码创建/重置仅管理员及超管，普通账号不能维护超管。停用、更换角色或重置密码撤销会话。playerAccess 三个严格布尔开关 login / claim / withdraw，旧默认为 true，关闭 login 撤销已有会话；claim 只拒新接单而允许已有提交，withdraw 只拒新申请而不改原报酬 / 在途提现。有未完订单、报酬、押金、在途提现或待追回差额时禁止 player 换角色隐藏资金。

GET `/players?current&size&name&username&levelId&status&login&claim&withdraw` 由 users.manage 或 finance.withdrawals 分页投影名单，财务只拿可见资金 / 基本信息，不扩大账号编辑权限；GET `/players/:id/orders?current&size` 提供真实接单 / 上报记录，按服务端实际订单查看授权返回，不伪造 history。前端人员管理的 employees / customers / players 直接复用原页，旧 /system/user（role=player 切玩家）、/orders/customers 为永久跳转，query/hash 保留，退出后仍有效。

POST `/salary-plans` 使用 SalaryPlan，需 `salary.manage`；`platformRates` 明确保存 0 或 null 的不同含义。POST `/payrolls` `{month}` 需同时有 `salary.manage` 与 `salary.all`，本人薪资授权不能用于全员月结。配置未齐禁止发放，工资保存历史快照；完成月计佣金，退款归原付款日并只扣新增多发佣金差额，补充结算不重发底薪。大厅运营提成固定 0，固定工资佣金为 0，已有有效计提比例/人员归属与发放底薪快照不随未来配置重算。月中换方案当前不按天折底薪，按工时计薪仍未开放。

POST `/attendance` `{id?,userId,date,start,end,status,actualHours?,remark}` 需 `attendance.manage`，同人同日一条。状态含 normal 正常、rest 休息，并保留 scheduled 待登记、present 到岗、leave 请假、absent 缺勤兼容值。

POST `/work-schedules` `{userId,effectiveFrom,enabled,start,end,remark}` 需 `attendance.manage`。固定班次采用每人每生效日唯一的版本，只允许今天或未来生效；启用时 start/end 为不同的有效 HH:mm，支持次日下班，停用时两者为空。同生效日可更新，过去版本不可改写。`bootstrap.workSchedules` 返回管理考勤、全员薪资或本人范围内的配置。已登记日考勤优先，固定班次只为未登记日期提供默认时间，不产生到岗工时、工资或每日记录。日志按权限投影；导出模块 `workSchedules` 保留可见版本，诊断核对有效日期/时间、人员关联和重复版本。

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

按用户后续确认，打手 1.0 为独立前端工程 `player-client/`，具有自己的 package/锁文件/入口/路由/状态和 `player-client/dist`；不再嵌入管理后台 Vue 工程。管理后台默认 3006，业务 API 默认 3007，独立打手端默认 3008；开发和生产前端代理 `/api/studio` 到现有后台端口，两端共用业务数据库、账号和资金规则。手机入口 `/#/player/login`，四个主页面为 lobby/tasks/rank/me。

打手代理强制增加 `X-Studio-Client: player`，仅转发 `studio_player_session`；管理后台仍读取 `studio_session`。两个会话在同一浏览器下分别登录和退出，Cookie 继续为 HttpOnly/SameSite=Lax，HTTPS 时 Secure。打手渠道登录在创建会话和审计前要求 player 角色，复制后台 token 到打手 Cookie 也不能使用后台身份。受保护 API 返回 `X-Studio-User` 本人 ID，独立前端在检测换号时清除旧请求与页面缓存。HTTP 对打手角色使用接口白名单；本人接口与 bootstrap 即使个人覆盖后台权限也不返回客户、员工工资、工作室利润或他人金融资料。手机不加载桌面菜单或全量后台 bootstrap。管理后台旧 `/#/player/*` 书签只跳转独立端，配置项 `VITE_PLAYER_CLIENT_URL`；独立端外部后台链接使用 `VITE_ADMIN_URL`。

独立客户端运行及发布说明见 [player-client/README](../player-client/README.md)。跨主机部署时将前端 Origin 配置到后端 `STUDIO_ALLOWED_ORIGINS`；同源前端代理转发会话/附件，不开放任意跨域 Cookie 或另建后端。静态代理 `scripts/player-client-server.mjs` 只提供客户端文件和固定接口转发，不接触业务库。

| 方法 / 路径 | 契约 |
| --- | --- |
| GET `/player/profile` | `{user,level,activeOrders,maxActiveOrders,paymentMethods}`，本人资料；profile 可维护称呼及本人上传的 avatar |
| GET `/player/orders`、`/player/orders/:id` | 可接公共单、本人指定单、本人参与或退单历史；白名单投影。接单前不返回 roomCode/gameId，始终不返回客户金额/联系方式、自由备注、派单审计、计提快照等 |
| POST `/player/orders/:id/claim` | 最新状态、指定人/等级、claim 开关和上限校验；并发唯一负责人 |
| POST `/player/orders/:id/reject` | `{reason}`；仅本人尚未接受的指定单，保持 pending，转为客服待分配 |
| POST `/player/orders/:id/return-request` | `{reason}`；仅 active 负责人，不释放名额；保留 returnRequests 历史 |
| POST `/orders/:id/action` | `return-approve` / `return-reject`，需 orders.edit、`returnRequestId,reason`；批准才清负责人并转待分配；重复或已失效申请 409 |
| POST `/player/orders/:id/submit` | `{screenshots,teammateId}`；负责人 1～10 张真实 PNG/JPEG/WebP 图片，单张 ≤8 MiB；进入 review 后释放名额，验收才产生报酬 |
| GET `/player/teammates` | 在用打手的 id/name/avatar，供选择实际队友，不带账号/钱包资料 |
| GET、POST `/player/payment-methods` | GET 返回数组；POST `{method,qrCode}`，method 为 wechat 或 alipay；仅本人新上传图片，不接受公开图/订单材料复用 |
| GET `/player/wallet` | 本人 available/occupied/paid/earned、withdrawals、ledger、paymentMethods、weekStart/weeklyLimit/weeklyUsed/weeklyRemaining |
| POST `/player/withdrawals` | `{amount,paymentMethod,requestId}`，正整数分、最少 1 分、手续费 0；保存 QR 快照，余额与每周最多 7 次事务校验 |
| POST `/player/withdrawals/:id/cancel` | `{requestId}`；仅本人 pending 可撤回，状态 canceled，释放余额和原申请周次数 |
| GET `/player/leaderboard` | month/type=orders或withdrawals/current/size；同成绩并列，下一名按人数顺延，无成绩不上榜；安全昵称、头像、成绩和 myRank |
| GET `/player/notifications` | 本人 records/total/unread/current/size；服务端持久消息，不将已读等同接单 |
| POST `/player/notifications/:id/read`、`/read-all` | 本人已读标记 |
| GET、POST `/player/notification-settings` | `{pool:boolean,push:boolean}`，公共池提醒默认关闭 |
| GET `/player/push-config` | enabled/configured/publicKey/reason；未配置明确返回原因，站内消息正常 |
| POST `/player/push-subscriptions` | `{subscription}`，绑定当前账号；HTTPS 浏览器服务端地址白名单，最多 5 个设备；不在客户端保存私钥 |
| POST `/player/push-subscriptions/remove`、`/test` | remove 提供 endpoint；test 只返回已排队，不能证明已到达 |
| GET `/notifications`、POST `/notifications/:id/read` | orders.edit 的后台人员查看本人的指定超时提醒；`/notifications/delivery-status` 为服务器发送队列汇总，不证明手机收到 |

`dispatchState?:'ready'|'unassigned'` 为兼容子状态，旧单默认 ready；pending+unassigned 不进入公共池，必须由客服再次 dispatch。拒单有 rejections，退单有 returnRequests（pending/approved/rejected/obsolete）；状态更正或取消使未处理退单 obsolete。处理检查最新状态及申请编号，不把退单当客户退款。

提现新增 canceled/paymentMethod/paymentSnapshot/weekStart/requestId/canceledAt。自然周按上海周一 00:00 算，计数绑定 createdAt 所属周，pending/approved/paid 占次数，rejected/canceled 不占；跨周处理只影响原周。创建和撤回 requestId 必填，同账号同路径同内容返回原结果，变化 409，权限在幂等命中前校验；财务审核/付款仍有终态保护。旧提现缺快照时显示历史资料未知，不补造二维码。私人二维码通过 player_private_uploads 持久分类，本人/授权财务可读，不能借外观、头像、他人材料或权限覆盖公开。

接单排行按有效完成日期统计负责人，结算有效且非全额退款；取消、回退与冲正不计，重新有效完成仍单次。提现榜只用 paidAt 和已登记发放金额，不包含押金。报表新增 orderReturns/orderRejections，目录总计 37 个模块；所有新增状态进入后台筛选、导出、审计和只读检查。

通知采用 15 秒前台轮询、30 秒服务端任务及持久推送 outbox。直接指定以该轮 publishedAt 作为指派时间，5 分钟未接受提醒客服，每轮指派去重；重新指派/拒绝/接受/取消使旧提醒失效。服务重启扫描未处理指派，公共池按等级延迟和开关提醒。订单/提现关键事件与业务在同一事务提交；消息读取不泄露推送密钥。退出、停用、关登录、重置密码或换账号绑定撤销旧订阅；外发只有通用提醒，不带账号、金额或订单秘密。

推送配置：STUDIO_PUSH_PUBLIC_KEY、STUDIO_PUSH_PRIVATE_KEY、STUDIO_PUSH_SUBJECT（mailto 或生产 HTTPS 地址），可选 STUDIO_PUSH_ALLOWED_HOSTS 扩展可信服务域名。默认不配置不会发送外部请求。发送最多重试 3 次，404/410 注销失效订阅并清理待发队列。Service Worker 仅处理通知，不缓存 API、附件或资金请求；index.html 和 player-sw.js 不长期缓存。HTTPS、添加桌面、用户主动授权和真实中国大陆手机网络验证是正式发布条件。

原源码服务器监控 `src/views/safeguard/server/index.vue` 是随机数和示例 IP 演示，不展示真实主机指标。现有 diagnostics 只检查业务数据；没有主机 health 或自动修复接口，维护入口为数据检查、日志容量、备份、归档及凭据清理，不提供远程命令执行。

## 原框架前端协作

共用原框架 Pinia：`src/store/modules/studio.ts` 保存服务器数据，`src/api/studio.ts` 封装真实接口，`src/hooks/business/useStudio.ts` 返回 refs `data,user,loading,error,selectedMonth` 和 `can,refresh(month?),mutate(path,body,method?),upload,login,logout`。成功修改自动刷新；业务数据不持久化到浏览器。

直接改造原 `src/views/dashboard/console`、`dashboard/analysis` 及 `system/user`、`role`、`menu`、`user-center` 页面。业务按原结构放在各 views 目录；表格复用 `ArtTable`、`ArtTableHeader`、`ArtSearchBar`、`useTableColumns`，图表复用 `ArtLineChart`/`ArtBarChart`，布局采用 art-card、ElCard 与响应式栅格。保留原模板组件/示例；真实业务菜单按服务端默认权限和个人覆盖过滤，不恢复独立应用、页面包装器或另一套全局样式。

## 打手端内容管理（2026-10-14）

协作边界（2026-10-14 用户确认）：管理后台页面、根目录 `src/`、`server/` 服务端接口及数据库相关变更，由后台对话维护；`player-client/` 手机前端由打手端对话维护。后台对话不得修改打手端前端及其构建输出；需要打手端调整展示、交互、路由、样式或接口调用时，生成包含接口契约和验收要求的提示词，由用户转交打手端对话实施。接口变更先更新本契约并保持已有调用兼容。修改前读取共用项目的当前实际文件，不能用旧版本覆盖现有实现；保留登录、财务、排班及其他已完成改动。

后台入口 `/system/player-content`，需 `settings.manage` 且为内部人员；打手角色即使覆盖该权限也不能编辑内容。内容独立于共享界面外观和后台登录配置，保存在原 SQLite 工作室状态中。

| 方法 / 路径 | 契约 |
| --- | --- |
| GET `/player-content` | `{items,serverTime}`；每项平铺草稿字段、`id,revision,createdAt,updatedAt,updatedBy,status,hasUnpublishedChanges,published`，管理员图片 URL 为内容资产接口 |
| POST `/player-content` | 保存草稿 `{id?,revision?,type,title,text,body,imageId,sortOrder,startAt,endAt}`；更新必须提供当前 revision，新建不提供；返回完整管理项 |
| POST `/player-content/:id/publish` | `{revision}`；将当前草稿复制为发布快照，返回管理项；结束时间已经过去时拒绝 |
| POST `/player-content/:id/offline` | `{revision}`；停止展示，保留草稿和最近发布版供预览及审计 |
| POST `/player-content/:id/delete` | `{revision}`；仅未发布草稿或已下架记录可删除；审计及原上传图片保留 |
| GET `/player-content/assets/:id` | 管理权限且该图片被现有草稿或发布快照引用时可读取 |
| GET `/player/content` | 仅启用中的打手；`{announcements,banners,serverTime}`，只返回当前有效发布快照，不返回草稿、版本、修改人 |
| GET `/player/content/:id` | 当前有效的单条发布内容；未开始、到期、下架或删除均 404 |
| GET `/player/content-assets/:id` | 仅启用中的打手；图片必须被当前有效发布快照引用，下架或到期即不可再读取 |

类型为 `announcement` 或 `banner`。标题最多 80 字、滚动文字 300 字、正文 20000 字，全部纯文本；不接受 HTML、任意图片地址、外链或脚本。图片只能使用实际上传的 PNG/JPEG/WebP，最大 8 MiB，新图必须属于当前编辑人；本条内容已有图片可被另一授权编辑人沿用。私人收款码、头像和业务凭证不能用作板报，也不能将板报图再作为业务凭证。

最多保留 100 条内容，`sortOrder` 为 0～9999 的整数，小的在前。日期为带时区 ISO 时间或 null，结束须晚于开始；界面显式按北京时间输入。开始含边界、结束不含边界，以服务端时钟判断。状态为 `draft/scheduled/active/expired/offline`。修改草稿的文字、图片、排序或日期均不改变已发布展示，必须重新发布；下架保留最近发布快照。所有写操作在同一业务事务中递增 revision 并写 `player-content` 审计，陈旧版本 409，回滚不留部分更新。

打手大厅每 15 秒读取一次，并在重新进入页面、恢复网络和切回窗口时更新。依据服务端时间与单调时钟隐藏到期内容；无发布内容时不占版面。轮播约 5 秒一张，支持手动切换、滑动、暂停；后台页面、离开大厅和降低动态效果偏好下停止自动切换。断网或读取失败不会影响接单功能，详情页能处理下架和过期。修改内容后不需要重新构建或部署前端。
