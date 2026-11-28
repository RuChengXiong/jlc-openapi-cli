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

test("installSkill 复制到 ~/.jlc-openapi-cli/skill", () => {
  const home = tempDir("jlc-skill-home-");
  const source = makeSkillSource();
  const result = installSkill({ homeDir: home, sourceDir: source });
  assert.equal(result.installed, true);
  assert.equal(result.destination, path.join(home, ".jlc-openapi-cli", "skill"));
  assert.ok(fs.existsSync(path.join(result.destination, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(result.destination, "references", "examples.md")));
});

test("installSkill 替换旧目录但不删除父目录中的缓存", () => {
  const home = tempDir("jlc-skill-home-");
  const cacheDir = path.join(home, ".jlc-openapi-cli");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "contracts-cache.json"), "{}", "utf8");
  fs.mkdirSync(path.join(cacheDir, "skill"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "skill", "old.txt"), "old", "utf8");

  const result = installSkill({ homeDir: home, sourceDir: makeSkillSource() });
  assert.equal(result.installed, true);
  assert.equal(fs.existsSync(path.join(cacheDir, "skill", "old.txt")), false);
  assert.ok(fs.existsSync(path.join(cacheDir, "skill", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cacheDir, "contracts-cache.json")));
});

test("installSkill 源缺失时返回未安装", () => {
  const home = tempDir("jlc-skill-home-");
  const result = installSkill({
    homeDir: home,
    sourceDir: path.join(home, "missing-skill"),
  });
  assert.equal(result.installed, false);
  assert.ok(result.reason?.includes("SKILL.md"));
  const lines = renderSkillInstructions(result).join("\n");
  assert.ok(lines.includes("npx skills add"));
});

test("renderSkillInstructions 包含三个目标与 PowerShell", () => {
  const result = installSkill({
    homeDir: tempDir("jlc-skill-home-"),
    sourceDir: makeSkillSource(),
  });
  const text = renderSkillInstructions(result).join("\n");
  assert.ok(text.includes(".claude"));
  assert.ok(text.includes(".agents"));
  assert.ok(text.includes("Copy-Item"));
  assert.ok(text.includes("npx skills add"));
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
  assert.equal(fs.existsSync(path.join(home, ".jlc-openapi-cli", "skill", "SKILL.md")), false);

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
  assert.ok(fs.existsSync(path.join(home, ".jlc-openapi-cli", "skill", "SKILL.md")));
});
