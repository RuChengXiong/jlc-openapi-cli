import { getBooleanFlag, getFlagValues, getStringFlag, type Flags } from "../args";
import {
  getCatalog,
  getDetail,
  type CatalogResult,
  type ContractOptions,
  type ContractSource,
} from "../contract-client";
import {
  allEndpoints,
  findSimilarPaths,
  matchEndpointPath,
  type EndpointDef,
} from "../endpoints";
import type { FetchLike } from "../http";
import { formatJson, usageError, writeErr, writeOut, type WritableLike } from "../output";
import { normalizeApiPath } from "../paths";
import { getVersion } from "../version";

export interface ListDeps {
  stdout?: WritableLike;
  stderr?: WritableLike;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  cachePath?: string;
  now?: () => number;
  configPath?: string;
  allowHttp?: boolean;
}

export interface ContractInfo {
  source: ContractSource;
  fetchedAt?: number;
  stale: boolean;
}

const CATEGORY_ORDER = [
  "PCB业务",
  "SMT业务",
  "3DP业务",
  "元器件&MRO",
  "嘉立创云ERP",
  "CNC业务",
];

const SOURCE_LABELS: Record<ContractSource, string> = {
  server: "服务端",
  cache: "本地缓存",
  "stale-cache": "过期缓存",
  bundled: "内置",
};

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index < 0 ? CATEGORY_ORDER.length : index;
}

function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

function endpointTags(endpoint: EndpointDef): string {
  const tags: string[] = [];
  if (endpoint.contentType === "multipart") tags.push("multipart");
  if (endpoint.strict) tags.push("strict");
  if (endpoint.legacy) tags.push("legacy");
  return tags.length > 0 ? `  [${tags.join(", ")}]` : "";
}

function renderSummaryLine(endpoint: EndpointDef): string {
  return `${endpoint.method.padEnd(4)} ${endpoint.path}  ${endpoint.title}${endpointTags(endpoint)}`;
}

function sourceLabel(info?: ContractInfo): string {
  if (!info) return "";
  const label = SOURCE_LABELS[info.source];
  const time = info.fetchedAt
    ? `，${new Date(info.fetchedAt).toISOString().replace("T", " ").slice(0, 19)}Z`
    : "";
  const stale = info.stale ? "，已过期" : "";
  return `${label}${time}${stale}`;
}

function renderJsonValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderFieldLines(fields: EndpointDef["fields"], verbose: boolean): string[] {
  const descriptionLimit = verbose ? 1000 : 120;
  const lines: string[] = [];
  for (const field of fields) {
    const depth = field.path.split(".").length - 1;
    const indent = "  ".repeat(depth + 2);
    const type = field.items ? `${field.type}<${field.items}>` : field.type;
    const required = field.required ? "必填" : "可选";
    const description = field.description
      ? `  ${truncate(field.description, descriptionLimit)}`
      : "";
    lines.push(`${indent}--${field.path} <${type}> ${required}${description}`);
  }
  return lines;
}

