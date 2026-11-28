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

`init` 会把 skill 复制到 `~/.jlc-openapi-cli/skill` 并打印各智能体的安装路径。也可以直接用
[skills CLI](https://skills.sh) 从仓库安装：

```bash
npx skills add RuChengXiong/jlc-openapi-cli -y -g -a claude-code
```

`npx skills` 需要 Node.js >= 22.20。手动安装可把 `~/.jlc-openapi-cli/skill/`
复制到 `~/.claude/skills/jlc-openapi-cli`（Claude Code）或
`~/.agents/skills/jlc-openapi-cli`（Codex 等）。

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

## 动态接口契约

接口目录和参数契约优先从服务端获取：

- `jlc-openapi-cli list` → 服务端 `POST /list`（按 ak 返回可用接口）
- `jlc-openapi-cli detail <接口路径>` → 服务端 `POST /detail`
- 结果缓存到 `~/.jlc-openapi-cli/contracts-cache.json`，有效期 6 小时
- 服务端不可用时依次使用过期缓存、内置 111 条契约
- 业务请求的签名算法与调用方式完全不变

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--refresh` | 强制刷新服务端契约（不能与 `--offline`/`--builtin` 同用） |
| `--offline` | 不联网，只用本地缓存/内置契约 |
| `--builtin` | 强制使用内置契约 |

`invoke` 对已有内置接口默认走内置快路径；要使用服务端最新字段，先执行
`jlc-openapi-cli detail <路径>` 预热缓存，或在调用时加 `--refresh`。

缓存目录可用 `JLC_OPENAPI_CACHE_DIR` 覆盖。

## 接口覆盖

CLI 内置 111 个接口（110 份文档 + 旧版 `/pcb/order/getOrderPageList` 兼容接口）；
实际可用接口以服务端 `/list` 返回为准：

- PCB：在线计价、创建/返单、查询、物流、生产进度、价格明细
- SMT：订单、物料、私有库、元器件邮寄
- 3DP：模型上传、报价、提交/返单、问客、进度
- 元器件 & MRO：BOM 搜索/配单、询价、立创商城商品/库存/订单
- 嘉立创云 ERP：仓库、入库/出库、物料、项目、工时、采购/销售订单
- CNC：插件使用记录

## 使用

```bash
# 按关键词找接口（服务端 /list，缓存 6h）
jlc-openapi-cli list --search 订单

# 查看单个接口的完整契约（服务端 /detail）
jlc-openapi-cli detail /pcb/order/create

# 兼容写法：list <路径>
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
| `--timeout <ms>` | 业务请求超时，默认 30000 |
| `--refresh` | 强制刷新服务端契约 |
| `--offline` | 不联网，只用缓存/内置契约 |
| `--builtin` | 强制使用内置契约 |
| `--debug` | 打印 URL、待签名串与 Authorization（不含 sk/ak） |

### 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 业务失败（`code !== 200` 或 `success === false`） |
| 2 | 用法 / 配置错误 |
| 3 | 网络错误、超时、HTTP 非 2xx |
| 4 | 内部错误 |

### Windows / Git Bash 提示

Git Bash（MSYS）可能把 `/pcb/order/getOrderPageList` 改写成
`C:/Program Files/Git/pcb/order/getOrderPageList`。CLI 会自动剥离常见 Git Bash 前缀，
也仍可使用不带前导 `/` 的写法 `jlc-openapi-cli pcb/order/getOrderPageList ...`。
如果路径仍被改写，可设置 `MSYS_NO_PATHCONV=1`。

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

动态契约相关模块：

- `src/contracts.ts`：服务端契约类型、校验、递归字段拍平、与内置契约合并
- `src/contract-cache.ts`：6 小时本地缓存
- `src/contract-client.ts`：`/list`、`/detail` 请求与降级状态机
- `src/paths.ts`：MSYS / Git Bash 路径归一化
- `src/skill-install.ts`：`init` 时复制 skill

服务端接口规范见 [服务端契约接口修改计划](docs/服务端契约接口修改计划.md)；
内置接口离线快照见 [接口目录-内置快照](docs/接口目录-内置快照.md)。

签名实现遵循嘉立创开放平台文档：

```text
METHOD\nPATH[?query]\nTIMESTAMP\nNONCE\nBODY\n
```

`signature = Base64(HmacSHA256(secretKey, stringToSign))`，并写入
`Authorization: JOP appid="...",accesskey="...",timestamp="...",nonce="...",signature="..."`。
