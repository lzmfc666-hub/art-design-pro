# 工作室第一版本地开发协作契约

源码类型以 `src/types/studio.ts` 为准。金额均为整数分，比例为万分比（5%=500），日期 YYYY-MM-DD，时间 ISO8601，统计使用 Asia/Shanghai。

所有接口前缀 `/api/studio`，JSON成功直接返回对象，错误 `{message}`。认证使用 HttpOnly SameSite cookie，前端 fetch credentials same-origin。

- GET `/session` -> `{user: Staff|null}`；POST `/login` `{username,password}` -> `{user}`；POST `/logout`。
- GET `/bootstrap?month=2026-10` -> StudioData。后端必须按权限过滤工资、利润、日志、用户数据。
- POST `/uploads` `{name,mime,data: base64}` -> Attachment，GET `/uploads/:id` 需认证与关联记录可见性校验。
- POST `/orders` 创建。请求含 templateId customerId platformId shopId externalOrderNo channel roomCode gameId map amount reward remark dispatchMode assignedTo receivedAmount paidAt receipt。校验普通单先收款、非闲鱼付款凭证、闲鱼店铺及平台单号、房间/游戏ID至少一项；仅大厅可落地付（body.payOnArrival=true）。
- POST `/orders/:id/action` action 值：edit（roomCode gameId map channel remark amount reward reason，待接单/接单中/待验收可用）、confirm-payment（receivedAmount paidAt receipt）、dispatch（dispatchMode assignedTo）、release（reason）、remark（remark）、cancel（reason）、review-pass、review-return（reason）、adjust（amount reward reason）、cancel-settle（reward teammateId reason）。打手完成上报只走 player 接口，后台无代上报按钮。
- POST `/refunds` `{orderId,amount,reason}` 财务可直接处理设 status=paid，客服申请 pending；POST `/refunds/:id/action` `{action:'approve'|'reject'|'resolve',reason}`。已提现打手的报酬差额先标记人工待处理，resolve 留处理说明。
- POST `/withdrawals/:id/action` `{action:'approve'|'reject'|'pay',reason?,receipt?}`。
- POST `/expenses` `{category,amount,date,purpose,receipt}`；POST `/expenses/:id/action` `{action:'delete'|'restore'}`。
- POST `/users` `{id?,username,name,role,status,levelId,maxActiveOrders,permissionOverrides,password?}`，角色/个人权限配置，密码创建/重置只管理员及超级管理员。`super_admin` 为独立超管角色，拥有全部权限，普通账号不能创建或维护超管；`admin` 为普通管理员。
- POST `/customers` Customer（id省略创建）。POST `/templates` OrderTemplate（id省略创建）。POST `/platforms` Platform；POST `/shops` Shop；POST `/levels` Level。同一条路由按可选 id 新增或修改。
- POST `/attendance` Attendance（id可省略，状态 scheduled 待登记排班 / present 到岗 / leave 请假 / absent 缺勤，仅到岗计入实际工时）；POST `/salary-plans` SalaryPlan；POST `/payrolls` `{month}` 只财务发放（配置未齐禁止发放，快照与退款扣回避免重复）。
- GET `/player/orders`；POST `/player/orders/:id/claim`；POST `/player/orders/:id/submit` `{screenshots,teammateId}`；GET `/player/wallet`；POST `/player/withdrawals` `{amount}`。这些是未来独立打手端接口，本期不做独立端UI。

权限名称统一：`orders.view`, `orders.create`, `orders.edit`, `finance.review`, `finance.refunds`, `finance.withdrawals`, `finance.expenses`, `salary.view`, `salary.all`, `salary.manage`, `profit.view`, `users.manage`, `templates.manage`, `settings.manage`, `attendance.manage`, `logs.view`。老板和店长默认有经营数据查看，财务有财务操作，admin维护账号配置，客服不开放工资。角色默认+个人覆盖。

前端共享 `src/studio/useStudio.ts`：`useStudio()` 返回 refs `data: Ref<StudioData|null>`, `user: Ref<Staff|null>`, `loading`, `error`，函数 `can(permission)`, `refresh(month?)`, `mutate(path, body, method?)`（相对前缀，成功自动 refresh）, `upload(file)`, `login`, `logout`。另外导出 `money(cents|null)`、`formatTime`、`statusLabels`、`roleLabels`。页面均自行导入 Vue API 与 ElMessage 等。

组件风格：沿用 Art Design Pro 原布局、主题、菜单及多标签页。业务页面通过 `src/views/studio` 包装组件进入原动态路由，在 `StudioPageHost` 中呈现。`studio-framework.css` 样式仅作用于 `.studio-content` / `.studio-dialog`，颜色使用主题变量。通用类有 `.page-heading`、`.panel`、`.panel-heading`、`.muted`、`.toolbar`、`.metric-grid`、`.metric-card`、`.split-grid`、`.empty-state`。
