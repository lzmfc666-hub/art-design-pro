# 打手端 v3.1 接口适配交接

2026-10-14 后续状态：原结果 GET、原账号头和代理清理已直接保留。顶部共享契约 v3.2 的五类读取已定稿并接入最小客户端适配，最终后台统一交接见 [HANDOFF-V3.2.md](./HANDOFF-V3.2.md)；本文以下独立验证与“仍保留的依赖”是 v3.1 交付时的历史状态，不代表本轮最终缺项或联合结论。

日期：2026-10-14。本轮根据用户转交的 `docs/打手端稳定性接口适配提示词.txt` 及共享契约 v3.1 补齐原操作结果、原账号头和本工程代理清理。所有修改位于 `player-client/`，保留原业务及已有未提交修改。服务端、共享契约、根依赖/代理、后台页面与后台测试未修改；没有访问正式数据库或停止既有服务。

## 契约快照

`C:/Users/Administrator/Desktop/system/docs/STUDIO-CONTRACT.md` 顶部 v3.1 优先，最后核对修改时间2026-10-14 04:20:35、54172字节，SHA256：

`27A3ED6A3607C15D56512B5DA28F885CCE9C8F00DABB20E07F0341464A43080D`

## 修改文件和行为

- `src/api/studio.ts`、`src/main.ts`：fetch/XHR 支持 `X-Studio-Actor`。关键写入显式使用原意图 owner；普通认证 POST 在调用开始捕获账号；上传在压缩前捕获，后来账号变化不能替换。登录不发送账号头。明确拒绝保留409 `PRECONDITION_REQUIRED/PRINCIPAL_CHANGED`，过期保留401 `SESSION_EXPIRED`；清理过期页面并提示重新登录。响应头核验继续用于隔离，不能代替后台事务校验。
- `src/types/player.ts`、`src/api/player.ts`：增加真实 `PlayerOperationResult` 类型及 `GET /player/operation-results/:requestId?family=...`。保留所有状态、资格和迟到标志。原有关键写入封装也要求原 owner，不回退捕获新账号。
- `src/api/operations.ts`：冻结原 owner、requestId、完整 body、路径和目标，发送原账号头。注册真实结构化查询；只将 `succeeded/operationConfirmed` 视为原操作成功确认，不展示原快照。`not-recorded` 保持 unknown 和同类限制，不因未查到记录生成新编号；只有原完整 body 和 `canRetryWithOriginal:true` 才提供显式同编号重试。恢复标记无 body 禁止重试。查询403/读取失败撤掉重试资格但不认定失败、不清未知标记；未知操作的重试被拒绝也不证明先前请求不会迟到。
- `src/api/operationGuard.ts`：标记按账号、操作族及每个 requestId 独立保存，兼容旧单槽格式；确认只清对应编号，余下编号继续核对。原生 Web Locks 可用时，只在保留意图时加原子锁，不把网络请求放进锁或补发队列。没有 Web Locks 时不声称原子单次提交，但所有未确认编号不会互相覆盖。标记始终只有 owner/family/requestId/createdAt，没有金额、目标、路径、附件或请求体。
- `OperationState.vue`：确认结果、待核对和拒绝分别表达；资格变动或查询失败撤掉重试确认框。
- `Lobby.vue`、`OrderDetail.vue`、`Wallet.vue`、`Withdrawals.vue`：核对/手工重试期间限制新操作，直到当前资源读取结束。资金页面最新读取失败时继续禁新写入；成功提示指向当前记录，不把“原申请已成功”说成“目前仍等待审核”。减少核对后重复读取。
- `vite.config.ts`：仅修改明确交接的本工程开发/预览代理。删除来访者 Forwarded、所有 X-Forwarded-* 和 X-Real-IP，再以 `original.socket.remoteAddress` 设置 X-Forwarded-For；只转发 studio_player_session，固定 X-Studio-Client:player，保留原 Actor 头。没有修改根 Vite、生产代理或后台可信代理配置。

新增/更新的客户端验证：`tests/request-actor-v31.mjs`、`tests/request-actor-browser-harness.ts`、`tests/request-runtime-harness.ts`、`tests/request-runtime.test.mjs`、`tests/proxy-v31.mjs`、`tests/operation-results-v31.mjs`、`tests/operation-concurrency-v31.mjs`及对应本工程 `.qa/` 证据。README、旧交接与需求记录已注明当前落实状态。

## 实际独立验证

