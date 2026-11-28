import type { EndpointDef, ErrorCodeDef, FieldDef, FieldType } from "./types";

export class ContractFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractFormatError";
  }
}

function isCanonicalApiPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("//") || path.includes("?") || path.includes("#")) return false;
  if (/\s/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

export interface RemoteApiRef {
  apiUri: string;
  apiName?: string;
  apiDescn?: string;
  method?: string;
  contentType?: string;
}

export interface RemoteCatalogGroup {
  businessTypeCode?: string;
  businessTypeName?: string;
  apis?: RemoteApiRef[];
}

export interface RemoteErrorCode {
  name?: string;
  type?: string;
  required?: boolean | string;
  desc?: string;
  code?: string;
  message?: string;
  solution?: string;
}

export interface RemoteField {
  name: string;
  type?: string;
  required?: boolean | string;
  desc?: string;
  children?: RemoteField[];
  items?: RemoteField | string;
  enum?: string[] | string;
  format?: string;
  example?: unknown;
  min?: number;
  max?: number;
}

export interface RemoteDetail {
  apiUri: string;
  apiName?: string;
  apiDescn?: string;
  businessTypeCode?: string;
  businessTypeName?: string;
  method?: string;
  contentType?: string;
  fileFields?: string[];
  input?: RemoteField[];
  output?: RemoteField[];
  inputExample?: unknown;
  outputExample?: unknown;
  errorCode?: RemoteErrorCode[];
  agentGuidance?: string;
}

export interface ContractEndpoint extends EndpointDef {
  /** 原始响应字段树，仅用于展示。 */
  output?: RemoteField[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "y", "yes", "1", "是", "必填", "required"].includes(normalized)) return true;
    if (["false", "n", "no", "0", "否", "非必填", "optional"].includes(normalized)) return false;
  }
  return fallback;
}

