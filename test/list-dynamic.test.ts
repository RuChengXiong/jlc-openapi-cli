import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../src/args";
import { runDetail, runList } from "../src/commands/list";
import type { FetchLike, ResponseLike } from "../src/http";

const ENDPOINT = "https://api.example.com";
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-list-cache-"));
const ENV = {
  JLC_OPENAPI_APP_ID: "app",
  JLC_OPENAPI_ACCESS_KEY: "ak",
  JLC_OPENAPI_SECRET_KEY: "sk",
  JLC_OPENAPI_ENDPOINT: ENDPOINT,
  JLC_OPENAPI_CACHE_DIR: CACHE_DIR,
} as NodeJS.ProcessEnv;
const NOW = 1_700_000_000_000;

const CATALOG = [
  {
    businessTypeCode: "PCB",
    businessTypeName: "PCB业务",
    apis: [
      { apiUri: "/pcb/order/create", apiName: "创建订单", apiDescn: "创建 PCB 订单" },
    ],
  },
  {
    businessTypeCode: "Test",
    businessTypeName: "测试业务",
    apis: [
      {
        apiUri: "/remote/newEndpoint",
        apiName: "远端新接口",
        apiDescn: "来自服务端的新接口",
      },
    ],
  },
];

const DETAIL = {
  apiUri: "/remote/newEndpoint",
  apiName: "远端新接口",
  businessTypeName: "测试业务",
  method: "POST",
  contentType: "json",
  input: [
    { name: "orderId", type: "Long", required: true, desc: "订单 id" },
    {
      name: "items",
      type: "List<Item>",
      items: { type: "Object", children: [{ name: "code", type: "String" }] },
    },
  ],
  output: [{ name: "ok", type: "Boolean" }],
  inputExample: { orderId: 1 },
  errorCode: [{ name: "200", type: "Integer", desc: "成功" }],
  agentGuidance: "先确认订单状态。",
};

function response(status: number, body: unknown): ResponseLike {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function mockFetch(
  handler: (url: string) => ResponseLike,
): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      return handler(url);
    },
  };
}

function collector(): {
  out: string[];
  err: string[];
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (chunk: string) => (out.push(chunk), true) },
    stderr: { write: (chunk: string) => (err.push(chunk), true) },
  };
}

function deps(fetchImpl: FetchLike, streams: ReturnType<typeof collector>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-list-case-"));
  return {
    ...streams,
    fetchImpl,
    env: ENV,
    homeDir: dir,
    cachePath: path.join(dir, "contracts-cache.json"),
    now: () => NOW,
  };
}

test("list --json 使用服务端目录", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));
  const streams = collector();
  const flags = parseArgs(["list", "--json"]).flags;
  const code = await runList(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  const payload = JSON.parse(streams.out.join(""));
  assert.equal(payload.meta.source, "server");
  assert.equal(payload.total, 2);
  assert.equal(payload.endpoints[0].path, "/pcb/order/create");
  assert.equal(calls.length, 1);
});

test("detail 使用服务端详情，输出 agentGuidance/响应/错误码", async () => {
  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/detail") ? response(200, DETAIL) : response(200, CATALOG),
  );
  const streams = collector();
  const flags = parseArgs(["detail", "/remote/newEndpoint", "--json"]).flags;
  const code = await runList(flags, "/remote/newEndpoint", deps(fetchImpl, streams));
  assert.equal(code, 0);
  const payload = JSON.parse(streams.out.join(""));
  assert.equal(payload.path, "/remote/newEndpoint");
  assert.equal(payload.agentGuidance, "先确认订单状态。");
  assert.ok(payload.fields.some((field: { path: string }) => field.path === "items.code"));
  assert.equal(payload.output[0].path, "ok");
  assert.equal(payload.errorCodes[0].name, "200");
  assert.equal(payload.contract.source, "server");
  assert.equal(calls.some((url) => url.endsWith("/detail")), true);
});

test("--refresh /path 与 /path --refresh 都能恢复 target", async () => {
  const { fetchImpl } = mockFetch((url) =>
    url.endsWith("/detail") ? response(200, DETAIL) : response(200, CATALOG),
  );
  const streams = collector();
  const flags = parseArgs(["list", "--refresh", "/remote/newEndpoint"]).flags;
  const code = await runList(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.ok(streams.out.join("").includes("远端新接口"));
  assert.ok(streams.out.join("").includes("先确认订单状态。"));
});

test("--json /path 不会把路径当成 JSON 参数", async () => {
  const { fetchImpl } = mockFetch((url) =>
    url.endsWith("/detail") ? response(200, DETAIL) : response(200, CATALOG),
  );
  const streams = collector();
  const flags = parseArgs(["list", "--json", "/remote/newEndpoint"]).flags;
  const code = await runList(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  const payload = JSON.parse(streams.out.join(""));
  assert.equal(payload.path, "/remote/newEndpoint");
});

test("服务端目录失败时回退内置 111 条", async () => {
  const { fetchImpl } = mockFetch(() => response(500, "down"));
  const streams = collector();
  const flags = parseArgs(["list", "--json"]).flags;
  const code = await runList(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  const payload = JSON.parse(streams.out.join(""));
  assert.equal(payload.meta.source, "bundled");
  assert.equal(payload.total, 111);
  assert.ok(streams.err.join("").includes("警告"));
});

test("/list 成功但 /detail 失败时仍输出目录摘要", async () => {
  const { fetchImpl } = mockFetch((url) =>
    url.endsWith("/detail") ? response(500, "down") : response(200, CATALOG),
  );
  const streams = collector();
  const flags = parseArgs(["list", "/remote/newEndpoint"]).flags;
  const code = await runList(flags, "/remote/newEndpoint", deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.ok(streams.out.join("").includes("远端新接口"));
  assert.ok(streams.err.join("").includes("详情获取失败"));
});

test("--builtin 不访问网络", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));
  const streams = collector();
  const flags = parseArgs(["list", "--json", "--builtin"]).flags;
  const code = await runList(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  const payload = JSON.parse(streams.out.join(""));
  assert.equal(payload.meta.source, "bundled");
  assert.equal(payload.total, 111);
  assert.equal(calls.length, 0);
});

test("detail --builtin 能恢复被 MSYS 改写的路径", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(500, "should not fetch"));
  const streams = collector();
  const flags = parseArgs([
    "detail",
    "--builtin",
    "C:/Program Files/Git/pcb/order/create",
  ]).flags;
  const code = await runDetail(flags, undefined, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.ok(streams.out.join("").includes("创建订单"));
  assert.equal(calls.length, 0);
});
