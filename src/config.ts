import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configError } from "./output";

export const CONFIG_FILE_NAME = "jlc-openapi-config.json";
export const DEFAULT_ENDPOINT = "https://open-api.jlc.com";

export interface Config {
  appId: string;
  ak: string;
  sk: string;
  endpoint: string;
}

export type PartialConfig = Partial<Config>;

export interface LoadConfigOptions {
  /** 显式指定的配置文件；指定后不再回退到默认位置。 */
  configPath?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 仅用于本地调试，允许 http:// endpoint。 */
  allowHttp?: boolean;
}

export const ENV_KEYS = {
  appId: "JLC_OPENAPI_APP_ID",
  ak: "JLC_OPENAPI_ACCESS_KEY",
  sk: "JLC_OPENAPI_SECRET_KEY",
  endpoint: "JLC_OPENAPI_ENDPOINT",
} as const;

export function homeConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, CONFIG_FILE_NAME);
}

export function resolveConfigCandidates(options: LoadConfigOptions = {}): string[] {
  if (options.configPath) {
    return [path.resolve(options.configPath)];
  }
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  return [path.resolve(cwd, CONFIG_FILE_NAME), homeConfigPath(homeDir)];
}

export function readConfigFile(filePath: string): PartialConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw configError(`读取配置文件失败：${filePath}（${(error as Error).message}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`配置文件不是合法的 JSON：${filePath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError(`配置文件内容必须是 JSON 对象：${filePath}`);
  }

  const obj = parsed as Record<string, unknown>;
  const result: PartialConfig = {};
  for (const key of ["appId", "ak", "sk", "endpoint"] as const) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") {
      result[key] = value.trim();
    }
  }
  return result;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取配置。
 *
 * 优先级：显式 `--config` > 当前目录 > 用户主目录；
 * 环境变量按字段覆盖文件中的值。
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const candidates = resolveConfigCandidates(options);

  let fromFile: PartialConfig = {};
  let usedFile: string | undefined;

  if (options.configPath) {
    const target = candidates[0] as string;
    if (!fileExists(target)) {
      throw configError(`指定的配置文件不存在：${target}`);
    }
    fromFile = readConfigFile(target);
    usedFile = target;
  } else {
    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        fromFile = readConfigFile(candidate);
        usedFile = candidate;
        break;
      }
    }
  }

  const merged: PartialConfig = {
    appId: env[ENV_KEYS.appId] || fromFile.appId,
    ak: env[ENV_KEYS.ak] || fromFile.ak,
    sk: env[ENV_KEYS.sk] || fromFile.sk,
    endpoint: env[ENV_KEYS.endpoint] || fromFile.endpoint || DEFAULT_ENDPOINT,
  };

  const missing = (["appId", "ak", "sk"] as const).filter((key) => !merged[key]);
  if (missing.length > 0) {
    const where = usedFile ? `配置文件 ${usedFile} 中` : "未找到配置文件";
    throw configError(
      `${where}缺少必要字段：${missing.join(", ")}。请运行 \`jlc-openapi-cli init\` 或设置环境变量 ` +
        `${missing.map((key) => ENV_KEYS[key]).join(", ")}。`,
    );
  }

  const config: Config = {
    appId: merged.appId as string,
    ak: merged.ak as string,
    sk: merged.sk as string,
    endpoint: (merged.endpoint as string).replace(/\/+$/, ""),
  };

  validateEndpoint(config.endpoint, options.allowHttp ?? false);
  return config;
}

export function validateEndpoint(endpoint: string, allowHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw configError(`endpoint 不是合法的 URL：${endpoint}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && allowHttp) return;
  throw configError(`endpoint 必须以 https:// 开头：${endpoint}`);
}

/**
 * 读取配置，但不要求 appId/ak/sk 完整。
 *
 * - 显式 `--config` 不存在或损坏时仍然抛错；
 * - 隐式查找时，缺失或损坏返回空配置，让 `list` 可以降级到缓存/内置。
 */
export function loadPartialConfig(options: LoadConfigOptions = {}): PartialConfig {
  const env = options.env ?? process.env;
  const candidates = resolveConfigCandidates(options);

  let fromFile: PartialConfig = {};
  if (options.configPath) {
    const target = candidates[0] as string;
    if (!fileExists(target)) {
      throw configError(`指定的配置文件不存在：${target}`);
    }
    fromFile = readConfigFile(target);
  } else {
    for (const candidate of candidates) {
      if (!fileExists(candidate)) continue;
      try {
        fromFile = readConfigFile(candidate);
      } catch {
        fromFile = {};
      }
      break;
    }
  }

  return {
    ...(env[ENV_KEYS.appId] || fromFile.appId
      ? { appId: env[ENV_KEYS.appId] || fromFile.appId }
      : {}),
    ...(env[ENV_KEYS.ak] || fromFile.ak ? { ak: env[ENV_KEYS.ak] || fromFile.ak } : {}),
    ...(env[ENV_KEYS.sk] || fromFile.sk ? { sk: env[ENV_KEYS.sk] || fromFile.sk } : {}),
    ...(env[ENV_KEYS.endpoint] || fromFile.endpoint
      ? { endpoint: (env[ENV_KEYS.endpoint] || fromFile.endpoint) as string }
      : {}),
  };
}

export interface ContractRuntimeConfig {
  appId?: string;
  ak?: string;
  endpoint: string;
}

export interface ContractConfigOptions extends LoadConfigOptions {
  /** 命令行 `--endpoint` 覆盖。 */
  endpoint?: string;
}

/** 契约接口只需要 appId/ak/endpoint，不要求 sk。 */
export function resolveContractConfig(options: ContractConfigOptions = {}): ContractRuntimeConfig {
  const partial = loadPartialConfig(options);
  const endpoint = (options.endpoint || partial.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  validateEndpoint(endpoint, options.allowHttp ?? false);
  return {
    ...(partial.appId ? { appId: partial.appId } : {}),
    ...(partial.ak ? { ak: partial.ak } : {}),
    endpoint,
  };
}

export interface RuntimeConfigOptions {
  configPath?: string;
  endpoint?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  allowHttp?: boolean;
}

/** 业务请求的完整配置；与契约请求共用同一个 endpoint。 */
export function resolveRuntimeConfig(options: RuntimeConfigOptions = {}): Config {
  const partial = loadPartialConfig({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
    allowHttp: options.allowHttp ?? false,
  });

  const missing = (["appId", "ak", "sk"] as const).filter((key) => !partial[key]);
  if (missing.length > 0) {
    throw configError(
      `缺少必要字段：${missing.join(", ")}。请运行 \`jlc-openapi-cli init\` 或设置环境变量 ` +
        `${missing.map((key) => ENV_KEYS[key]).join(", ")}。`,
    );
  }

  const endpoint = (options.endpoint || partial.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  validateEndpoint(endpoint, options.allowHttp ?? false);

  return {
    appId: partial.appId as string,
    ak: partial.ak as string,
    sk: partial.sk as string,
    endpoint,
  };
}

/**
 * 原子写入配置文件，并尽量把权限设为 0600。
 */
export function writeConfig(config: Config, filePath: string = homeConfigPath()): string {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const content = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = `${target}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Windows 上可能不支持，忽略。
    }
    fs.renameSync(tempPath, target);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw configError(`写入配置文件失败：${target}（${(error as Error).message}）`);
  }

  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // ignore
  }

  return target;
}
