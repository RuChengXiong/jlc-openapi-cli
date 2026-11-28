import { GENERATED_ENDPOINTS } from "./endpoints.generated";
import { BUILTIN_ENDPOINTS, OVERRIDES, type EndpointOverride } from "./endpoints.overrides";
import type { EndpointDef, FieldDef } from "./types";

export type { EndpointDef, FieldDef } from "./types";

/** 调用接口时不应被当作业务字段的全局选项。 */
export const GLOBAL_FLAG_NAMES = new Set([
  "config",
  "endpoint",
  "raw",
  "compact",
  "debug",
  "timeout",
  "json",
  "jsonFile",
  "method",
  "force",
  "allowHttp",
  "help",
  "version",
  "strict",
  "noValidate",
  "summary",
  "category",
  "search",
  "detail",
  "limit",
  "file",
  "signBody",
  "refresh",
  "offline",
  "builtin",
  "noSkill",
]);

function isRemovedPath(candidate: string, removed: readonly string[]): boolean {
  return removed.some((path) => candidate === path || candidate.startsWith(`${path}.`));
}

function mergeFields(
  base: FieldDef[],
  override: EndpointOverride,
): FieldDef[] {
  const removed = override.removeFields ?? [];
  if (override.replaceFields) {
    return (override.fields ?? []).filter((item) => !isRemovedPath(item.path, removed));
  }

  const overridePaths = new Set((override.fields ?? []).map((item) => item.path));
  const merged = base.filter(
    (item) => !isRemovedPath(item.path, removed) && !overridePaths.has(item.path),
  );
  merged.push(...(override.fields ?? []).filter((item) => !isRemovedPath(item.path, removed)));
  return merged;
}

function mergeEndpoint(base: EndpointDef, override: EndpointOverride): EndpointDef {
  const { fields, replaceFields, removeFields, ...rest } = override;
  const merged: EndpointDef = {
    ...base,
    ...rest,
    fields: mergeFields(base.fields, override),
  };
  return merged;
}

export function getOverride(apiPath: string): EndpointOverride | undefined {
  return OVERRIDES[apiPath];
}

export function applyOverride(base: EndpointDef, override: EndpointOverride): EndpointDef {
  return mergeEndpoint(base, override);
}

/** 对单个接口应用人工校对规则；没有 override 时原样返回。 */
export function applyOverrides(endpoint: EndpointDef): EndpointDef {
  const override = getOverride(endpoint.path);
  return override ? mergeEndpoint(endpoint, override) : endpoint;
}

function createFromOverride(path: string, override: EndpointOverride): EndpointDef {
  return {
    path,
    method: override.method ?? "POST",
    title: override.title ?? path,
    category: override.category ?? "未分类",
    description: override.description ?? "",
    contentType: override.contentType ?? "json",
    ...(override.fileFields ? { fileFields: override.fileFields } : {}),
    fields: override.fields ?? [],
    strict: override.strict ?? false,
    ...(override.legacy ? { legacy: true } : {}),
    ...(override.example ? { example: override.example } : {}),
  };
}

function buildRegistry(): Record<string, EndpointDef> {
  const registry: Record<string, EndpointDef> = {};

  for (const endpoint of [...BUILTIN_ENDPOINTS, ...GENERATED_ENDPOINTS]) {
    if (registry[endpoint.path]) {
      throw new Error(`接口路径重复：${endpoint.path}`);
    }
    registry[endpoint.path] = endpoint;
  }

  for (const [path, override] of Object.entries(OVERRIDES)) {
    const base = registry[path];
    registry[path] = base ? mergeEndpoint(base, override) : createFromOverride(path, override);
  }

  return registry;
}

export const ENDPOINTS: Record<string, EndpointDef> = buildRegistry();

export function getEndpoint(apiPath: string): EndpointDef | undefined {
  return ENDPOINTS[apiPath];
}

export function allEndpoints(): EndpointDef[] {
  return Object.values(ENDPOINTS);
}

/** 兼容 Git Bash / MSYS 把 `/pcb/...` 改写成本地路径的情况。 */
export function matchEndpointPath(input: string): EndpointDef | undefined {
  const direct = getEndpoint(input);
  if (direct) return direct;

  const normalized = input.startsWith("/") ? input : `/${input}`;
  const normalizedMatch = getEndpoint(normalized);
  if (normalizedMatch) return normalizedMatch;

  for (const endpoint of allEndpoints()) {
    if (input.endsWith(endpoint.path)) return endpoint;
  }
  return undefined;
}

/** 未命中时给出相近路径，便于纠正拼写。 */
export function findSimilarPaths(input: string, limit = 5): string[] {
  const needle = input.toLowerCase();
  return allEndpoints()
    .map((endpoint) => endpoint.path)
    .filter((path) => {
      const lower = path.toLowerCase();
      return (
        lower.includes(needle) ||
        needle.includes(lower) ||
        lower.split("/").some((segment) => segment !== "" && needle.includes(segment))
      );
    })
    .slice(0, limit);
}

export function hasFileFields(endpoint: EndpointDef): boolean {
  return endpoint.contentType === "multipart" && (endpoint.fileFields?.length ?? 0) > 0;
}
