import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../src/args";
import { runInit } from "../src/commands/init";
import { installSkill, renderSkillInstructions } from "../src/skill-install";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSkillSource(): string {
  const source = tempDir("jlc-skill-source-");
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: jlc-openapi-cli\n---\n", "utf8");
  fs.mkdirSync(path.join(source, "references"));
  fs.writeFileSync(path.join(source, "references", "examples.md"), "# 示例\n", "utf8");
  return source;
}

test("installSkill 复制到 ~/jlc-openapi-cli", () => {
  const home = tempDir("jlc-skill-home-");
  const source = makeSkillSource();
  const result = installSkill({ homeDir: home, sourceDir: source });
  assert.equal(result.installed, true);
  assert.equal(result.destination, path.join(home, "jlc-openapi-cli"));
  assert.ok(fs.existsSync(path.join(result.destination, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(result.destination, "references", "examples.md")));
  assert.equal(fs.existsSync(path.join(home, ".jlc-openapi-cli", "skill")), false);
});

test("installSkill 替换旧 skill 目录但不删除缓存", () => {
  const home = tempDir("jlc-skill-home-");
  const cacheDir = path.join(home, ".jlc-openapi-cli");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "contracts-cache.json"), "{}", "utf8");

  const oldSkill = path.join(home, "jlc-openapi-cli");
  fs.mkdirSync(oldSkill, { recursive: true });
  fs.writeFileSync(path.join(oldSkill, "SKILL.md"), "old skill", "utf8");
  fs.writeFileSync(path.join(oldSkill, "old.txt"), "old", "utf8");

  const result = installSkill({ homeDir: home, sourceDir: makeSkillSource() });
  assert.equal(result.installed, true);
  assert.equal(fs.existsSync(path.join(oldSkill, "old.txt")), false);
  assert.ok(fs.existsSync(path.join(oldSkill, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cacheDir, "contracts-cache.json")));
});

test("installSkill 拒绝覆盖代码仓库目录", () => {
  const home = tempDir("jlc-skill-home-");
  const destination = path.join(home, "jlc-openapi-cli");
  fs.mkdirSync(path.join(destination, ".git"), { recursive: true });
  fs.writeFileSync(path.join(destination, "keep.txt"), "keep", "utf8");

  const result = installSkill({ homeDir: home, sourceDir: makeSkillSource() });
  assert.equal(result.installed, false);
  assert.ok(result.reason?.includes("代码仓库"));
  assert.ok(fs.existsSync(path.join(destination, "keep.txt")));
  assert.equal(fs.existsSync(path.join(destination, "SKILL.md")), false);
});

test("installSkill 拒绝覆盖没有 SKILL.md 的同名目录", () => {
  const home = tempDir("jlc-skill-home-");
  const destination = path.join(home, "jlc-openapi-cli");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "keep.txt"), "keep", "utf8");

  const result = installSkill({ homeDir: home, sourceDir: makeSkillSource() });
  assert.equal(result.installed, false);
  assert.ok(result.reason?.includes("不是 skill"));
  assert.ok(fs.existsSync(path.join(destination, "keep.txt")));
});

test("installSkill 源缺失时返回未安装，且不提示 npx", () => {
  const home = tempDir("jlc-skill-home-");
  const result = installSkill({
    homeDir: home,
    sourceDir: path.join(home, "missing-skill"),
  });
  assert.equal(result.installed, false);
  assert.ok(result.reason?.includes("SKILL.md"));
  const lines = renderSkillInstructions(result).join("\n");
  assert.ok(lines.includes("Skill 未安装"));
  assert.equal(lines.includes("npx skills add"), false);
});

test("renderSkillInstructions 只提示三个目标路径", () => {
  const result = installSkill({
    homeDir: tempDir("jlc-skill-home-"),
    sourceDir: makeSkillSource(),
  });
  const text = renderSkillInstructions(result).join("\n");
  assert.ok(text.includes(".claude"));
  assert.ok(text.includes(".agents"));
  assert.ok(text.includes("Skill 已复制到"));
  assert.equal(text.includes("cp -r"), false);
  assert.equal(text.includes("Copy-Item"), false);
  assert.equal(text.includes("npx skills add"), false);
});

test("init --no-skill 不复制 skill，默认复制", async () => {
  const home = tempDir("jlc-init-home-");
  const source = makeSkillSource();
  const out: string[] = [];
  const streams = {
    stdout: { write: (chunk: string) => (out.push(chunk), true) },
    stderr: { write: () => true },
  };

  const noSkillFlags = parseArgs([
    "init",
    "--appId",
    "app",
    "--ak",
    "ak",
    "--sk",
    "sk",
    "--endpoint",
    "https://api.example.com",
    "--no-skill",
    "--force",
  ]).flags;
  await runInit(noSkillFlags, {
    homeDir: home,
    env: {},
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(fs.existsSync(path.join(home, "jlc-openapi-cli", "SKILL.md")), false);

  const flags = parseArgs([
    "init",
    "--appId",
    "app",
    "--ak",
    "ak",
    "--sk",
    "sk",
    "--endpoint",
    "https://api.example.com",
    "--force",
  ]).flags;
  await runInit(flags, {
    homeDir: home,
    env: {},
    stdout: streams.stdout,
    stderr: streams.stderr,
    skillSourceDir: source,
  });
  assert.ok(fs.existsSync(path.join(home, "jlc-openapi-cli", "SKILL.md")));

  const text = out.join("");
  assert.ok(text.includes("配置已保存到"));
  assert.ok(text.indexOf("配置已保存到") < text.indexOf("Skill 已复制到"));
  assert.equal(text.includes("cp -r"), false);
  assert.equal(text.includes("Copy-Item"), false);
  assert.equal(text.includes("npx skills add"), false);
});

test("init 缺少凭据时先报错，不安装 skill", async () => {
  const home = tempDir("jlc-init-missing-");
  const out: string[] = [];
  await assert.rejects(
    runInit(parseArgs(["init", "--force"]).flags, {
      homeDir: home,
      env: {},
      stdout: { write: (chunk: string) => (out.push(chunk), true) },
      stderr: { write: () => true },
    }),
    /缺少/,
  );
  assert.equal(fs.existsSync(path.join(home, "jlc-openapi-cli")), false);
});
