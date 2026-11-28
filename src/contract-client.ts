import { resolveContractConfig, type ContractRuntimeConfig } from "./config";
import {
  ContractFormatError,
  mapCatalog,
  mapDetail,
  mergeRemoteEndpoint,
  validateCatalog,
  validateDetail,
  type ContractEndpoint,
  type RemoteCatalogGroup,
  type RemoteDetail,
} from "./contracts";
import {
  CONTRACT_TTL_MS,
  catalogCacheKey,
  detailCacheKey,
  getCacheEntry,
  pruneContractCache,
  readContractCache,
  setCacheEntry,
  writeContractCache,
  type ContractCacheFile,
} from "./contract-cache";
import { allEndpoints, applyOverrides, getEndpoint, type EndpointDef } from "./endpoints";
import { requestHttp, type FetchLike } from "./http";
import { CliError, EXIT_NETWORK, configError, usageError } from "./output";
import { getVersion } from "./version";

export const CONTRACT_LIST_PATH = "/list";
export const CONTRACT_DETAIL_PATH = "/detail";
export const CONTRACT_TIMEOUT_MS = 5_000;

export type ContractSource = "server" | "cache" | "stale-cache" | "bundled";

export interface ContractOptions {
  config?: ContractRuntimeConfig | null;
  endpoint?: string;
  configPath?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  refresh?: boolean;
  offline?: boolean;
  builtin?: boolean;
  allowHttp?: boolean;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface CatalogResult {
  endpoints: EndpointDef[];
  source: ContractSource;
  fetchedAt?: number;
  stale: boolean;
  warning?: string;
}

export interface DetailResult {
  endpoint: ContractEndpoint;
  source: ContractSource;
  fetchedAt?: number;
  stale: boolean;
  warning?: string;
}

export class ContractHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`契约接口 HTTP ${status}`);
    this.name = "ContractHttpError";
    this.status = status;
    this.body = body;
  }
}

function validateMode(options: ContractOptions): void {
  if (options.refresh && options.offline) {
    usageError("--refresh 与 --offline 不能同时使用");
  }
  if (options.refresh && options.builtin) {
    usageError("--refresh 与 --builtin 不能同时使用");
  }
}