function asEnum(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const items = value
      .split(/[,，、|]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function stripPackages(raw: string): string {
  return raw
    .replace(/\b(?:java|javax|org|com|cn|net)\.[\w$.]+\./g, "")
    .replace(/\s+/g, "")
    .trim();
}

export interface MappedType {
  type: FieldType;
  items?: FieldType;
  format?: "datetime" | "date";
}

const CLI_TYPES = new Set<string>([
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
  "file",
  "unknown",
]);

export function mapServerType(rawInput: string | undefined): MappedType {
  const raw = stripPackages(rawInput ?? "");
  if (raw === "") return { type: "unknown" };

  const lower = raw.toLowerCase();
  if (CLI_TYPES.has(lower)) return { type: lower as FieldType };

  if (lower.endsWith("[]")) {
    const innerRaw = raw.slice(0, -2);
    const inner = mapServerType(innerRaw);
    const itemType =
      inner.type === "unknown" && /^[A-Z]/.test(stripPackages(innerRaw))
        ? "object"
        : inner.type;
    return { type: "array", items: itemType === "array" ? "unknown" : itemType };
  }

  const generic = raw.match(/^(?:list|array|set|collection|iterable)<(.+)>$/i);
  if (generic) {
    const innerRaw = generic[1] as string;
    const inner = mapServerType(innerRaw);
    const itemType =
      inner.type === "unknown" && /^[A-Z]/.test(stripPackages(innerRaw))
        ? "object"
        : inner.type;
    return { type: "array", items: itemType === "array" ? "unknown" : itemType };
  }

  if (/^(?:map|hashmap|linkedhashmap|treemap)</i.test(raw) || lower === "map") {
    return { type: "object" };
  }
  if (["object", "pojo", "jsonobject", "json", "entity"].includes(lower)) {
    return { type: "object" };
  }
  if (["file", "multipartfile", "part", "blob", "resource"].includes(lower)) {
    return { type: "file" };
  }
  if (["string", "char", "character", "text", "varchar"].includes(lower)) {
    return { type: "string" };
  }
  if (["integer", "int", "long", "short", "byte", "biginteger", "bigint"].includes(lower)) {
    return { type: "integer" };
  }
  if (["number", "decimal", "bigdecimal", "double", "float"].includes(lower)) {
    return { type: "number" };
  }
  if (["boolean", "bool"].includes(lower)) {
    return { type: "boolean" };
  }
  if (["localdate"].includes(lower)) {
    return { type: "string", format: "date" };
  }
  if (["date", "localdatetime", "instant", "timestamp", "datetime", "offsetdatetime"].includes(lower)) {
    return { type: "string", format: "datetime" };
  }

  return { type: "unknown" };
}

function mapFormat(raw: string | undefined, fallback?: "datetime" | "date"): "datetime" | "date" | undefined {
  if (!raw) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "date" || lower === "yyyy-mm-dd") return "date";
  if (
    lower === "datetime" ||
    lower === "date-time" ||
    lower.includes("hh:mm") ||
    lower.includes("hh:mm:ss") ||
    lower.includes("localdatetime")
  ) {
    return "datetime";
  }
  if (lower.includes("yyyy-mm-dd")) return "date";
  return fallback;
}

function fieldExample(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface FlattenOptions {
  maxDepth?: number;
  maxFields?: number;
}

interface FlattenState {
  out: Map<string, FieldDef>;
  maxFields: number;
}

function walkFields(
  fields: readonly RemoteField[],
  parent: string | undefined,
  depth: number,
  state: FlattenState,
  maxDepth: number,
): void {
  if (depth > maxDepth) {
    throw new ContractFormatError(`字段嵌套超过 ${maxDepth} 层`);
  }
  for (const rawField of fields) {
    if (rawField === null || typeof rawField !== "object") continue;
    const name = asString(rawField.name);
    if (!name) continue;

    const fullPath = name.includes(".") ? name : parent ? `${parent}.${name}` : name;
    const mapped = mapServerType(rawField.type);
    const format = mapFormat(rawField.format, mapped.format);
    const childFields =
      Array.isArray(rawField.children) && rawField.children.length > 0
        ? rawField.children
        : undefined;

    let type = mapped.type;
    let items = mapped.items;
    let children = childFields;

    if (type === "array") {
      if (typeof rawField.items === "string") {
        const itemType = mapServerType(rawField.items);
        items = itemType.type === "array" ? "unknown" : itemType.type;
        if (itemType.format) {
          // 元素类型是日期时，父字段保留 array；元素格式无法单独表达，忽略。
        }
      } else if (rawField.items && typeof rawField.items === "object") {
        const itemType = mapServerType(rawField.items.type);
        items = itemType.type === "array" ? "unknown" : itemType.type;
        if (Array.isArray(rawField.items.children) && rawField.items.children.length > 0) {
          children = rawField.items.children;
          items = "object";
        }
      } else if (childFields) {
        items = "object";
      } else {
        items = "unknown";
      }
    } else if (children) {
      // children 只对对象有意义；服务端若给标量挂了 children，按对象处理。
      type = "object";
    }

    const def: FieldDef = {
      path: fullPath,
      type,
      required: asBoolean(rawField.required),
      description: asString(rawField.desc) ?? "",
      confidence: type === "unknown" || items === "unknown" ? "low" : "high",
    };
    if (items) def.items = items;
    const enumValues = asEnum(rawField.enum);
    if (enumValues) def.enum = enumValues;
    if (format) def.format = format;
    if (typeof rawField.min === "number" && Number.isFinite(rawField.min)) def.min = rawField.min;
    if (typeof rawField.max === "number" && Number.isFinite(rawField.max)) def.max = rawField.max;
    const example = fieldExample(rawField.example);
    if (example !== undefined) def.example = example;

    state.out.set(fullPath, def);
    if (children && children.length > 0) {
      walkFields(children, fullPath, depth + 1, state, maxDepth);
    }
    if (state.out.size > state.maxFields) {
      throw new ContractFormatError(`字段数量超过 ${state.maxFields}`);
    }
  }
}

/** 把服务端递归字段拍平成点号路径。 */
export function flattenInput(fields: readonly RemoteField[] = [], opts: FlattenOptions = {}): FieldDef[] {
  const maxDepth = opts.maxDepth ?? 20;
  const maxFields = opts.maxFields ?? 5000;
  const state: FlattenState = { out: new Map(), maxFields };
  walkFields(fields, undefined, 0, state, maxDepth);
  return Array.from(state.out.values());
}

export function normalizeMethod(raw: string | undefined, fallback: "POST" | "GET" = "POST"): "POST" | "GET" {
  if (!raw) return fallback;
  const value = raw.trim().toUpperCase();
  if (value === "POST" || value === "GET") return value;
  throw new ContractFormatError(`不支持的请求方法：${raw}`);
}

export function normalizeContentType(
  raw: string | undefined,
  fallback: "json" | "multipart" = "json",
): "json" | "multipart" {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "json" || value === "application/json") return "json";
  if (
    value === "multipart" ||
    value === "form-data" ||
    value === "multipart/form-data"
  ) {
    return "multipart";
  }
  throw new ContractFormatError(`不支持的 contentType：${raw}`);
}

function validateFieldArray(value: unknown, name: string): RemoteField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ContractFormatError(`${name} 必须是数组`);
  }
  return value.filter((item): item is RemoteField => {
    const record = asRecord(item);
    return record !== undefined && asString(record.name) !== undefined;
  });
}

