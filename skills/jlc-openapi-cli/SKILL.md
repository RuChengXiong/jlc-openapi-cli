---
name: jlc-openapi-cli
description: 嘉立创开放平台（JLC OpenAPI，open-api.jlc.com）命令行工具，接口契约从服务端动态获取，覆盖 PCB、SMT、3D 打印、CNC、元器件/MRO（立创商城）与嘉立创云 ERP：查询/创建订单、返单、在线计价、BOM 配单、问客、元器件邮寄、库存与项目任务等。当用户提到嘉立创、JLC、PCB 订单、SMT、3D 打印、BOM、立创商城、LCSC、嘉立创云 ERP、open-api.jlc.com，或要求调用这些业务接口时使用。
---

# 嘉立创开放平台 CLI

`jlc-openapi-cli` 封装了嘉立创开放平台的请求签名与 HTTP 调用，统一命令形式：

```bash
jlc-openapi-cli <接口路径> <参数>
```

stdout 是服务端 JSON，stderr 是诊断信息。

## 前置检查

```bash
jlc-openapi-cli --version
```

未安装时（Node.js >= 18.17）：

```bash
npm install -g jlc-openapi-cli
```

不要建议 `sudo npm install -g`；无权限时让用户配置 npm 用户级 prefix 或使用 nvm。

## 配置凭据

运行时配置优先级：`--config` > 当前目录 `./jlc-openapi-config.json` >
`~/.jlc-openapi-config.json`；环境变量按字段覆盖。

**使用非交互方式配置**，不要尝试回答交互式提示：

```bash
jlc-openapi-cli init \
  --appId "<APP_ID>" \
  --ak "<ACCESS_KEY>" \
  --sk "<SECRET_KEY>" \
  --endpoint "https://open-api.jlc.com"
```

- 生产：`https://open-api.jlc.com`；
- 缺少凭据时向用户索取，**不要猜测或编造**。
- 也可用环境变量：`JLC_OPENAPI_APP_ID`、`JLC_OPENAPI_ACCESS_KEY`、
  `JLC_OPENAPI_SECRET_KEY`、`JLC_OPENAPI_ENDPOINT`。
- 永远不要打印、cat 或提交 `~/.jlc-openapi-config.json`。
- `init` 会把 skill 复制到 `~/.jlc-openapi-cli/skill` 并打印安装路径；不需要时加 `--no-skill`。

## 工作流：找接口 → 看契约 → 调用

接口目录和参数不是写死的，优先从服务端获取：

```bash
# 1. 按关键词找接口（服务端 /list，缓存 6h）
jlc-openapi-cli list --search 订单

# 2. 查看某个接口的完整契约（服务端 /detail）
jlc-openapi-cli detail /pcb/order/create

# 3. 按契约调用
jlc-openapi-cli /pcb/order/create --pcbFileUrl "https://..." --fileName "Pcb.zip" ...
```

- `list <路径>` 是 `detail <路径>` 的兼容写法。
- 机器可读目录：`list --summary --json --compact`（不含 fields）。
- 单个接口完整契约：`detail <路径> --json`。
- 契约来源会在文本和 JSON 中标注：
  - `server`：刚刚从服务端获取；
  - `cache`：本地 6 小时缓存；
  - `stale-cache`：服务端不可用，使用过期缓存；
  - `bundled`：内置 111 条兜底契约。
- 看到 `bundled` 且找不到新接口时，提示用户检查 `endpoint`、网络，或运行 `list --refresh`。
- `--refresh` 强制刷新；`--offline` 只用缓存/内置；`--builtin` 强制内置；
  `--refresh` 不能与 `--offline`/`--builtin` 同用。
- `list`/`detail` 是网络优先；`invoke` 对已有内置接口默认走内置快路径。要确保 invoke
  使用服务端最新字段，先执行 `detail <路径>` 预热缓存，或在 invoke 时加 `--refresh`。
- 遇到“通知/推送/提醒”场景 → 先查 `references/events.md` 有无事件可订阅，没有再轮询。

## 遵守 agentGuidance

`detail` 返回的 `agentGuidance` 是服务端给出的使用约束（前置条件、幂等性、不可恢复、
频控等），必须遵守；与用户要求冲突时先询问用户。`output` / `outputExample` / `errorCode`
用于解释响应和错误。

## 参数写法

| 场景 | 写法 | 示例 |
| --- | --- | --- |
| 顶层字段 | `--字段 值` | `--orderType examples` |
| 嵌套对象 | `--父.子 值` | `--orderTechnical.plateType 1` |
| 数组 | 重复 flag / JSON 数组 | `--querys a --querys b` 或 `--querys '["a","b"]'` |
| 对象数组 | JSON | `--modelPriceParamList '[{"modelAccessId":"m1"}]'` |
| 数组元素 | 下标路径 | `--requests.0.modelAccessId m1` |
| 完整 body | `--json` / `--json-file` | `--json-file body.json` |
| 文件上传 | `--file <路径>` | `--file ./model.stl` |

- 布尔值支持 `true/false/1/0/yes/no`；裸 `--flag` 表示 `true`。
- `--json` 与逐字段参数互斥；multipart 接口可用 `--json` 传非文件字段，再配合 `--file`。
- 复杂或含引号的 body 优先用 `--json-file`，避免 shell 转义。
- 契约未声明的新字段仍可用点号路径透传；`--strict` 可禁止未声明参数。

详细规则见 `references/parameters.md`。

## 文件上传

以 `detail --json` 返回的 `contentType=multipart` 和 `fileFields` 为准，例如：

```bash
jlc-openapi-cli /3dp-open/order/uploadModelFile --file ./model.obj
jlc-openapi-cli /lcsc/openapi/bom/submit --file ./bom.xlsx
jlc-openapi-cli /open/api/saas/erp/file/uploadTmpFile --file ./设计图.pdf --fileTagIds 5001
```

3DP 上传的 `meta` 用于签名，默认 `{}`；特殊情况下可用 `--sign-body` 覆盖。
详见 `references/examples.md#上传`。

## 安全与写操作

- 涉及创建订单、返单、提交、取消、删除、修改库存或项目状态时，**先向用户确认参数和影响**再执行。
- 不要盲目重试写操作；超时后先查询状态。
- 分享命令时用 `<APP_ID>` / `<ACCESS_KEY>` / `<SECRET_KEY>` 占位。
- 不要输出 sk、Authorization 或配置文件内容；`--debug` 只在用户明确要求排查时使用。

## 退出码

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| 0 | 成功 | 解析 stdout |
| 1 | 业务失败（`code !== 200` 或 `success === false`） | stdout 仍有响应；读 `code`/`message`，不要盲目重试 |
| 2 | 用法/配置错误 | 按 stderr 的 `message` 修正 |
| 3 | 网络/超时/HTTP 非 2xx | 只读查询可重试一次；写操作不要自动重试 |
| 4 | 内部错误 | 报告 stderr |

## 按任务加载参考文档

| 任务 | 打开 |
| --- | --- |
| 需要内置接口快照（离线兜底） | `jlc-openapi-cli list --builtin --summary` |
| 嵌套/数组/类型/`--json` 细节 | `references/parameters.md` |
| 跨业务线完整示例 | `references/examples.md` |
| 报错、签名、429、Git Bash、契约缓存 | `references/troubleshooting.md` |