使用独立 `:memory:` 数据库、隔离账号和随机回环测试端口，不读取真实秘密或业务库。业务场景经真实服务端 HTTP 执行；响应丢失是在真实请求执行后丢弃响应，未伪造成功。全部临时测试服务已关闭。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 捕获原账号、原生fetch/XHR、压缩期间账号变化、错配409、缺头409、延迟正文期间退出401 | 8组通过 | `.qa/request-v31/results.json` |
| 原结果读取、刷新标记、原号原内容重试、迟到提交、关闭资格、403、最新读取失败/未完成时的门禁 | 11组通过，115次已记录真实HTTP，8次客户端关键POST，12次结果GET | `.qa/operation-results-v31/results.json` |
| 实际Vite配置的伪造头清理、Cookie/渠道隔离、原actor转发、真实后台无副作用拒绝及确认 | 6组通过，23次HTTP；全部临时端口随机分配 | `.qa/proxy-v31/results.json` |
| 同账号跨标签原子保留、刷新恢复、独立多编号、旧格式兼容、依次确认不清其他编号 | 6组通过，96次已记录真实HTTP | `.qa/operation-concurrency-v31/results.json` |
| 既有超时/取消/合并、迟到401、摘要变更竞态、退避及真实403/404私字段清理 | 15组通过 | `.qa/request-v2/results.json` |

真实重点结果：

1. 抢单实际成功但响应丢失后，GET确认成功；后台已更改的订单文本/版本通过最新读取展示，没有恢复旧成功快照。
2. 整页刷新只有待核对标记，仍能GET确认并解除限制，没有重复POST或重建原body。
3. 提现成功丢响应，财务随后驳回；核对确认原申请曾成功，钱包展示当前退款/余额与最新记录，提示不会说仍待审核。
4. 查询未记录时保留同类锁；手工重试保持原编号、body和Actor。原请求真正延迟在HTTP正文后到达，也只产生一条接单记录/成功记录，没有新编号。
5. 关闭接单资格使 `canRetryWithOriginal:false`，不展示重试；无原body的恢复标记即使服务端允许重试也不提供按钮。真实403经过认证故障转发不会将原结果认定为失败或清标记。
6. 原成功确认后的钱包GET实际503错误转发场景，仍禁新资金写入；成功读取最新钱包后才恢复。原请求重试成功但订单GET被延迟时，页面仍禁新增提交，不能产生第三个意图。
7. B Cookie/A Actor 返回409，没有负责人、接单、审计成功记录等业务副作用；B无法通过结果GET发现A原成功。
8. 有原生Web Locks的两标签同时首次提交，只发送一笔真实抢单；响应丢失后另一标签、刷新后的标签仍持有原编号限制，查询确认后实际执行数量为1。无Web Locks组使用两笔真实成功但丢响应的编号验证最坏情况下独立保存/逐项确认：确认第一笔不清第二笔，最终实际数量为2，不声称降级模式同样原子。

说明：503、403为客户端故障注入，转发的是隔离后台实际错误响应，不模拟业务成功、不绑定设备或外发推送。请求层的读取记录并非所有造数HTTP总量；分套验证存在场景交叉，不合计成互不重复业务场景。此次没有重复实现后台9项竞态与7项结果读取测试，也没有执行后台的最终全系统回归。

## 构建及交接状态

- `pnpm --dir player-client typecheck`：通过，`.qa/typecheck-v31.log`。
- `pnpm --dir player-client build`：通过，包含类型检查与生产构建，`.qa/build-v31.log`；产物只在本工程 `dist/`。
- 最终入口119.64 kB（gzip47.22 kB），保留路由分包。没有进行生产容量/磁盘压力测试。
- 现有 `http://127.0.0.1:3008/` 只读访问200；没有重启后台进程。常驻后台载入v3.1与最终部署由后台任务确认。

本次转交的三项接口适配已完成独立验证，可以交后台继续按共享契约执行最终联合联调、完整回归及最终磁盘压力复测。不能把本记录或后台先前独立测试称为双方联合验收或正式部署。

## 仍保留的依赖和实际设备项目

原结果GET和原子账号校验已不再是缺项。当前设备后台绑定读取、mine参与历史、安全全局关键词搜索、提现/账本容量分页及完整通知业务目标投影仍由后台定稿，本轮没有猜接口或扩展资格规则。旧需求及状态见 `BACKEND-V3-REQUEST.md`。

`not-recorded` 仍可能迟到，不能时间到期后自动清限制。无完整原body时继续联系后台人工核对。浏览器存储不可用时无法保证重载恢复；无 Web Locks时不保证跨标签原子单次首次提交，但可独立保留所有编号，避免误丢未知操作。

本轮保留既有视觉和手机布局；390宽新提示/重试入口已浏览器检查，原320/390/430/768及键盘几何证据保留于v3记录。本轮不声称重复完成全部页面视觉验收。真实安卓/iPhone、HTTPS、系统键盘/安全区、锁屏、关闭网页后的推送及移动网络到达仍未验证，不声称推送必达。
