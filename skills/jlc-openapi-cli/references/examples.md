# 常用示例

所有示例都假设已完成 `jlc-openapi-cli init`。写操作（创建/提交/取消/删除）执行前
必须向用户确认参数和影响。

调用前建议先查契约：

```bash
jlc-openapi-cli list --search 订单
jlc-openapi-cli detail /pcb/order/create --json
```

`detail` 返回的 `agentGuidance` 必须遵守；`outputExample` / `errorCode` 可用于解释响应。

## PCB：分页查询订单（兼容旧路径）

```bash
jlc-openapi-cli /pcb/order/getOrderPageList \
  --orderType examples \
  --produceCode Y50504 \
  --orderByFlag true \
  --orderDateBegin "2026-11-11 00:00:00" \
  --orderDateEnd "2026-11-16 18:00:00" \
  --pageSize 10 --pageNum 1 --queryFilterFlag true \
  --compact
```

新文档对应 `/pcb/order/getList`（按订单 ID 批量查询）：

```bash
jlc-openapi-cli /pcb/order/getList \
  --customerOrderIdList 17618739 \
  --customerOrderIdList 17618738 \
  --orderType examples
```

## PCB：创建订单

```bash
jlc-openapi-cli /pcb/order/create \
  --pcbFileUrl "https://example.com/Pcb.zip" \
  --fileName "Pcb.zip" \
  --invoice "增值税发票" \
  --invoiceTitle "某某公司" \
  --expressType SF \
  --orderTechnical.plateType 1 \
  --orderTechnical.stencilLayer 2 \
  --orderTechnical.stencilLength 5.23 \
  --orderTechnical.stencilWidth 6.34 \
  --orderTechnical.stencilCounts 5 \
  --orderTechnical.stencilPly 1.6 \
  --orderTechnical.cuprumThickness 1 \
  --orderTechnical.adornColor 绿色 \
  --orderTechnical.adornBestrow 过孔盖油 \
  --orderTechnical.testProduct 全部测试 \
  --orderLinkMan.man "张三" \
  --orderLinkMan.phone "13500000000" \
  --orderReceive.consignee "张三" \
  --orderReceive.phone "13500000000" \
  --orderReceive.province "广东省" \
  --orderReceive.city "深圳市" \
  --orderReceive.area "福田区" \
  --orderReceive.address "某某大厦 14 楼"
```

字段很多时建议先用 `jlc-openapi-cli detail /pcb/order/create --json` 查看完整 schema，或用
`--json-file` 传完整 body。

## 3DP：提交订单

```bash
jlc-openapi-cli /3dp-open/order/submitOrder \
  --deliveryType 1 \
  --expressType SF \
  --modelPriceParamList '[{
    "materialAccessId":"m1",
    "contrastColorAccessId":"c1",
    "materialDeliveryAccessId":"d1",
    "modelAccessId":"model1",
    "modelCount":1
  }]' \
  --orderLinkMan.orderLinkMan "张三" \
  --orderLinkMan.orderLinkPhone "13500000000" \
  --receiverInfo.receiverName "张三" \
  --receiverInfo.receiverPhone "13500000000" \
  --receiverInfo.province "广东省" \
  --receiverInfo.city "深圳市" \
  --receiverInfo.area "福田区" \
  --receiverInfo.receiveAddress "某某大厦 14 楼"
```

## 3DP：上传模型文件

```bash
jlc-openapi-cli /3dp-open/order/uploadModelFile --file ./model.obj
# 需要自定义签名 meta 时：
jlc-openapi-cli /3dp-open/order/uploadModelFile --file ./model.obj --meta '{"traceId":"abc"}'
```

返回的 `modelAccessId` 用于报价或提交订单。

## BOM：型号批量搜索

```bash
jlc-openapi-cli /lcsc/openapi/bom/search --querys smt --querys 未知 --compact
```

## BOM：提交配单

```bash
jlc-openapi-cli /lcsc/openapi/bom/submit --file ./bom.xlsx
```

## 立创商城：商品信息/库存/价格

```bash
jlc-openapi-cli /lcsc/openapi/product/search/global --keyword "STM32"
jlc-openapi-cli /lcsc/openapi/stock/select/all/stock/by/id --productId 89553
jlc-openapi-cli /lcsc/openapi/product/get/price/by/code --productCode C88374
```

## 立创商城：订单详情/物流

```bash
jlc-openapi-cli /lcsc/openapi/order/detail --orderCode SO2301121880
jlc-openapi-cli /lcsc/openapi/order/progress --orderCode SO2301121880
```

## 云 ERP：分页查询入库单

```bash
jlc-openapi-cli /open/api/saas/erp/inventory/inStock/page \
  --pageNum 1 --pageSize 20
```

## 云 ERP：分页查询项目任务

```bash
jlc-openapi-cli /open/api/saas/erp/projectTask/page \
  --pageNum 1 --pageSize 20
```

## 云 ERP：上传临时文件

```bash
jlc-openapi-cli /open/api/saas/erp/file/uploadTmpFile \
  --file ./设计图.pdf \
  --fileTagIds 5001 \
  --fileTagIds 5002
```

## SMT：查询 SMT 订单信息

```bash
jlc-openapi-cli /smtOpenApi/order/selectSmtOrderInfo --customerOrderId 55166223
```

## 分页遍历通用模式

1. 先请求 `pageNum=1`，读取 `data.pages` / `data.total`（不同接口字段名可能不同）。
2. `pageNum` 递增直到取完。
3. 每次翻页向用户展示进度；`list` 为空时停止，不要无限循环。