function resolveConfig(options: ContractOptions): ContractRuntimeConfig {
  if (options.config) return options.config;
  return resolveContractConfig({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    allowHttp: options.allowHttp ?? false,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bundledEndpoint(apiUri: string): ContractEndpoint | undefined {
  const endpoint = getEndpoint(apiUri);
  if (!endpoint) return undefined;
  return { ...endpoint, contractSource: "bundled" };
}

function bundledCatalog(): EndpointDef[] {
  return allEndpoints().map((endpoint) => ({ ...endpoint, contractSource: "bundled" }));
}

function markCatalog(endpoints: EndpointDef[], source: ContractSource): EndpointDef[] {
  return endpoints.map((endpoint) => ({ ...endpoint, contractSource: source }));
}

function markDetail(endpoint: ContractEndpoint, source: ContractSource): ContractEndpoint {
  return { ...endpoint, contractSource: source };
}

function writeCache(cache: ContractCacheFile, options: ContractOptions): void {
  try {
    pruneContractCache(cache);
    writeContractCache(cache, options);
  } catch (error) {
    options.warn?.(`契约缓存写入失败（已忽略）：${errorMessage(error)}`);
  }
}

function catalogDetailKeys(endpoint: string, groups: readonly RemoteCatalogGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const api of group.apis ?? []) {
      keys.add(detailCacheKey(endpoint, api.apiUri));
    }
  }
  return keys;
}

async function postContract<T>(
  path: string,
  body: unknown,
  config: ContractRuntimeConfig,
  options: ContractOptions,
): Promise<T> {
  const url = `${config.endpoint}${path}`;
  options.debug?.(`[debug] 契约请求 POST ${url}`);
  if (path === CONTRACT_LIST_PATH) {
    options.debug?.(
      `[debug] 契约请求体 ${JSON.stringify({
        appId: config.appId,
        ak: config.ak ? "***" : undefined,
      })}`,
    );
  } else {
    options.debug?.(`[debug] 契约请求体 ${JSON.stringify(body)}`);
  }

  const response = await requestHttp({
    method: "POST",
    url,
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `jlc-openapi-cli/${getVersion()}`,
    },
    timeoutMs: options.timeoutMs ?? CONTRACT_TIMEOUT_MS,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ContractHttpError(response.status, response.text.slice(0, 2000));
  }

  try {
    return JSON.parse(response.text) as T;
  } catch (error) {
    throw new ContractFormatError(`契约接口返回的不是合法 JSON：${errorMessage(error)}`);
  }
}

/** 获取接口目录；顺序：内置/缓存/服务端/过期缓存/内置。 */
export async function getCatalog(options: ContractOptions = {}): Promise<CatalogResult> {
  validateMode(options);
  const now = (options.now ?? Date.now)();
  const warn = options.warn ?? (() => undefined);

  if (options.builtin) {
    return { endpoints: bundledCatalog(), source: "bundled", stale: false };
  }

  const config = resolveConfig(options);
  const cache = readContractCache(options);

  if (!config.appId || !config.ak) {
    if (options.refresh) {
      configError("请求 /list 需要 appId/ak，请先运行 `jlc-openapi-cli init`。");
    }
    const warning = "未配置 appId/ak，无法请求服务端接口目录，已使用内置契约。";
    return { endpoints: bundledCatalog(), source: "bundled", stale: false, warning };
  }

  const key = catalogCacheKey(config.endpoint, config.appId, config.ak);
  const cached = getCacheEntry<RemoteCatalogGroup[]>(cache, key, now);

  if (cached.state === "fresh" && !options.refresh) {
    return {
      endpoints: markCatalog(mapCatalog(cached.entry?.data ?? []), "cache"),
      source: "cache",
      fetchedAt: cached.entry?.fetchedAt,
      stale: false,
    };
  }

  if (options.offline) {
    if (cached.entry) {
      return {
        endpoints: markCatalog(mapCatalog(cached.entry.data), cached.state === "fresh" ? "cache" : "stale-cache"),
        source: cached.state === "fresh" ? "cache" : "stale-cache",
        fetchedAt: cached.entry.fetchedAt,
        stale: cached.state === "stale",
        warning: cached.state === "stale" ? "服务端目录缓存已过期，正在使用过期缓存（--offline）。" : undefined,
      };
    }
    return {
      endpoints: bundledCatalog(),
      source: "bundled",
      stale: false,
      warning: "离线模式且没有目录缓存，已使用内置契约。",
    };
  }

  try {
    const raw = await postContract<unknown>(
      CONTRACT_LIST_PATH,
      { appId: config.appId, ak: config.ak },
      config,
      options,
    );
    const groups = validateCatalog(raw);
    const endpoints = mapCatalog(groups);
    setCacheEntry(cache, key, groups, now);
    pruneContractCache(cache, { allowedDetailKeys: catalogDetailKeys(config.endpoint, groups) });
    writeCache(cache, options);
    return {
      endpoints: markCatalog(endpoints, "server"),
      source: "server",
      fetchedAt: now,
      stale: false,
    };
  } catch (error) {
    if (cached.entry) {
      const stale = cached.state === "stale";
      const warning = `服务端接口目录获取失败（${errorMessage(error)}），已使用${stale ? "过期" : ""}缓存。`;
      return {
        endpoints: markCatalog(mapCatalog(cached.entry.data), stale ? "stale-cache" : "cache"),
        source: stale ? "stale-cache" : "cache",
        fetchedAt: cached.entry.fetchedAt,
        stale,
        warning,
      };
    }
    const warning = `服务端接口目录获取失败（${errorMessage(error)}），已使用内置契约。`;
    return { endpoints: bundledCatalog(), source: "bundled", stale: false, warning };
  }
}

function detailFromCache(
  entry: RemoteDetail,
  apiUri: string,
  source: ContractSource,
  fetchedAt: number,
  stale: boolean,
  warning?: string,
): DetailResult {
  const bundled = getEndpoint(apiUri);
  const mapped = mapDetail(entry, { apiUri, ...(bundled ? { bundled } : {}) });
  const merged = mergeRemoteEndpoint(mapped, bundled, applyOverrides) as ContractEndpoint;
  return {
    endpoint: markDetail(merged, source),
    source,
    fetchedAt,
    stale,
    ...(warning ? { warning } : {}),
  };
}

/** 只读新鲜详情缓存；没有新鲜缓存时返回 undefined，不访问网络。 */
export function getCachedDetail(
  apiUri: string,
  options: ContractOptions = {},
): DetailResult | undefined {
  const config = resolveConfig(options);
  const now = (options.now ?? Date.now)();
  const cache = readContractCache(options);
  const key = detailCacheKey(config.endpoint, apiUri);
  const cached = getCacheEntry<RemoteDetail>(cache, key, now);
  if (cached.state !== "fresh" || !cached.entry) return undefined;
  try {
    return detailFromCache(cached.entry.data, apiUri, "cache", cached.entry.fetchedAt, false);
  } catch {
    return undefined;
  }
}

/** 获取单个接口详情；顺序：内置/缓存/服务端/过期缓存/内置。 */
export async function getDetail(apiUri: string, options: ContractOptions = {}): Promise<DetailResult> {
  validateMode(options);
  const now = (options.now ?? Date.now)();
  const warn = options.warn ?? (() => undefined);

  const bundled = bundledEndpoint(apiUri);
  if (options.builtin) {
    if (bundled) return { endpoint: bundled, source: "bundled", stale: false };
    usageError(
      `接口 ${apiUri} 不在内置契约中，--builtin 无法提供；请去掉 --builtin 或先运行 \`list --search\`。`,
    );
  }

  const config = resolveConfig(options);
  const cache = readContractCache(options);
  const key = detailCacheKey(config.endpoint, apiUri);
  const cached = getCacheEntry<RemoteDetail>(cache, key, now);

  if (cached.state === "fresh" && !options.refresh && cached.entry) {
    return detailFromCache(cached.entry.data, apiUri, "cache", cached.entry.fetchedAt, false);
  }

  if (options.offline) {
    if (cached.entry) {
      const stale = cached.state === "stale";
      return detailFromCache(
        cached.entry.data,
        apiUri,
        stale ? "stale-cache" : "cache",
        cached.entry.fetchedAt,
        stale,
        stale ? "服务端详情缓存已过期，正在使用过期缓存（--offline）。" : undefined,
      );
    }
    if (bundled) {
      return {
        endpoint: bundled,
        source: "bundled",
        stale: false,
        warning: "离线模式且没有详情缓存，已使用内置契约。",
      };
    }
    usageError(`离线模式且没有接口 ${apiUri} 的缓存或内置契约。`);
  }

  try {
    const raw = await postContract<unknown>(CONTRACT_DETAIL_PATH, { apiUri }, config, options);
    const detail = validateDetail(raw, apiUri);
    const bundledDef = getEndpoint(apiUri);
    const mapped = mapDetail(detail, { apiUri, ...(bundledDef ? { bundled: bundledDef } : {}) });
    const merged = mergeRemoteEndpoint(mapped, bundledDef, applyOverrides) as ContractEndpoint;
    setCacheEntry(cache, key, detail, now);
    writeCache(cache, options);
    return {
      endpoint: markDetail(merged, "server"),
      source: "server",
      fetchedAt: now,
      stale: false,
    };
  } catch (error) {
    if (error instanceof ContractHttpError && error.status === 404) {
      if (bundled) {
        return {
          endpoint: bundled,
          source: "bundled",
          stale: false,
          warning: `服务端没有接口 ${apiUri} 的详情（404），已使用内置契约。`,
        };
      }
      usageError(`服务端没有接口 ${apiUri} 的详情（404）。`);
    }

    if (cached.entry) {
      const stale = cached.state === "stale";
      return detailFromCache(
        cached.entry.data,
        apiUri,
        stale ? "stale-cache" : "cache",
        cached.entry.fetchedAt,
        stale,
        `服务端详情获取失败（${errorMessage(error)}），已使用${stale ? "过期" : ""}缓存。`,
      );
    }
    if (bundled) {
      return {
        endpoint: bundled,
        source: "bundled",
        stale: false,
        warning: `服务端详情获取失败（${errorMessage(error)}），已使用内置契约。`,
      };
    }
    if (error instanceof CliError) throw error;
    throw new CliError(
      "network",
      `获取接口 ${apiUri} 详情失败：${errorMessage(error)}`,
      EXIT_NETWORK,
    );
  }
}
