import fs from "node:fs";
import path from "node:path";

import { getBooleanFlag, getStringFlag, hasFlag, type Flags } from "../args";
import {
  getCachedDetail,
  getDetail,
  type ContractOptions,
} from "../contract-client";
import { resolveRuntimeConfig, type Config } from "../config";
import {
  GLOBAL_FLAG_NAMES,
  allEndpoints,
  findSimilarPaths,
  getEndpoint,
  matchEndpointPath,
  type EndpointDef,
} from "../endpoints";
import { requestHttp, type FetchLike } from "../http";
import { formatJsonText } from "../json-text";
import { normalizeApiPath } from "../paths";
import {
  CliError,
  EXIT_API,
  EXIT_NETWORK,
  usageError,
  writeErr,
  writeOut,
  type WritableLike,
} from "../output";
import { buildPayload, RawNumber, stringifyPayload, toQueryString } from "../payload";
import { buildAuthorization, buildStringToSign, computeSignature, createNonce } from "../sign";
import { getVersion } from "../version";

export interface InvokeDeps {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  cachePath?: string;
  now?: () => number;
  nonce?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function stringValue(flags: Flags, name: string): string | undefined {
  const value = getStringFlag(flags, name);
  if (value === "") usageError(`参数 --${name} 缺少值`);
  return value;
}

function parseTimeout(flags: Flags): number {
  const raw = stringValue(flags, "timeout");
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    usageError(`参数 --timeout 需要 1-600000 之间的整数（毫秒），实际为 "${raw}"`);
  }
  return value;
}

function readJsonBody(flags: Flags, cwd: string): string | undefined {
  const inline = hasFlag(flags, "json");
  const fromFile = hasFlag(flags, "jsonFile");

  if (inline && fromFile) usageError("--json 与 --json-file 不能同时使用");

  let content: string | undefined;
  if (inline) {
    content = stringValue(flags, "json");
  } else if (fromFile) {
    const rawPath = stringValue(flags, "jsonFile");
    if (!rawPath) usageError("参数 --json-file 缺少路径");
    const filePath = path.resolve(cwd, rawPath);
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      usageError(`读取 JSON 文件失败：${filePath}（${(error as Error).message}）`);
    }
  }

  if (content === undefined) return undefined;

  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  try {
    JSON.parse(normalized);
  } catch (error) {
    usageError(`请求 body 不是合法 JSON：${(error as Error).message}`);
  }
  return normalized;
}

function splitPath(apiPath: string): { path: string; query: string } {
  const index = apiPath.indexOf("?");
  if (index < 0) return { path: apiPath, query: "" };
  return { path: apiPath.slice(0, index), query: apiPath.slice(index + 1) };
}

function hasBusinessFieldFlags(flags: Flags, allowed: readonly string[]): boolean {
  const ignore = new Set([...GLOBAL_FLAG_NAMES, ...allowed]);
  return Object.keys(flags).some((key) => !ignore.has(key));
}

interface PreparedRequest {
  method: string;
  apiPath: string;
  contentType: "json" | "multipart";
  body: string | FormData;
  query: string;
  signBody: string;
}

function appendFormValue(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, key, item);
    return;
  }
  if (value instanceof RawNumber) {
    form.append(key, value.raw);
    return;
  }
  if (typeof value === "object") {
    form.append(key, stringifyPayload(value));
    return;
  }
  form.append(key, String(value));
}

function buildFormData(
  payload: Record<string, unknown>,
  fileValues: Record<string, string>,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    appendFormValue(form, key, value);
  }
  for (const [field, filePath] of Object.entries(fileValues)) {
    const buffer = fs.readFileSync(filePath);
    form.append(field, new Blob([buffer]), path.basename(filePath));
  }
  return form;
}

