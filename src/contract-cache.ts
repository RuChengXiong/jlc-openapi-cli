import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONTRACT_CACHE_VERSION = 1;
export const CONTRACT_TTL_MS = 6 * 60 * 60 * 1000;
export const CONTRACT_CACHE_FILE = "contracts-cache.json";
export const CONTRACT_CACHE_DIR = ".jlc-openapi-cli";
const MAX_DETAIL_ENTRIES = 500;
const MAX_CACHE_BYTES = 5 * 1024 * 1024;

export interface ContractCacheEntry<T> {
  fetchedAt: number;
  data: T;
}

export interface ContractCacheFile {
  version: number;
  entries: Record<string, ContractCacheEntry<unknown>>;
}

export interface CacheOptions {
  homeDir?: string;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function emptyContractCache(): ContractCacheFile {
  return { version: CONTRACT_CACHE_VERSION, entries: {} };
}

export function contractCacheDir(options: CacheOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.JLC_OPENAPI_CACHE_DIR && env.JLC_OPENAPI_CACHE_DIR.trim() !== "") {
    return path.resolve(env.JLC_OPENAPI_CACHE_DIR.trim());
  }
  return path.join(options.homeDir ?? os.homedir(), CONTRACT_CACHE_DIR);
}

export function contractCachePath(options: CacheOptions = {}): string {
  if (options.cachePath) return path.resolve(options.cachePath);
  return path.join(contractCacheDir(options), CONTRACT_CACHE_FILE);
}

export function normalizeEndpointKey(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

function hashKey(parts: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(["v1", ...parts]))
    .digest("hex")
    .slice(0, 32);
}

export function catalogCacheKey(endpoint: string, appId: string, ak: string): string {
  return `catalog:${hashKey([normalizeEndpointKey(endpoint), appId, ak])}`;
}

export function detailCacheKey(endpoint: string, apiUri: string): string {
  return `detail:${hashKey([normalizeEndpointKey(endpoint), apiUri])}`;
}

function asEntry(value: unknown): ContractCacheEntry<unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(record, "data")) return undefined;
  return { fetchedAt: record.fetchedAt, data: record.data };
}

export function readContractCache(options: CacheOptions = {}): ContractCacheFile {
  let raw: string;
  try {
    raw = fs.readFileSync(contractCachePath(options), "utf8");
  } catch {
    return emptyContractCache();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyContractCache();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyContractCache();
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== CONTRACT_CACHE_VERSION) return emptyContractCache();
  if (record.entries === null || typeof record.entries !== "object" || Array.isArray(record.entries)) {
    return emptyContractCache();
  }

  const entries: Record<string, ContractCacheEntry<unknown>> = {};
  for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = asEntry(value);
    if (entry) entries[key] = entry;
  }
  return { version: CONTRACT_CACHE_VERSION, entries };
}

function isWindowsPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EEXIST";
}

export function writeContractCache(cache: ContractCacheFile, options: CacheOptions = {}): void {
  const target = contractCachePath(options);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const content = `${JSON.stringify(cache)}\n`;
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Windows 上可能不支持，忽略。
    }
    try {
      fs.renameSync(tempPath, target);
    } catch (error) {
      if (!isWindowsPermissionError(error)) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(tempPath, target);
    }
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // ignore
  }
}

export type CacheEntryState = "fresh" | "stale" | "miss";

export function getCacheEntry<T>(
  cache: ContractCacheFile,
  key: string,
  now: number,
  ttlMs: number = CONTRACT_TTL_MS,
): { state: CacheEntryState; entry?: ContractCacheEntry<T> } {
  const entry = cache.entries[key] as ContractCacheEntry<T> | undefined;
  if (!entry) return { state: "miss" };
  const age = now - entry.fetchedAt;
  if (age < ttlMs) return { state: "fresh", entry };
  return { state: "stale", entry };
}

export function setCacheEntry<T>(
  cache: ContractCacheFile,
  key: string,
  data: T,
  now: number,
): void {
  cache.entries[key] = { fetchedAt: now, data };
}

function serializedSize(cache: ContractCacheFile): number {
  try {
    return Buffer.byteLength(JSON.stringify(cache), "utf8");
  } catch {
    return 0;
  }
}

/**
 * 修剪缓存：detail 最多 500 条；若目录刷新提供了 allowedDetailKeys，
 * 删除不再出现的 detail；最后按大小上限淘汰最旧的 detail。
 */
export function pruneContractCache(
  cache: ContractCacheFile,
  options: { allowedDetailKeys?: ReadonlySet<string> } = {},
): void {
  const allowed = options.allowedDetailKeys;
  const detailKeys: Array<[string, ContractCacheEntry<unknown>]> = [];

  for (const [key, entry] of Object.entries(cache.entries)) {
    if (!key.startsWith("detail:")) continue;
    if (allowed && !allowed.has(key)) {
      delete cache.entries[key];
      continue;
    }
    detailKeys.push([key, entry]);
  }

  detailKeys.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
  for (const [key] of detailKeys.slice(MAX_DETAIL_ENTRIES)) {
    delete cache.entries[key];
  }

  if (serializedSize(cache) <= MAX_CACHE_BYTES) return;

  const remaining = detailKeys
    .filter(([key]) => cache.entries[key] !== undefined)
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  for (const [key] of remaining) {
    delete cache.entries[key];
    if (serializedSize(cache) <= MAX_CACHE_BYTES) break;
  }
}