function renderDetail(endpoint: EndpointDef, verbose: boolean, info?: ContractInfo): string {
  const lines: string[] = [];
  lines.push(`${endpoint.method} ${endpoint.path} — ${endpoint.title}`);
  lines.push(`  分类：${endpoint.category}`);
  if (info) lines.push(`  契约来源：${sourceLabel(info)}`);
  if (endpoint.contractSource && !info) {
    lines.push(`  契约来源：${SOURCE_LABELS[endpoint.contractSource]}`);
  }
  if (endpoint.description) lines.push(`  说明：${truncate(endpoint.description, 300)}`);
  if (endpoint.source && endpoint.source !== "server") {
    lines.push(`  来源：${endpoint.source}`);
  }
  if (endpoint.agentGuidance) {
    lines.push(`  Agent 指引：${truncate(endpoint.agentGuidance, 1200)}`);
  }
  if (endpoint.contentType === "multipart") {
    lines.push(`  上传字段：${(endpoint.fileFields ?? []).join(", ") || "未识别"}`);
  }

  lines.push(`  参数（${endpoint.fields.length}）：`);
  const fieldLines = renderFieldLines(endpoint.fields, verbose);
  if (fieldLines.length === 0) {
    lines.push("    （无请求参数）");
  } else {
    lines.push(...fieldLines);
  }

  if (endpoint.inputExample !== undefined) {
    lines.push("  入参示例：");
    lines.push(
      ...renderJsonValue(endpoint.inputExample)
        .split("\n")
        .map((line) => `    ${line}`),
    );
  }

  if (endpoint.outputFields && endpoint.outputFields.length > 0) {
    lines.push(`  响应参数（${endpoint.outputFields.length}）：`);
    lines.push(...renderFieldLines(endpoint.outputFields, verbose));
  }

  if (endpoint.outputExample !== undefined) {
    lines.push("  响应示例：");
    lines.push(
      ...renderJsonValue(endpoint.outputExample)
        .split("\n")
        .map((line) => `    ${line}`),
    );
  }

  if (endpoint.errorCodes && endpoint.errorCodes.length > 0) {
    lines.push("  错误码：");
    for (const code of endpoint.errorCodes) {
      const description = code.description ? `  ${truncate(code.description, 300)}` : "";
      lines.push(`    ${code.name}${description}`);
    }
  }

  if (endpoint.example) {
    lines.push("  示例：");
    lines.push(`    ${endpoint.example}`);
  }
  return lines.join("\n");
}

function endpointJson(
  endpoint: EndpointDef,
  includeFields: boolean,
  info?: ContractInfo,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    path: endpoint.path,
    method: endpoint.method,
    category: endpoint.category,
    title: endpoint.title,
    description: endpoint.description,
    contentType: endpoint.contentType,
    fieldCount: endpoint.fields.length,
    strict: endpoint.strict,
    ...(endpoint.legacy ? { legacy: true } : {}),
    ...(endpoint.fileFields ? { fileFields: endpoint.fileFields } : {}),
    ...(endpoint.source ? { source: endpoint.source } : {}),
    ...(endpoint.example ? { example: endpoint.example } : {}),
    ...(endpoint.agentGuidance ? { agentGuidance: endpoint.agentGuidance } : {}),
    ...(endpoint.inputExample !== undefined ? { inputExample: endpoint.inputExample } : {}),
    ...(endpoint.outputExample !== undefined ? { outputExample: endpoint.outputExample } : {}),
    ...(endpoint.errorCodes ? { errorCodes: endpoint.errorCodes } : {}),
    ...(endpoint.contractSource ? { contractSource: endpoint.contractSource } : {}),
    ...(info
      ? {
          contract: {
            source: info.source,
            fetchedAt: info.fetchedAt,
            stale: info.stale,
          },
        }
      : {}),
  };
  if (includeFields) {
    base.fields = endpoint.fields;
    if (endpoint.outputFields) base.output = endpoint.outputFields;
  }
  return base;
}

const RECOVERABLE_BOOLEAN_FLAGS = [
  "json",
  "refresh",
  "offline",
  "builtin",
  "summary",
  "detail",
  "compact",
] as const;

/**
 * `parseArgs` 会把 `--refresh /path` 中的 `/path` 当成 flag 值。
 * 对 list/detail 做一次修正；invoke 的 `--json` 仍是值参数，不能全局改。
 */
export function recoverListArgs(
  flags: Flags,
  target?: string,
): { flags: Flags; target?: string } {
  let resolvedTarget = target;
  const looksLikePath = (value: string): boolean => {
    const trimmed = value.trim();
    return (
      trimmed.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(trimmed) ||
      trimmed.includes("/Git/") ||
      trimmed.includes("\\Git\\")
    );
  };

  for (const name of RECOVERABLE_BOOLEAN_FLAGS) {
    const values = getFlagValues(flags, name);
    const pathValue = values.find(
      (value) => typeof value === "string" && looksLikePath(value),
    );
    if (pathValue === undefined) continue;

    if (resolvedTarget === undefined) resolvedTarget = String(pathValue).trim();
    const remaining = values.filter((value) => value !== pathValue);
    if (remaining.length === 0) {
      flags[name] = true;
    } else if (remaining.length === 1) {
      flags[name] = remaining[0] as string | boolean;
    } else {
      flags[name] = remaining;
    }
  }
  return { flags, target: resolvedTarget };
}

