
## 消息订阅事件（推送型，非调用接口）

以下事件由嘉立创主动 HTTP POST 推送到客户配置的接收地址（开放平台控制台配置接收 URL），不能用 CLI"调用"；AI 遇到"主动通知/推送/提醒"场景应建议使用事件替代轮询。覆盖范围以消息管理后台实际列表为准。推送报文含客户业务数据，注意脱敏与合规。

|eventType|事件名称|何时触发 / 用途|
|-|-|-|
|pcb_submit_order_notice|PCB创建订单通知|何时触发：客户成功创建 PCB 订单后系统自动推送（用户问『下单后有没有通知/怎么把订单同步到自己系统』时推荐订阅）｜ 报文要点：body.data 为 JSON 字符串需先反序列化，取 fileName(设计文件名)/produceCode(Y开头生产单号，不可当查询入参)/customerOrderId(客户订单ID，回查接口用它)/messageRequestTime(毫秒时间戳)｜用途/替代建议：客户侧自动建单落库，创建成功与否以此通知为准，无需创建后轮询订单状态|
|pcb_deliver_notice|PCB发货完成通知|何时触发：订单发货完成后推送（『发货了怎么通知我/要同步物流』场景）｜ 报文要点：在通用字段外含 expressNo(快递单号)+freightMode(快递公司)｜用途/替代建议：发货节点用它替代物流轨迹轮询——收到即置『已发货』，后续详细轨迹再按需调快递轨迹接口（轨迹接口频控紧张勿轮询）|
|pcb_cancel_order_notice|PCB取消订单通知|何时触发：订单被取消后推送（『订单取消会通知吗』场景）｜ 报文要点：fileName/produceCode/customerOrderId/messageRequestTime，不含取消原因｜用途/替代建议：客户系统置订单『已取消』并叫停后续生产/物流流程，避免靠轮询发现取消；想知道取消原因需自行走客服/工程渠道|
|pcb_ask_payment_notice|PCB提醒客户支付通知|何时触发：订单待支付、嘉立创提醒客户付款时推送（『催款/待支付提醒』场景）｜ 报文要点：fileName/produceCode/customerOrderId/messageRequestTime｜用途/替代建议：触发自家财务付款流程；注意这只是『提醒付款』动作通知，不等于已付款回执，付款结果仍需自行核对|
|pcb_confirm_file_notice|PCB提醒补款通知|何时触发：订单需补款时推送（如增加板子数量）｜ 报文要点：⚠️body.data 为 {encrypted} 加密数据需按约定解密后再取字段；业务字段含 suppleMoney(补款金额)/supplementResaon(补款原因，字段拼写即如此)/orderMoney(订单总额)/orderDate(下单时间戳)｜用途/替代建议：补款核对与财务流程触发，补款信息以此通知为唯一来源；|
|pcb_modify_order_notice|PCB改单通知|何时触发：订单被修改（改单）后推送（『改单会通知吗』场景）｜ 报文要点：fileName/produceCode/customerOrderId/messageRequestTime，不含改单明细｜用途/替代建议：仅告知『有改动』，具体改了什么需用 customerOrderId 回查订单接口或与工程确认后更新本地生产计划，不可只凭通知推断改动内容|
|pcb_confirm_file_notice|PCB确认生产稿通知|何时触发：生产稿状态变更时推送（『生产稿/工程稿确认进度』场景）｜ 报文要点：productionFileStatusEnum(1=已制作完成/2=客户确认无问题/3=客户确认有问题/4=重新制作完成)、confirmFileType(0=客户确认/1=系统自动确认/2=代客确认)——枚举陷阱：1/4 是『稿好了待确认』、2/3 是『客户已表态』，勿混用｜用途/替代建议：驱动客户侧确认生产稿流程，替代人工盯工程稿|
|pcb_order_audit_exception_notice|PCB订单审单异常通知|何时触发：订单审单异常时推送（『审单不过/订单卡住异常』场景）｜ 报文要点：fileName/produceCode/customerOrderId/messageRequestTime，不含异常原因明细｜用途/替代建议：告警驱动人工介入（联系嘉立创问异常原因并调整订单），不能只靠通知定位根因，建议配合待办/提醒机制防漏处理|
|pcb_ask_guest_notice|PCB问客信息通知|何时触发：嘉立创向客户提问（问客）时推送（『客服提了问题要回复/待回复问询』场景）｜ 报文要点：fileName/produceCode/customerOrderId/messageRequestTime，不含问题内容本身｜用途/替代建议：提醒专人去相应渠道回复问客（设计细节/交期等），问题详情需到问询渠道查看，问客不回复会卡生产节奏|

说明：pcb_need_supplement_notice 为安全模式（密文）传输。
