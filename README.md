# jlc-openapi-cli

嘉立创开放平台命令行工具。封装了请求签名流程，可被 Claude Code、Codex 等智能体直接调用。

完整安装、配置与 Claude Code 使用说明见
[安装与使用指南](docs/安装与使用指南.md)。

仓库地址：<https://github.com/RuChengXiong/jlc-openapi-cli>

## 安装

```bash
npm install -g jlc-openapi-cli
```

要求 Node.js >= 18.17。

## 安装 Skill（可选）

仓库内置 `skills/jlc-openapi-cli`，可通过
[skills CLI](https://skills.sh) 安装给智能体：

```bash
npx skills add RuChengXiong/jlc-openapi-cli -y -g -a claude-code
```

`npx skills` 需要 Node.js >= 22.20。手动安装可把 `skills/jlc-openapi-cli/`
复制到 `~/.claude/skills/`（Claude Code）或 `~/.agents/skills/`（Codex 等）。

## 初始化

交互式：

```bash
jlc-openapi-cli init
```

非交互式（智能体 / CI 推荐）：

```bash
jlc-openapi-cli init \
  --appId "<APP_ID>" \
  --ak "<ACCESS_KEY>" \
  --sk "<SECRET_KEY>" \
  --endpoint "https://open-api.jlc.com"
```

配置写入 `~/.jlc-openapi-config.json`（权限尽量设为 0600）。生产地址为
`https://open-api.jlc.com`。

配置读取优先级：

1. `--config <path>`
2. 当前目录 `./jlc-openapi-config.json`
3. `~/.jlc-openapi-config.json`
4. 环境变量按字段覆盖：`JLC_OPENAPI_APP_ID`、`JLC_OPENAPI_ACCESS_KEY`、
   `JLC_OPENAPI_SECRET_KEY`、`JLC_OPENAPI_ENDPOINT`

## 接口覆盖

覆盖 `api-docs/` 中 6 大业务线的 110 个接口，并保留旧版
`/pcb/order/getOrderPageList` 兼容接口，共 111 个：

- PCB：在线计价、创建/返单、查询、物流、生产进度、价格明细
- SMT：订单、物料、私有库、元器件邮寄
- 3DP：模型上传、报价、提交/返单、问客、进度
- 元器件 & MRO：BOM 搜索/配单、询价、立创商城商品/库存/订单
- 嘉立创云 ERP：仓库、入库/出库、物料、项目、工时、采购/销售订单
- CNC：插件使用记录

## 使用

```bash
# 按关键词找接口
jlc-openapi-cli list --search 订单

# 查看单个接口的参数
jlc-openapi-cli list /pcb/order/create

# 机器可读目录（不含字段）
jlc-openapi-cli list --summary --json --compact
```

命令统一为 `jlc-openapi-cli <接口路径> <参数>`：

```bash
# 分页查询 PCB 订单
jlc-openapi-cli /pcb/order/getOrderPageList \
  --orderType "examples" \
  --produceCode "Y50504" \
  --orderByFlag true \
  --orderDateBegin "2026-11-11 00:00:00" \
  --orderDateEnd "2026-11-16 18:00:00" \
  --pageSize 10 \
  --pageNum 1 \
  --queryFilterFlag true
```

### 嵌套对象、数组与上传

```bash
# 点号路径
jlc-openapi-cli /pcb/order/create \
  --orderTechnical.plateType 1 \
  --orderTechnical.stencilLayer 2 \
  --orderLinkMan.man "张三" --orderLinkMan.phone "13500000000"

# 数组：重复 flag 或 JSON
jlc-openapi-cli /lcsc/openapi/bom/search --querys smt --querys 未知
jlc-openapi-cli /3dp-open/order/submitOrder \
  --deliveryType 1 \
  --modelPriceParamList '[{"modelAccessId":"m1","modelCount":1}]'

# 文件上传（multipart）
jlc-openapi-cli /3dp-open/order/uploadModelFile --file ./model.obj
jlc-openapi-cli /lcsc/openapi/bom/submit --file ./bom.xlsx
```

响应以格式化 JSON 输出到 stdout。业务失败时退出码为 1，但服务端响应仍会输出，便于排查。

### 通用调用

```bash
jlc-openapi-cli call /some/path --json '<body>' --method POST
jlc-openapi-cli call /some/path --json-file body.json --method POST
```

### 全局选项

| 选项 | 说明 |
| --- | --- |
| `--config <path>` | 指定配置文件 |
| `--endpoint <url>` | 临时覆盖 endpoint |
| `--json <body>` / `--json-file <path>` | 直接指定请求体（与逐字段参数互斥） |
| `--file <path>` | 上传文件（multipart 接口） |
| `--sign-body <json>` | 覆盖 multipart 的签名报文 |
| `--strict` | 禁止未声明参数并启用必填校验 |
| `--no-validate` | 跳过必填校验 |
| `--raw` | 原样输出响应 |
| `--compact` | 单行 JSON |
| `--timeout <ms>` | 请求超时，默认 30000 |
| `--debug` | 打印 URL、待签名串与 Authorization（不含 sk） |

### 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 业务失败（`code !== 200` 或 `success === false`） |
| 2 | 用法 / 配置错误 |
| 3 | 网络错误、超时、HTTP 非 2xx |
| 4 | 内部错误 |

### Windows / Git Bash 提示

Git Bash（MSYS）可能把 `/pcb/order/getOrderPageList` 改写成 `C:/Program Files/Git/pcb/...`。
可以设置 `MSYS_NO_PATHCONV=1`，或直接使用不带前导 `/` 的写法
`jlc-openapi-cli pcb/order/getOrderPageList ...`。

## 开发

```bash
npm install
npm run gen:endpoints   # 从 api-docs/ 重新生成接口注册表
npm run gen:check       # 校验生成物是否最新
npm run build
npm test
npm pack --dry-run
```

`api-docs/` 存放 110 份接口文档；`src/endpoints.generated.ts` 由
`scripts/gen-endpoints.mjs` 自动生成，请勿手工修改。重点接口的人工校正位于
`src/endpoints.overrides.ts`。

签名实现遵循嘉立创开放平台文档：

```text
METHOD\nPATH[?query]\nTIMESTAMP\nNONCE\nBODY\n
```

`signature = Base64(HmacSHA256(secretKey, stringToSign))`，并写入
`Authorization: JOP appid="...",accesskey="...",timestamp="...",nonce="...",signature="..."`。