function validateApiRef(value: unknown): RemoteApiRef | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const apiUri = asString(record.apiUri);
  if (!apiUri || !isCanonicalApiPath(apiUri)) return undefined;
  return {
    apiUri,
    ...(asString(record.apiName) ? { apiName: asString(record.apiName) as string } : {}),
    ...(asString(record.apiDescn) ? { apiDescn: asString(record.apiDescn) as string } : {}),
    ...(asString(record.method) ? { method: asString(record.method) as string } : {}),
    ...(asString(record.contentType) ? { contentType: asString(record.contentType) as string } : {}),
  };
}

export function validateCatalog(data: unknown): RemoteCatalogGroup[] {
  if (!Array.isArray(data)) {
    throw new ContractFormatError("/list 响应必须是数组");
  }
  const groups: RemoteCatalogGroup[] = [];
  for (const item of data) {
    const record = asRecord(item);
    if (!record) continue;
    const apisRaw = record.apis;
    if (!Array.isArray(apisRaw)) continue;
    const apis = apisRaw
      .map(validateApiRef)
      .filter((api): api is RemoteApiRef => api !== undefined);
    if (apis.length === 0) continue;
    groups.push({
      ...(asString(record.businessTypeCode)
        ? { businessTypeCode: asString(record.businessTypeCode) as string }
        : {}),
      ...(asString(record.businessTypeName)
        ? { businessTypeName: asString(record.businessTypeName) as string }
        : {}),
      apis,
    });
  }
  if (groups.length === 0 && data.length > 0) {
    throw new ContractFormatError("/list 响应中没有合法接口");
  }
  return groups;
}

export function validateDetail(data: unknown, requestedApiUri: string): RemoteDetail {
  const record = asRecord(data);
  if (!record) {
    throw new ContractFormatError("/detail 响应必须是对象");
  }
  if (!isCanonicalApiPath(requestedApiUri)) {
    throw new ContractFormatError(`请求路径不是规范的接口路径：${requestedApiUri}`);
  }
  const apiUri = asString(record.apiUri);
  if (apiUri && (!isCanonicalApiPath(apiUri) || apiUri !== requestedApiUri)) {
    throw new ContractFormatError(
      `/detail 返回的 apiUri（${apiUri}）与请求路径（${requestedApiUri}）不一致`,
    );
  }

  const method = normalizeMethod(asString(record.method), "POST");
  const contentType = normalizeContentType(asString(record.contentType), "json");
  const input = validateFieldArray(record.input, "input");
  const output = validateFieldArray(record.output, "output");
  const fileFields = Array.isArray(record.fileFields)
    ? record.fileFields.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

  const hasFileInput = input.some((field) => mapServerType(field.type).type === "file");
  if (method === "GET" && (contentType === "multipart" || fileFields.length > 0 || hasFileInput)) {
    throw new ContractFormatError("GET 接口不能声明 multipart 或文件字段");
  }

  const errorCode = Array.isArray(record.errorCode)
    ? record.errorCode.filter((item) => asRecord(item) !== undefined)
    : [];

  return {
    apiUri: requestedApiUri,
    ...(asString(record.apiName) ? { apiName: asString(record.apiName) as string } : {}),
    ...(asString(record.apiDescn) ? { apiDescn: asString(record.apiDescn) as string } : {}),
    ...(asString(record.businessTypeCode)
      ? { businessTypeCode: asString(record.businessTypeCode) as string }
      : {}),
    ...(asString(record.businessTypeName)
      ? { businessTypeName: asString(record.businessTypeName) as string }
      : {}),
    method,
    contentType,
    ...(fileFields.length > 0 ? { fileFields } : {}),
    input,
    output,
    inputExample: record.inputExample,
    outputExample: record.outputExample,
    errorCode: errorCode as RemoteErrorCode[],
    ...(typeof record.agentGuidance === "string"
      ? { agentGuidance: record.agentGuidance }
      : {}),
  };
}

function normalizeErrorCodes(codes: readonly RemoteErrorCode[] | undefined): ErrorCodeDef[] | undefined {
  if (!codes || codes.length === 0) return undefined;
  const result: ErrorCodeDef[] = [];
  for (const code of codes) {
    const name = asString(code.name) ?? asString(code.code);
    if (!name) continue;
    let description = asString(code.desc) ?? asString(code.message) ?? "";
    const solution = asString(code.solution);
    if (solution) {
      description = description ? `${description}（处理建议：${solution}）` : `处理建议：${solution}`;
    }
    result.push({
      name,
      type: asString(code.type) ?? "String",
      required: asBoolean(code.required),
      description,
    });
  }
  return result.length > 0 ? result : undefined;
}

