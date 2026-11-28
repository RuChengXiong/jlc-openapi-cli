# 参数写法

参数 schema 来自 `jlc-openapi-cli detail <路径> --json`。服务端契约优先，内置契约兜底；
`--refresh` 强制刷新，`--offline` 只用缓存/内置，`--builtin` 强制内置。

## 1. 顶层字段

```bash
jlc-openapi-cli /pcb/order/get \
  --customerOrderId 17618739 \
  --orderType examples
```

值默认按 schema 类型转换：`integer` → 数字，`number` → 小数，`boolean` →
`true/false`，其余保持字符串。裸 `--flag` 视为 `true`。

## 2. 嵌套对象

用点号路径：

```bash
jlc-openapi-cli /pcb/order/create \
  --orderTechnical.plateType 1 \
  --orderTechnical.stencilLayer 2 \
  --orderLinkMan.man "张三" \
  --orderLinkMan.phone "13500000000"
```

生成：

```json
{
  "orderTechnical": { "plateType": 1, "stencilLayer": 2 },
  "orderLinkMan": { "man": "张三", "phone": "13500000000" }
}
```

同一路径不能既赋标量又下钻（`--a 1 --a.b 2` 会报参数冲突）。

## 3. 数组

三种写法，按 schema 选择：

```bash
# 重复 flag（推荐，字符串数组）
jlc-openapi-cli /lcsc/openapi/bom/search --querys smt --querys 未知

# JSON 数组
jlc-openapi-cli /lcsc/openapi/bom/search --querys '["smt","未知"]'

# 数值数组可用逗号（items 为 integer/number 时）
jlc-openapi-cli /pcb/order/getList --customerOrderIdList 17618739,17618738
```

对象数组整体用 JSON：

```bash
jlc-openapi-cli /3dp-open/order/submitOrder \
  --deliveryType 1 \
  --modelPriceParamList '[{"modelAccessId":"m1","modelCount":2}]'
```

也可以按下标逐个构造：

```bash
jlc-openapi-cli /3dp-open/order/checkMaterialSizeLimit \
  --requests.0.modelAccessId m1 \
  --requests.0.materialTypeId 1
```

数组元素里的对象字段同样用点号：

```bash
jlc-openapi-cli /3dp-open/order/submitOrder \
  --deliveryType 1 \
  --modelPriceParamList.modelAccessId m1 \
  --modelPriceParamList.surfaceTreatmentList.craftCode C01
```

（点号进入数组时默认写入第一个元素；多个元素请用 JSON。）

## 4. 类型与大整数

- `integer` 只接受整数；`number` 接受小数。
- 超过 JS 安全整数范围的 ID 会按原始数字字面量发送，不会丢精度。
- 响应中的 `customerOrderId` 等 Long 字段同样按字符串处理，不要转成 Number。

## 5. 未知参数与 `--strict`

- 默认：契约未声明的参数会透传，并在 stderr 给出警告。这用于服务端新增字段或契约遗漏。
- `--strict`：未声明参数直接报错，适合确认调用正确性。
- 人工校对的接口（如 `/pcb/order/getOrderPageList`）默认启用必填校验；
  其他接口默认不强制必填，避免契约不完整阻断调用。
- `--no-validate`：跳过必填校验。

## 6. 完整 JSON body

```bash
jlc-openapi-cli /pcb/order/create --json '{"pcbFileUrl":"...","fileName":"Pcb.zip"}'
jlc-openapi-cli /pcb/order/create --json-file body.json
```

- `--json` 与 `--json-file` 互斥。
- 与逐字段参数互斥（multipart 例外：可再配合 `--file`）。
- 直接对传入的原文签名，不做重新序列化。

## 7. GET 接口

GET 接口的参数会转成查询串，数组重复 key，对象展开为 `parent.child`：

```bash
jlc-openapi-cli /3dp-open/order/getAllEnableMaterialInfo
```

签名使用 `GET\n/path?query\n...`，body 为空。

## 8. 文件字段

- 以 `detail --json` 的 `contentType=multipart` 和 `fileFields` 为准。
- `--file <路径>` 映射到接口的第一个文件字段。
- 也可用 `--<字段名> <路径>` 精确指定。
- 非文件字段正常作为表单字段；数组字段重复 append。
- multipart 的签名体：优先 `--sign-body`，其次 `meta` 字段，否则为非文件字段 JSON（默认 `{}`）。
- 文件必须是本地存在的普通文件，否则不会发请求。
