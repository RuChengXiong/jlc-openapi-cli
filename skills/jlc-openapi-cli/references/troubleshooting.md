# 排障

## 错误输出

错误统一输出到 stderr，单行 JSON：

```json
{"error":{"type":"usage","message":"缺少必填参数：--orderType"}}
```

- `type=usage|config`：退出码 2，按 message 修正参数或运行 `init`。
- `type=network|http`：退出码 3，检查网络、endpoint、代理、系统时间。
- 业务失败：退出码 1，但 stdout 仍有服务端完整响应，读取 `code`/`message`。

## 签名失败 / 401 / `code: 1000`

- 检查系统时间是否准确：签名时间戳是**秒级**，偏差过大会被拒绝。
- 确认 appId、ak、sk 属于同一个应用。
- 确认 endpoint 环境一致（生产 / 测试）。
- 用 `--debug` 查看 stringToSign 的五行格式（仅在用户要求排查时使用）。

## `HTTP 429`

开放平台返回“接口请求已超过 API 每天额度限制”。等待次日额度恢复或联系嘉立创，
不要通过重试绕过。

## `command not found`

```bash
npm install -g jlc-openapi-cli
npm prefix -g   # 确认全局 bin 目录在 PATH 中
```

## Git Bash / MSYS 把路径改写

现象：`/pcb/order/create` 被转成 `C:/Program Files/Git/pcb/order/create`。

CLI 会自动剥离常见的 `C:/Program Files/Git`、`/c/Program Files/Git` 等前缀，通常不需要额外处理。
如果仍被改写，可设置：

```bash
export MSYS_NO_PATHCONV=1
# 或使用不带前导 / 的写法
jlc-openapi-cli pcb/order/create ...
```

## 未知参数警告

默认会把契约未声明的参数透传，并打印：

```text
警告：未知参数 --foo，已透传。使用 --strict 可禁止未声明参数。
```

- 确认字段名是否写错：`jlc-openapi-cli detail <路径> --json`。
- 需要严格校验时加 `--strict`。
- 复杂或未解析的字段可用 `--json-file` 直接传 body。

## 必填参数误报

只有人工校对的接口默认强制必填（如 `/pcb/order/getOrderPageList`）。
其他接口文档由 PDF 转换，必填标记可能不准确，默认不阻断调用。
可用 `--no-validate` 跳过校验。

## multipart 上传

- `--file` 只接受本地存在的普通文件；路径会按当前工作目录解析。
- 3DP 上传的签名体是 `meta`，默认 `{}`；ERP/BOM 上传默认用非文件字段 JSON。
- 如果服务端返回签名错误，可用 `--sign-body '<json>'` 显式指定签名体。
- multipart 请求不要手动设置 `Content-Type`，CLI 会交给 fetch 生成 boundary。

## 配置相关

- 配置优先级：`--config` > 当前目录 > 用户主目录 > 环境变量按字段覆盖。
- 缺少配置：`jlc-openapi-cli init --appId ... --ak ... --sk ...`。
- 永远不要 cat 或提交 `~/.jlc-openapi-config.json`。

## 响应中的大整数

`customerOrderId` 等 Java Long 可能超过 JS 安全整数范围。输出保持原始数字字面量，
解析时按字符串处理，不要转成 Number。

## 契约缓存与降级

- 缓存位置：`~/.jlc-openapi-cli/contracts-cache.json`，TTL 6 小时。
- `list` / `detail` 的输出会标注 `server` / `cache` / `stale-cache` / `bundled`。
- 看到 `stale-cache`：服务端暂时不可用，正在用过期缓存；只读操作可重试，写操作先确认状态。
- 看到 `bundled`：服务端和缓存都不可用，正在使用内置 111 条；新接口可能缺失。
- 强制刷新：`list --refresh` 或 `detail <路径> --refresh`。
- 完全离线：`list --offline` / `--builtin`；`invoke` 也可加 `--offline`（有缓存/内置时可用）。
- 缓存目录可自定义：`JLC_OPENAPI_CACHE_DIR=/path`。
- 缓存只保存契约，不保存 sk。

## 找不到接口

```bash
jlc-openapi-cli list --search <关键词>
jlc-openapi-cli detail <路径>       # 会给出相近路径
jlc-openapi-cli list --refresh      # 服务端新增接口时刷新目录
jlc-openapi-cli list --builtin      # 查看内置 111 条快照
```

接口路径以服务端 `/list` 返回为准；内置快照仅作离线兜底。