function prepareRegistered(
  def: EndpointDef,
  flags: Flags,
  cwd: string,
  stderr: WritableLike,
  pathQuery = "",
): PreparedRequest {
  const rawBody = readJsonBody(flags, cwd);
  const strict = getBooleanFlag(flags, "strict") || def.strict;
  const validate = !getBooleanFlag(flags, "noValidate");
  const warn = (message: string): void => writeErr(stderr, `警告：${message}`);

  if (rawBody !== undefined) {
    if (def.contentType === "json") {
      if (hasBusinessFieldFlags(flags, [])) {
        usageError("--json / --json-file 不能与逐字段参数同时使用");
      }
      if (def.method === "GET") {
        const parsed = JSON.parse(rawBody) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          usageError("GET 请求的 --json 必须是 JSON 对象");
        }
        return {
          method: "GET",
          apiPath: def.path,
          contentType: "json",
          body: "",
          query: [pathQuery, toQueryString(parsed).join("&")].filter(Boolean).join("&"),
          signBody: "",
        };
      }
      return {
        method: "POST",
        apiPath: def.path,
        contentType: "json",
        body: rawBody,
        query: pathQuery,
        signBody: rawBody,
      };
    }

    // multipart + --json：JSON 只表示非文件表单字段，仍可使用 --file。
    if (hasBusinessFieldFlags(flags, def.fileFields ?? [])) {
      usageError("multipart 接口使用 --json 时，只能再配合文件字段参数");
    }
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      usageError("multipart 接口的 --json 必须是 JSON 对象");
    }
    const payload = parsed as Record<string, unknown>;
    const fileValues: Record<string, string> = {};
    for (const [index, fileField] of (def.fileFields ?? []).entries()) {
      let raw = flags[fileField];
      if (raw === undefined && index === 0) raw = flags.file;
      if (raw === undefined) continue;
      if (typeof raw !== "string") usageError(`参数 --${fileField} 缺少文件路径`);
      const absolute = path.resolve(cwd, raw);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        usageError(`文件不存在：${absolute}`);
      }
      fileValues[fileField] = absolute;
    }
    const meta =
      typeof payload.meta === "string"
        ? payload.meta
        : payload.meta !== undefined
          ? stringifyPayload(payload.meta)
          : Object.keys(payload).length > 0
            ? stringifyPayload(payload)
            : "{}";
    if (payload.meta === undefined) payload.meta = meta;
    return {
      method: "POST",
      apiPath: def.path,
      contentType: "multipart",
      body: buildFormData(payload, fileValues),
      query: pathQuery,
      signBody: meta,
    };
  }

  const built = buildPayload(def, flags, { strict, validate, warn });

  if (def.method === "GET") {
    return {
      method: "GET",
      apiPath: def.path,
      contentType: "json",
      body: "",
      query: [pathQuery, toQueryString(built.payload).join("&")].filter(Boolean).join("&"),
      signBody: "",
    };
  }

  if (def.contentType === "multipart") {
    return {
      method: "POST",
      apiPath: def.path,
      contentType: "multipart",
      body: buildFormData(built.payload, built.fileValues),
      query: pathQuery,
      signBody: built.signBody,
    };
  }

  const body = stringifyPayload(built.payload);
  return {
    method: "POST",
    apiPath: def.path,
    contentType: "json",
    body,
    query: pathQuery,
    signBody: body,
  };
}