function contractOptions(flags: Flags, deps: ListDeps): ContractOptions {
  const stderr = deps.stderr ?? process.stderr;
  const options: ContractOptions = {
    refresh: getBooleanFlag(flags, "refresh"),
    offline: getBooleanFlag(flags, "offline"),
    builtin: getBooleanFlag(flags, "builtin"),
    allowHttp: deps.allowHttp ?? getBooleanFlag(flags, "allowHttp"),
    warn: (message) => writeErr(stderr, `警告：${message}`),
  };
  const configPath = getStringFlag(flags, "config") ?? deps.configPath;
  if (configPath) options.configPath = configPath;
  const endpoint = getStringFlag(flags, "endpoint");
  if (endpoint) options.endpoint = endpoint;
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  if (deps.env) options.env = deps.env;
  if (deps.homeDir) options.homeDir = deps.homeDir;
  if (deps.cwd) options.cwd = deps.cwd;
  if (deps.cachePath) options.cachePath = deps.cachePath;
  if (deps.now) options.now = deps.now;
  if (getBooleanFlag(flags, "debug")) {
    options.debug = (message) => writeErr(stderr, message);
  }
  return options;
}

function normalizeTarget(raw: string): string {
  const matched = matchEndpointPath(raw);
  if (matched) return matched.path;
  return normalizeApiPath(raw, {
    knownPaths: allEndpoints().map((endpoint) => endpoint.path),
  }).path;
}

function findSimilarFromCatalog(target: string, catalog: CatalogResult): string[] {
  const similar = new Set(findSimilarPaths(target));
  const needle = target.toLowerCase();
  for (const endpoint of catalog.endpoints) {
    if (endpoint.path.toLowerCase().includes(needle)) similar.add(endpoint.path);
  }
  return Array.from(similar).slice(0, 5);
}

async function listOne(
  target: string,
  flags: Flags,
  deps: ListDeps,
  options: ContractOptions,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const compact = getBooleanFlag(flags, "compact");
  const json = getBooleanFlag(flags, "json");
  const verbose = getBooleanFlag(flags, "detail");
  const normalized = normalizeTarget(target);

  try {
    const result = await getDetail(normalized, options);
    if (result.warning) writeErr(stderr, `警告：${result.warning}`);
    const info: ContractInfo = {
      source: result.source,
      ...(result.fetchedAt !== undefined ? { fetchedAt: result.fetchedAt } : {}),
      stale: result.stale,
    };
    if (json) {
      writeOut(stdout, formatJson(endpointJson(result.endpoint, true, info), compact));
    } else {
      writeOut(stdout, renderDetail(result.endpoint, verbose, info));
    }
    return 0;
  } catch (error) {
    // /list 成功但 /detail 失败时，至少输出目录中的摘要。
    let catalog: CatalogResult | undefined;
    try {
      catalog = await getCatalog(options);
    } catch {
      catalog = undefined;
    }
    const summary = catalog?.endpoints.find((endpoint) => endpoint.path === normalized);
    if (summary) {
      const reason = error instanceof Error ? error.message : String(error);
      writeErr(stderr, `警告：接口详情获取失败（${reason}），以下信息来自接口目录。`);
      const info: ContractInfo = {
        source: catalog?.source ?? "bundled",
        ...(catalog?.fetchedAt !== undefined ? { fetchedAt: catalog.fetchedAt } : {}),
        stale: catalog?.stale ?? false,
      };
      if (json) {
        writeOut(stdout, formatJson(endpointJson(summary, true, info), compact));
      } else {
        writeOut(stdout, renderDetail(summary, verbose, info));
      }
      return 0;
    }

    if (error instanceof Error && error.name === "CliError") {
      throw error;
    }
    const similar = catalog ? findSimilarFromCatalog(normalized, catalog) : findSimilarPaths(normalized);
    usageError(
      `未找到接口：${normalized}` +
        (similar.length > 0 ? `。相近接口：${similar.join(", ")}` : "") +
        "。可运行 `jlc-openapi-cli list --search <关键词>` 查找。",
    );
  }
}