function deriveFileFields(input: readonly RemoteField[], declared: readonly string[] | undefined): string[] {
  const topLevel = new Map<string, RemoteField>();
  for (const field of input) {
    const name = asString(field.name);
    if (name && !name.includes(".")) topLevel.set(name, field);
  }
  const validDeclared = (declared ?? []).filter((name) => topLevel.has(name));
  if (validDeclared.length > 0) return validDeclared;
  return Array.from(topLevel.entries())
    .filter(([, field]) => mapServerType(field.type).type === "file")
    .map(([name]) => name);
}

export function mapCatalog(groups: readonly RemoteCatalogGroup[]): EndpointDef[] {
  const byPath = new Map<string, EndpointDef>();
  for (const group of groups) {
    const category = group.businessTypeName ?? group.businessTypeCode ?? "未分类";
    for (const api of group.apis ?? []) {
      if (!isCanonicalApiPath(api.apiUri) || byPath.has(api.apiUri)) continue;
      byPath.set(api.apiUri, {
        path: api.apiUri,
        method: normalizeMethod(api.method, "POST"),
        title: api.apiName ?? api.apiUri,
        category,
        description: api.apiDescn ?? "",
        contentType: normalizeContentType(api.contentType, "json"),
        fields: [],
        strict: false,
        source: "server",
        contractSource: "server",
      });
    }
  }
  return Array.from(byPath.values());
}

export function mapDetail(
  detail: RemoteDetail,
  ctx: { apiUri: string; bundled?: EndpointDef; category?: string },
): ContractEndpoint {
  const method = normalizeMethod(detail.method, "POST");
  const fileFields = deriveFileFields(detail.input ?? [], detail.fileFields);
  const contentType =
    fileFields.length > 0 ? "multipart" : normalizeContentType(detail.contentType, "json");
  const errorCodes = normalizeErrorCodes(detail.errorCode);

  const endpoint: ContractEndpoint = {
    path: ctx.apiUri,
    method,
    title: detail.apiName ?? ctx.bundled?.title ?? ctx.apiUri,
    category:
      detail.businessTypeName ?? ctx.category ?? ctx.bundled?.category ?? "未分类",
    description: detail.apiDescn ?? ctx.bundled?.description ?? "",
    contentType,
    ...(contentType === "multipart" ? { fileFields } : {}),
    fields: flattenInput(detail.input ?? []),
    strict: false,
    source: "server",
    ...(detail.agentGuidance !== undefined ? { agentGuidance: detail.agentGuidance } : {}),
    inputExample: detail.inputExample,
    outputExample: detail.outputExample,
    outputFields: flattenInput(detail.output ?? []),
    ...(errorCodes ? { errorCodes } : {}),
    output: detail.output ?? [],
    contractSource: "server",
  };
  return endpoint;
}

/**
 * 远程契约与内置基线合并。
 *
 * - 签名相关元数据（method/contentType/fileFields/strict/legacy）以内置为准；
 * - 字段同路径以远程为准，内置中远程缺失的字段保留；
 * - 最后重新应用本地 override，人工校对仍然优先。
 */
export function mergeRemoteEndpoint(
  remote: ContractEndpoint,
  bundled: EndpointDef | undefined,
  applyOverrides: (endpoint: EndpointDef) => EndpointDef,
): EndpointDef {
  if (!bundled) return applyOverrides(remote);

  const byPath = new Map<string, FieldDef>();
  for (const field of bundled.fields) byPath.set(field.path, field);
  for (const field of remote.fields) byPath.set(field.path, field);

  const merged: ContractEndpoint = {
    ...remote,
    method: bundled.method,
    title: bundled.title || remote.title,
    category: bundled.category || remote.category,
    description: bundled.description || remote.description,
    contentType: bundled.contentType,
    fileFields: bundled.fileFields,
    strict: bundled.strict,
    legacy: bundled.legacy,
    source: bundled.source,
    example: bundled.example,
    fields: Array.from(byPath.values()),
    outputFields: remote.outputFields ?? bundled.outputFields,
    output: remote.output,
    agentGuidance: remote.agentGuidance ?? bundled.agentGuidance,
    inputExample: remote.inputExample ?? bundled.inputExample,
    outputExample: remote.outputExample ?? bundled.outputExample,
    errorCodes: remote.errorCodes ?? bundled.errorCodes,
  };
  return applyOverrides(merged);
}