function prepareGeneric(
  apiPath: string,
  flags: Flags,
  cwd: string,
): PreparedRequest {
  const method = (stringValue(flags, "method") ?? "POST").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    usageError(`参数 --method 只支持 POST 或 GET，实际为 "${method}"`);
  }

  const { path: barePath, query: pathQuery } = splitPath(apiPath);
  const rawBody = readJsonBody(flags, cwd);

  if (method === "GET") {
    const parsed = rawBody && rawBody.trim() !== "" ? (JSON.parse(rawBody) as unknown) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      usageError("GET 请求的 --json 必须是 JSON 对象");
    }
    const query = [pathQuery, toQueryString(parsed).join("&")]
      .filter((part) => part !== "")
      .join("&");
    return {
      method: "GET",
      apiPath: barePath,
      contentType: "json",
      body: "",
      query,
      signBody: "",
    };
  }

  const body = rawBody ?? "{}";
  return {
    method: "POST",
    apiPath: barePath,
    contentType: "json",
    body,
    query: pathQuery,
    signBody: body,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function classifyBusinessResult(parsed: unknown): { failed: boolean; summary?: string } {
  const obj = asObject(parsed);
  if (!obj) return { failed: false };

  const messages: string[] = [];
  let failed = false;

  const code = obj.code;
  if (typeof code === "number" && code !== 200) {
    failed = true;
    messages.push(`code=${code}`);
  } else if (typeof code === "string" && code !== "200") {
    failed = true;
    messages.push(`code=${code}`);
  }

  if (obj.success === false) {
    failed = true;
    if (typeof obj.message === "string" && obj.message !== "") {
      messages.push(`message=${obj.message}`);
    }
  }

  return { failed, summary: messages.join(", ") };
}

async function execute(
  prepared: PreparedRequest,
  config: Config,
  flags: Flags,
  deps: InvokeDeps,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const compact = getBooleanFlag(flags, "compact");
  const raw = getBooleanFlag(flags, "raw");
  const debug = getBooleanFlag(flags, "debug");
  const timeoutMs = parseTimeout(flags);

  if (raw && compact) usageError("--raw 与 --compact 不能同时使用");

  if (!prepared.apiPath.startsWith("/")) {
    usageError(`接口路径必须以 / 开头：${prepared.apiPath}`);
  }

  const canonicalUri = prepared.query
    ? `${prepared.apiPath}?${prepared.query}`
    : prepared.apiPath;
  const url = `${config.endpoint}${canonicalUri}`;

  const timestamp = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const nonce = deps.nonce ?? createNonce();
  const stringToSign = buildStringToSign({
    method: prepared.method,
    canonicalUri,
    timestamp,
    nonce,
    body: prepared.signBody,
  });
  const signature = computeSignature(config.sk, stringToSign);
  const authorization = buildAuthorization({
    appId: config.appId,
    accessKey: config.ak,
    timestamp,
    nonce,
    signature,
  });

  const headers: Record<string, string> = {
    Authorization: authorization,
    Accept: "application/json",
    "User-Agent": `jlc-openapi-cli/${getVersion()}`,
  };
  if (prepared.contentType === "json") {
    headers["Content-Type"] = "application/json";
  }

  if (debug) {
    writeErr(stderr, `[debug] ${prepared.method} ${url}`);
    writeErr(stderr, `[debug] stringToSign=${JSON.stringify(stringToSign)}`);
    writeErr(stderr, `[debug] Authorization=${authorization}`);
    if (typeof prepared.body === "string") {
      writeErr(stderr, `[debug] body=${JSON.stringify(prepared.body)}`);
    } else {
      const keys: string[] = [];
      prepared.body.forEach((_value, key) => keys.push(key));
      writeErr(stderr, `[debug] multipart fields=${JSON.stringify(keys)}`);
    }
  }

  const response = await requestHttp({
    method: prepared.method,
    url,
    body: prepared.method === "GET" ? undefined : prepared.body,
    headers,
    timeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new CliError("http", `HTTP ${response.status}`, EXIT_NETWORK, {
      status: response.status,
      body: response.text.slice(0, 4000),
    });
  }

  const text = response.text;
  const trimmed = text.trim();

  if (trimmed === "") {
    throw new CliError("http", "服务端返回了空响应", EXIT_NETWORK);
  }

  let parsed: unknown;
  let parseOk = false;
  try {
    parsed = JSON.parse(trimmed);
    parseOk = true;
  } catch {
    parseOk = false;
  }

  if (raw) {
    writeOut(stdout, text);
  } else if (parseOk) {
    writeOut(stdout, formatJsonText(trimmed, compact ? "compact" : "pretty"));
  } else {
    writeOut(stdout, text);
  }

  if (parseOk) {
    const { failed, summary } = classifyBusinessResult(parsed);
    if (failed) {
      writeErr(stderr, `接口返回失败：${summary || "success=false"}`);
      return EXIT_API;
    }
  }

  return 0;
}

function contractOptionsForInvoke(
  config: Config,
  flags: Flags,
  deps: InvokeDeps,
  stderr: WritableLike,
): ContractOptions {
  const options: ContractOptions = {
    config,
    refresh: getBooleanFlag(flags, "refresh"),
    offline: getBooleanFlag(flags, "offline"),
    builtin: getBooleanFlag(flags, "builtin"),
    allowHttp: getBooleanFlag(flags, "allowHttp"),
    warn: (message) => writeErr(stderr, `警告：${message}`),
  };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  if (deps.homeDir) options.homeDir = deps.homeDir;
  if (deps.cachePath) options.cachePath = deps.cachePath;
  if (deps.cwd) options.cwd = deps.cwd;
  if (deps.env) options.env = deps.env;
  if (deps.now) options.now = deps.now;
  if (getBooleanFlag(flags, "debug")) {
    options.debug = (message) => writeErr(stderr, message);
  }
  return options;
}

async function resolveEndpointForInvoke(
  apiPath: string,
  flags: Flags,
  deps: InvokeDeps,
  config: Config,
  stderr: WritableLike,
): Promise<EndpointDef> {
  const bundled = getEndpoint(apiPath);
  const builtin = getBooleanFlag(flags, "builtin");
  const offline = getBooleanFlag(flags, "offline");
  const refresh = getBooleanFlag(flags, "refresh");

  if (refresh && offline) {
    usageError("--refresh 与 --offline 不能同时使用");
  }
  if (refresh && builtin) {
    usageError("--refresh 与 --builtin 不能同时使用");
  }

  if (builtin) {
    if (bundled) return bundled;
    usageError(
      `接口 ${apiPath} 不在内置契约中，--builtin 无法提供；请去掉 --builtin 或先运行 \`list --search\`。`,
    );
  }

  const options = contractOptionsForInvoke(config, flags, deps, stderr);

  // 先吃新鲜的详情缓存：`detail <path>` 预热后，invoke 会使用服务端字段。
  if (!refresh) {
    const cached = getCachedDetail(apiPath, options);
    if (cached) {
      if (cached.warning) writeErr(stderr, `警告：${cached.warning}`);
      return cached.endpoint;
    }
  }

  if (offline) {
    try {
      const result = await getDetail(apiPath, { ...options, offline: true });
      if (result.warning) writeErr(stderr, `警告：${result.warning}`);
      return result.endpoint;
    } catch (error) {
      if (error instanceof CliError && error.type === "usage") {
        const similar = findSimilarPaths(apiPath);
        usageError(
          `离线模式下无法获取接口 ${apiPath} 的契约` +
            (similar.length > 0 ? `。相近接口：${similar.join(", ")}` : "") +
            "。请先联网执行 `detail <路径>` 或去掉 --offline。",
        );
      }
      throw error;
    }
  }

  // 内置已有且未强制刷新：保持原有离线速度，不额外请求 /detail。
  if (bundled && !refresh) return bundled;

  try {
    const result = await getDetail(apiPath, options);
    if (result.warning) writeErr(stderr, `警告：${result.warning}`);
    return result.endpoint;
  } catch (error) {
    if (bundled) {
      const reason = error instanceof Error ? error.message : String(error);
      writeErr(stderr, `警告：服务端契约获取失败（${reason}），已使用内置契约。`);
      return bundled;
    }
    if (error instanceof CliError && error.type === "usage") {
      const similar = findSimilarPaths(apiPath);
      usageError(
        `未找到接口：${apiPath}` +
          (similar.length > 0 ? `。相近接口：${similar.join(", ")}` : "") +
          "。可运行 `jlc-openapi-cli list --search <关键词>` 查找，" +
          `或用 \`jlc-openapi-cli call ${apiPath} --json '<body>'\` 通用调用。`,
      );
    }
    throw error;
  }
}

/** 调用已注册接口。 */
export async function runInvoke(
  apiPath: string,
  flags: Flags,
  deps: InvokeDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const split = splitPath(apiPath);
  const matched = matchEndpointPath(split.path);
  const normalized = matched
    ? matched.path
    : normalizeApiPath(split.path, {
        knownPaths: allEndpoints().map((endpoint) => endpoint.path),
      }).path;

  const config = resolveRuntimeConfig({
    ...(stringValue(flags, "config") ? { configPath: stringValue(flags, "config") as string } : {}),
    ...(stringValue(flags, "endpoint") ? { endpoint: stringValue(flags, "endpoint") as string } : {}),
    cwd,
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    allowHttp: getBooleanFlag(flags, "allowHttp"),
  });

  const def = await resolveEndpointForInvoke(normalized, flags, deps, config, stderr);
  const prepared = prepareRegistered(def, flags, cwd, stderr, split.query);
  return execute(prepared, config, flags, deps);
}

/** 通用兜底调用，用于未注册接口。 */
export async function runCall(
  apiPath: string,
  flags: Flags,
  deps: InvokeDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const config = resolveRuntimeConfig({
    ...(stringValue(flags, "config") ? { configPath: stringValue(flags, "config") as string } : {}),
    ...(stringValue(flags, "endpoint") ? { endpoint: stringValue(flags, "endpoint") as string } : {}),
    cwd,
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    allowHttp: getBooleanFlag(flags, "allowHttp"),
  });
  const prepared = prepareGeneric(apiPath, flags, cwd);
  return execute(prepared, config, flags, deps);
}

export type { EndpointDef, FetchLike };