export async function runList(
  flags: Flags,
  target?: string,
  deps: ListDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const recovered = recoverListArgs(flags, target);
  flags = recovered.flags;
  target = recovered.target;

  const compact = getBooleanFlag(flags, "compact");
  const json = getBooleanFlag(flags, "json");
  const summaryOnly = getBooleanFlag(flags, "summary");
  const verbose = getBooleanFlag(flags, "detail");
  const options = contractOptions(flags, deps);

  if (target) {
    return listOne(target, flags, deps, options);
  }

  const catalog = await getCatalog(options);
  if (catalog.warning) writeErr(stderr, `警告：${catalog.warning}`);

  let endpoints = catalog.endpoints;
  const total = endpoints.length;

  const category = getStringFlag(flags, "category");
  if (category) {
    const needle = category.toLowerCase();
    endpoints = endpoints.filter(
      (endpoint) =>
        endpoint.category.toLowerCase().includes(needle) ||
        endpoint.path.toLowerCase().startsWith(`/${needle}`),
    );
  }

  const search = getStringFlag(flags, "search");
  if (search) {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    endpoints = endpoints.filter((endpoint) => {
      const haystack =
        `${endpoint.path} ${endpoint.title} ${endpoint.description} ${endpoint.category}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  const limitRaw = getStringFlag(flags, "limit");
  if (limitRaw !== undefined) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      usageError(`参数 --limit 需要正整数，实际为 "${limitRaw}"`);
    }
    endpoints = endpoints.slice(0, limit);
  }

  endpoints = endpoints.slice().sort((a, b) => {
    const rank = categoryRank(a.category) - categoryRank(b.category);
    if (rank !== 0) return rank;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const info: ContractInfo = {
    source: catalog.source,
    ...(catalog.fetchedAt !== undefined ? { fetchedAt: catalog.fetchedAt } : {}),
    stale: catalog.stale,
  };

  if (json) {
    const payload = {
      version: getVersion(),
      total,
      filtered: endpoints.length,
      meta: {
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        stale: catalog.stale,
      },
      endpoints: endpoints.map((endpoint) =>
        endpointJson(endpoint, verbose && !summaryOnly),
      ),
    };
    writeOut(stdout, formatJson(payload, compact));
    return 0;
  }

  if (endpoints.length === 0) {
    writeOut(stdout, "未找到匹配接口。可去掉 --category/--search 后重试。");
    return 0;
  }

  const groups = new Map<string, EndpointDef[]>();
  for (const endpoint of endpoints) {
    const list = groups.get(endpoint.category) ?? [];
    list.push(endpoint);
    groups.set(endpoint.category, list);
  }

  const blocks: string[] = [
    `jlc-openapi-cli ${getVersion()} — 接口 ${endpoints.length}/${total} 个（契约来源：${sourceLabel(info)}）`,
  ];
  for (const [groupName, list] of groups) {
    blocks.push("", `${groupName} (${list.length})`);
    for (const endpoint of list) blocks.push(`  ${renderSummaryLine(endpoint)}`);
  }
  blocks.push(
    "",
    "查看参数：jlc-openapi-cli detail <接口路径>",
    "搜索接口：jlc-openapi-cli list --search <关键词>",
    "刷新契约：jlc-openapi-cli list --refresh",
    "机器可读：jlc-openapi-cli list --json --summary --compact",
  );
  writeOut(stdout, blocks.join("\n"));
  return 0;
}

export async function runDetail(
  flags: Flags,
  target: string | undefined,
  deps: ListDeps = {},
): Promise<number> {
  const recovered = recoverListArgs(flags, target);
  if (!recovered.target) {
    usageError("detail 需要接口路径，例如：jlc-openapi-cli detail /pcb/order/create");
  }
  return runList(recovered.flags, recovered.target, deps);
}
