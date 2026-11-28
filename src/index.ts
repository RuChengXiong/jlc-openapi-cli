#!/usr/bin/env node
import { getBooleanFlag, parseArgs } from "./args";
import { runInit } from "./commands/init";
import { runCall, runInvoke } from "./commands/invoke";
import { runDetail, runList } from "./commands/list";
import { allEndpoints, matchEndpointPath } from "./endpoints";
import {
  CliError,
  EXIT_INTERNAL,
  EXIT_USAGE,
  printCliError,
  usageError,
  writeErr,
  writeOut,
  type WritableLike,
} from "./output";
import { normalizeApiPath } from "./paths";
import { getVersion } from "./version";

const HELP = `jlc-openapi-cli ${getVersion()} — 嘉立创开放平台命令行工具

用法:
  jlc-openapi-cli init [--appId <id> --ak <ak> --sk <sk> --endpoint <url>] [--force] [--no-skill]
  jlc-openapi-cli list [--search <关键词>] [--category <业务线>] [--json] [--refresh|--offline|--builtin]
  jlc-openapi-cli detail <接口路径> [--json] [--refresh|--offline|--builtin]
  jlc-openapi-cli <接口路径> [--字段 值 ...]
  jlc-openapi-cli call <接口路径> --json '<body>' [--method POST|GET]
  jlc-openapi-cli help | --version

命令:
  init    配置 appId / ak / sk / endpoint，并复制 skill 到 ~/jlc-openapi-cli
  list    列出接口目录（默认优先服务端 /list，6 小时缓存）
  detail  查看单个接口契约（服务端 /detail，包含参数、示例、错误码、agentGuidance）
  call    通用兜底调用，用于未注册或没有契约的接口

全局选项:
  --config <path>     指定配置文件（默认依次查找 ./jlc-openapi-config.json、~/.jlc-openapi-config.json）
  --endpoint <url>    临时覆盖 endpoint（契约与业务请求共用）
  --json <body>       直接指定请求体（与逐字段参数互斥）
  --json-file <path>  从文件读取请求体
  --raw               原样输出服务端响应
  --compact           单行 JSON 输出
  --timeout <ms>      业务请求超时，默认 30000
  --refresh           强制刷新服务端契约（不能与 --offline/--builtin 同用）
  --offline           不联网，只用本地缓存/内置契约
  --builtin           强制使用内置契约
  --debug             打印 URL、待签名串与 Authorization（不打印 sk/ak）
  -h, --help          显示帮助
  -V, --version       显示版本

环境变量（按字段覆盖配置文件）:
  JLC_OPENAPI_APP_ID  JLC_OPENAPI_ACCESS_KEY  JLC_OPENAPI_SECRET_KEY  JLC_OPENAPI_ENDPOINT
  JLC_OPENAPI_CACHE_DIR  自定义契约缓存目录（默认 ~/.jlc-openapi-cli）

示例:
  jlc-openapi-cli list --search 订单
  jlc-openapi-cli detail /pcb/order/create
  jlc-openapi-cli /pcb/order/getOrderPageList --orderType examples --produceCode Y50504 \\
    --orderByFlag true --orderDateBegin "2026-11-11 00:00:00" --orderDateEnd "2026-11-16 18:00:00" \\
    --pageSize 10 --pageNum 1 --queryFilterFlag true

退出码:
  0 成功    1 业务失败    2 用法/配置错误    3 网络/HTTP 错误    4 内部错误
`;

function printHelp(stream: WritableLike): void {
  writeOut(stream, HELP);
}

function normalizePathArg(raw: string): string {
  const matched = matchEndpointPath(raw);
  if (matched) return matched.path;
  return normalizeApiPath(raw, {
    knownPaths: allEndpoints().map((endpoint) => endpoint.path),
  }).path;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];

  if (getBooleanFlag(flags, "version")) {
    writeOut(process.stdout, getVersion());
    return 0;
  }
  if (getBooleanFlag(flags, "help")) {
    printHelp(process.stdout);
    return 0;
  }

  if (command === undefined) {
    printHelp(process.stderr);
    return EXIT_USAGE;
  }

  if (command === "help") {
    printHelp(process.stdout);
    return 0;
  }

  if (command === "init") {
    return runInit(flags);
  }

  if (command === "list") {
    return runList(flags, positionals[1]);
  }

  if (command === "detail") {
    return runDetail(flags, positionals[1]);
  }

  if (command === "call") {
    const target = positionals[1];
    if (!target) {
      usageError(
        "call 需要接口路径，例如：jlc-openapi-cli call /pcb/order/getOrderPageList --json '{\"orderType\":\"examples\"}'",
      );
    }
    return runCall(normalizePathArg(target), flags);
  }

  const endpoint = matchEndpointPath(command);
  if (endpoint) {
    return runInvoke(endpoint.path, flags);
  }

  const normalized = normalizeApiPath(command, {
    knownPaths: allEndpoints().map((item) => item.path),
  });
  if (command.startsWith("/") || normalized.rewritten || command.includes("/")) {
    return runInvoke(normalized.path, flags);
  }

  usageError(`未知命令：${command}。运行 \`jlc-openapi-cli help\` 查看用法。`);
}

process.stdout.on("error", (error: Error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      printCliError(process.stderr, error);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack && process.env.JLC_OPENAPI_DEBUG === "1") {
      writeErr(process.stderr, error.stack);
    }
    printCliError(process.stderr, new CliError("internal", message, EXIT_INTERNAL));
    process.exitCode = EXIT_INTERNAL;
  });
