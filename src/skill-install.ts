import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SkillInstallResult {
  source: string;
  destination: string;
  installed: boolean;
  reason?: string;
  targets: {
    claudeCode: string;
    codex: string;
    generic: string;
  };
}

export interface SkillInstallOptions {
  homeDir?: string;
  sourceDir?: string;
  packageRoot?: string;
}

/**
 * 找到 npm 包内的 skill 目录。
 *
 * 本文件编译后位于 dist/，开发时位于 src/，上一级都是包根，
 * 因此 `../skills/jlc-openapi-cli` 在两种情况下都成立。
 */
export function packageSkillDir(packageRoot?: string): string {
  if (packageRoot) return path.join(packageRoot, "skills", "jlc-openapi-cli");
  return path.resolve(__dirname, "..", "skills", "jlc-openapi-cli");
}

export function installSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const homeDir = options.homeDir ?? os.homedir();
  const source = options.sourceDir ?? packageSkillDir(options.packageRoot);
  const destination = path.join(homeDir, ".jlc-openapi-cli", "skill");
  const targets = {
    claudeCode: path.join(homeDir, ".claude", "skills", "jlc-openapi-cli"),
    codex: path.join(homeDir, ".agents", "skills", "jlc-openapi-cli"),
    generic: path.join(homeDir, ".agents", "skills", "jlc-openapi-cli"),
  };

  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    return {
      source,
      destination,
      installed: false,
      reason: `未找到 skill 源文件：${path.join(source, "SKILL.md")}`,
      targets,
    };
  }

  const parent = path.dirname(destination);
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.rmSync(temp, { recursive: true, force: true });
    fs.cpSync(source, temp, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temp, destination);
    return { source, destination, installed: true, targets };
  } catch (error) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return {
      source,
      destination,
      installed: false,
      reason: `复制 skill 失败：${error instanceof Error ? error.message : String(error)}`,
      targets,
    };
  }
}

export function renderSkillInstructions(result: SkillInstallResult): string[] {
  if (!result.installed) {
    return [`Skill 未安装：${result.reason ?? "未知原因"}`];
  }

  return [
    `Skill 已复制到 ${result.destination}`,
    "安装到智能体：",
    `  Claude Code:  ${result.targets.claudeCode}`,
    `  Codex:        ${result.targets.codex}（部分版本使用 ~/.codex/skills，按客户端设置）`,
    `  通用 agents:  ${result.targets.generic}`,
  ];
}
