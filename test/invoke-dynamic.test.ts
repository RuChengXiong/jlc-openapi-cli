import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../src/args";
import { runInvoke } from "../src/commands/invoke";
import type { FetchLike, ResponseLike } from "../src/http";
import { CliError } from "../src/output";
import { computeSignature } from "../src/sign";

const ENDPOINT = "https://api.example.com";
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-invoke-dynamic-"));
const ENV = {
  JLC_OPENAPI_APP_ID: "app",
  JLC_OPENAPI_ACCESS_KEY: "ak",
  JLC_OPENAPI_SECRET_KEY: "sk",
  JLC_OPENAPI_ENDPOINT: ENDPOINT,
  JLC_OPENAPI_CACHE_DIR: CACHE_DIR,
} as NodeJS.ProcessEnv;
const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = 1_700_000_000;
const NONCE = "N".repeat(32);

const NEW_DETAIL = {
  apiUri: "/remote/newEndpoint",
  apiName: "远端新接口",
  businessTypeName: "测试业务",
  method: "POST",
  contentType: "json",
  input: [{ name: "orderId", type: "Long", required: true, desc: "订单 id" }],
  output: [{ name: "ok", type: "Boolean" }],
  agentGuidance: "先确认订单状态。",
};

const PAGE_DETAIL = {
  apiUri: "/pcb/order/getOrderPageList",
  method: "GET",
  contentType: "json",
  input: [{ name: "newField", type: "String", required: false, desc: "服务端新增字段" }],
};

interface Capture {
  url: string;
  init: RequestInit;
}

function response(status: number, body: unknown): ResponseLike {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function mockFetch(
  handler: (url: string) => ResponseLike,
): { fetchImpl: FetchLike; calls: Capture[] } {
  const calls: Capture[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-invoke-dynamic-case-"));
  return {
    ...streams,
    fetchImpl,
    env: ENV,
    homeDir: dir,
    cachePath: path.join(dir, "contracts-cache.json"),
    now: () => NOW_MS,
    nonce: NONCE,
  };
}

test("未知新路径先请求 /detail，再按签名调用", async () => {
  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/detail")
      ? response(200, NEW_DETAIL)
      : response(200, { code: 200, data: { ok: true } }),
  );
  const streams = collector();
  const flags = parseArgs(["/remote/newEndpoint", "--orderId", "50001"]).flags;

  const code = await runInvoke("/remote/newEndpoint", flags, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${ENDPOINT}/detail`);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    apiUri: "/remote/newEndpoint",
  });
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).Authorization,
    undefined,
  );

  const business = calls[1]!;
  assert.equal(business.url, `${ENDPOINT}/remote/newEndpoint`);
  const body = business.init.body as string;
  assert.deepEqual(JSON.parse(body), { orderId: 50001 });
  const headers = business.init.headers as Record<string, string>;
  const signature = /signature="([^"]+)"/.exec(headers.Authorization as string)?.[1];
  assert.ok(signature);
  const stringToSign = `POST\n/remote/newEndpoint\n${NOW_SECONDS}\n${NONCE}\n${body}\n`;
  assert.equal(computeSignature("sk", stringToSign), signature);
});

test("--refresh 刷新内置路径，但保留 method/contentType/strict，且不把 flag 写进 body", async () => {
  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/detail")
      ? response(200, PAGE_DETAIL)
      : response(200, { code: 200 }),
  );
  const streams = collector();
  const flags = parseArgs([
    "/pcb/order/getOrderPageList",
    "--orderType",
    "examples",
    "--orderDateBegin",
    "2026-11-11 00:00:00",
    "--orderDateEnd",
    "2026-11-16 18:00:00",
    "--pageSize",
    "10",
    "--pageNum",
    "1",
    "--newField",
    "remote-value",
    "--refresh",
  ]).flags;

  const code = await runInvoke("/pcb/order/getOrderPageList", flags, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  const business = calls[1]!;
  assert.equal(business.init.method, "POST");
  const body = JSON.parse(business.init.body as string);
  assert.equal(body.newField, "remote-value");
  assert.equal(body.refresh, undefined);
  assert.equal(body.offline, undefined);
  assert.equal(body.builtin, undefined);
});

test("内置路径默认不请求 /detail", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(200, { code: 200 }));
  const streams = collector();
  const flags = parseArgs([
    "/pcb/order/getOrderPageList",
    "--orderType",
    "examples",
    "--orderDateBegin",
    "2026-11-11 00:00:00",
    "--orderDateEnd",
    "2026-11-16 18:00:00",
    "--pageSize",
    "10",
    "--pageNum",
    "1",
  ]).flags;

  const code = await runInvoke("/pcb/order/getOrderPageList", flags, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ENDPOINT}/pcb/order/getOrderPageList`);
});

test("--endpoint 同时作用于契约和业务请求", async () => {
  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/detail")
      ? response(200, NEW_DETAIL)
      : response(200, { code: 200 }),
  );
  const streams = collector();
  const flags = parseArgs([
    "/remote/newEndpoint",
    "--orderId",
    "1",
    "--endpoint",
    "https://override.example.com",
  ]).flags;

  const code = await runInvoke("/remote/newEndpoint", flags, deps(fetchImpl, streams));
  assert.equal(code, 0);
  assert.equal(calls[0]!.url, "https://override.example.com/detail");
  assert.equal(calls[1]!.url, "https://override.example.com/remote/newEndpoint");
});

test("--builtin 对未内置路径给出用法错误", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(200, NEW_DETAIL));
  const streams = collector();
  const flags = parseArgs(["/remote/newEndpoint", "--builtin"]).flags;
  await assert.rejects(
    runInvoke("/remote/newEndpoint", flags, deps(fetchImpl, streams)),
    (error: unknown) => error instanceof CliError && error.exitCode === 2,
  );
  assert.equal(calls.length, 0);
});

test("--offline 没有缓存时给出用法错误", async () => {
  const { fetchImpl, calls } = mockFetch(() => response(200, NEW_DETAIL));
  const streams = collector();
  const flags = parseArgs(["/remote/newEndpoint", "--offline"]).flags;
  await assert.rejects(
    runInvoke("/remote/newEndpoint", flags, deps(fetchImpl, streams)),
    (error: unknown) => error instanceof CliError && error.exitCode === 2,
  );
  assert.equal(calls.length, 0);
});

test("MSYS 路径可正确归一化", async () => {
  const { fetchImpl, calls } = mockFetch((url) =>
    url.endsWith("/detail")
      ? response(200, NEW_DETAIL)
      : response(200, { code: 200 }),
  );
  const streams = collector();
  const flags = parseArgs(["--orderId", "1"]).flags;
  const code = await runInvoke(
    "C:/Program Files/Git/remote/newEndpoint",
    flags,
    deps(fetchImpl, streams),
  );
  assert.equal(code, 0);
  assert.equal(calls[0]!.url, `${ENDPOINT}/detail`);
  assert.equal(calls[1]!.url, `${ENDPOINT}/remote/newEndpoint`);
});
