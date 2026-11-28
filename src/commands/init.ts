import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { getBooleanFlag, getStringFlag, hasFlag, type Flags } from "../args";
import {
  CONFIG_FILE_NAME,
  DEFAULT_ENDPOINT,
  ENV_KEYS,
  homeConfigPath,
  validateEndpoint,
  writeConfig,
  type Config,
} from "../config";
import {
  CliError,
  EXIT_USAGE,
  usageError,
  writeOut,
  type WritableLike,
} from "../output";
import { installSkill, renderSkillInstructions } from "../skill-install";

export interface InitDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  skillSourceDir?: string;
  packageRoot?: string;
}

function flagOrUndefined(flags: Flags, name: string): string | undefined {
  if (!hasFlag(flags, name)) return undefined;
  const value = getStringFlag(flags, name);
  if (value === undefined || value === "") usageError(`参数 --${name} 缺少值`);
  return value.trim();
}

function isInteractive(stdin: NodeJS.ReadStream): boolean {
  return Boolean(stdin.isTTY);
}

async function promptLine(
  question: string,
  stdin: NodeJS.ReadStream,
  stdout: WritableLike,
): Promise<string> {
  const rl = createInterface({
    input: stdin,
    output: stdout as unknown as NodeJS.WritableStream,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 隐藏输入的密码读取（仅 TTY 时掩码）。 */
async function promptSecret(
  question: string,
  stdin: NodeJS.ReadStream,
  stdout: WritableLike,
): Promise<string> {
  if (!stdin.isTTY) {
    return promptLine(question, stdin, stdout);
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("usage", "已取消", EXIT_USAGE));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function confirmOverwrite(
  target: string,
  stdin: NodeJS.ReadStream,
  stdout: WritableLike,
): Promise<boolean> {
  const answer = await promptLine(
    `配置文件已存在：${target}\n是否覆盖？(y/N): `,
    stdin,
    stdout,
  );
  return /^y(es)?$/i.test(answer);
}

export async function runInit(flags: Flags, deps: InitDeps = {}): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const allowHttp = getBooleanFlag(flags, "allowHttp");

  const configPathFlag = flagOrUndefined(flags, "config");
  const target = configPathFlag
    ? path.resolve(configPathFlag)
    : homeConfigPath(homeDir);

  if (fs.existsSync(target) && !getBooleanFlag(flags, "force")) {
    if (!isInteractive(stdin)) {
      usageError(`配置文件已存在：${target}。如需覆盖请加 --force。`);
    }
    const confirmed = await confirmOverwrite(target, stdin, stdout);
    if (!confirmed) {
      writeOut(stdout, "已取消，未修改配置。");
      return 0;
    }
  }

  let appId = flagOrUndefined(flags, "appId") ?? env[ENV_KEYS.appId]?.trim();
  let ak = flagOrUndefined(flags, "ak") ?? env[ENV_KEYS.ak]?.trim();
  let sk = flagOrUndefined(flags, "sk") ?? env[ENV_KEYS.sk]?.trim();
  const endpointFlag = flagOrUndefined(flags, "endpoint") ?? env[ENV_KEYS.endpoint]?.trim();

  const missing = [
    appId ? null : "appId",
    ak ? null : "ak",
    sk ? null : "sk",
  ].filter((item): item is string => item !== null);

  if (missing.length > 0) {
    if (!isInteractive(stdin)) {
      usageError(
        `缺少 ${missing.join(", ")}。非交互环境下请使用 --appId/--ak/--sk 参数，` +
          `或设置环境变量 ${missing
            .map((key) => ENV_KEYS[key as keyof typeof ENV_KEYS])
            .join(", ")}。`,
      );
    }

    if (!appId) appId = await promptLine("appId: ", stdin, stdout);
    if (!ak) ak = await promptLine("ak: ", stdin, stdout);
    if (!sk) sk = await promptSecret("sk: ", stdin, stdout);
  }

  const emptyFields = [
    appId ? null : "appId",
    ak ? null : "ak",
    sk ? null : "sk",
  ].filter((item): item is string => item !== null);
  if (emptyFields.length > 0) {
    usageError(`${emptyFields.join(", ")} 不能为空`);
  }

  let endpoint = endpointFlag;
  if (!endpoint) {
    if (isInteractive(stdin)) {
      const answer = await promptLine(
        `endpoint [${DEFAULT_ENDPOINT}]: `,
        stdin,
        stdout,
      );
      endpoint = answer || DEFAULT_ENDPOINT;
    } else {
      endpoint = DEFAULT_ENDPOINT;
    }
  }

  validateEndpoint(endpoint, allowHttp);

  const config: Config = {
    appId: appId as string,
    ak: ak as string,
    sk: sk as string,
    endpoint: endpoint.replace(/\/+$/, ""),
  };

  const writtenPath = writeConfig(config, target);

  writeOut(stdout, `配置已保存到 ${writtenPath}`);
  writeOut(stdout, `appId=${config.appId}  endpoint=${config.endpoint}  sk=****`);
  writeOut(stdout, `配置文件包含明文密钥（权限已尽量设为 0600），请勿提交到代码仓库。`);

  if (!getBooleanFlag(flags, "noSkill")) {
    const skillResult = installSkill({
      homeDir,
      ...(deps.skillSourceDir ? { sourceDir: deps.skillSourceDir } : {}),
      ...(deps.packageRoot ? { packageRoot: deps.packageRoot } : {}),
    });
    writeOut(stdout, "");
    for (const line of renderSkillInstructions(skillResult)) {
      writeOut(stdout, line);
    }
  }
  return 0;
}
