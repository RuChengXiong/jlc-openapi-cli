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

const ENV = {
  JLC_OPENAPI_APP_ID: "test-app",
  JLC_OPENAPI_ACCESS_KEY: "test-ak",
  JLC_OPENAPI_SECRET_KEY: "test-sk",
  JLC_OPENAPI_ENDPOINT: "https://api.example.com",
  JLC_OPENAPI_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "jlc-invoke-cache-")),
} as NodeJS.ProcessEnv;

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = 1_700_000_000;
const NONCE = "N".repeat(32);

interface Capture {
  url: string;
  init: RequestInit;
}

function collector(): { out: string[]; err: string[]; streams: { stdout: any; stderr: any } } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: { write: (chunk: string) => (out.push(chunk), true) },
      stderr: { write: (chunk: string) => (err.push(chunk), true) },
    },
  };
}

function mockFetch(
  capture: Capture[],
  body: string,
  status = 200,
): FetchLike {
  return async (url, init) => {
    capture.push({ url, init });
    const response: ResponseLike = { status, text: async () => body };
    return response as Response;
  };
}

const ARGS = [
  "/pcb/order/getOrderPageList",
  "--orderType",
  "examples",
  "--produceCode",
  "Y50504",
  "--orderByFlag",
  "true",
  "--orderDateBegin",
  "2026-11-11 00:00:00",
  "--orderDateEnd",
  "2026-11-16 18:00:00",
  "--pageSize",
  "10",
  "--pageNum",
  "1",
  "--queryFilterFlag",
  "true",
];

test("请求 URL、body 与签名正确", async () => {
  const capture: Capture[] = [];
  const { streams, out, err } = collector();
  const flags = parseArgs(ARGS).flags;

  const code = await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, JSON.stringify({ code: 200, data: { list: [] } })),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  assert.equal(code, 0);
  assert.equal(capture.length, 1);
  const request = capture[0]!;
  assert.equal(request.url, "https://api.example.com/pcb/order/getOrderPageList");
  assert.equal(request.init.method, "POST");

  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Accept, "application/json");

  const body = request.init.body as string;
  assert.deepEqual(JSON.parse(body), {
    orderType: "examples",
    produceCode: "Y50504",
    orderByFlag: true,
    orderDateBegin: "2026-11-11 00:00:00",
    orderDateEnd: "2026-11-16 18:00:00",
    pageSize: 10,
    pageNum: 1,
    queryFilterFlag: true,
  });

  // 用实际发送的 body 反算签名，必须与 Authorization 中的签名一致。
  const signature = /signature="([^"]+)"/.exec(headers.Authorization as string)?.[1];
  assert.ok(signature);
  const stringToSign =
    `POST\n/pcb/order/getOrderPageList\n${NOW_SECONDS}\n${NONCE}\n${body}\n`;
  assert.equal(computeSignature("test-sk", stringToSign), signature);

  assert.equal(err.join(""), "");
  assert.ok(out.join("").includes('"code": 200'));
});

test("业务失败返回退出码 1，仍输出服务端响应", async () => {
  const capture: Capture[] = [];
  const { streams, out, err } = collector();
  const flags = parseArgs(ARGS).flags;

  const code = await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, JSON.stringify({ code: 1000, message: "签名错误" })),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  assert.equal(code, 1);
  assert.ok(out.join("").includes('"message": "签名错误"'));
  assert.ok(err.join("").includes("code=1000"));
});

test("HTTP 非 2xx 抛出网络错误", async () => {
  const capture: Capture[] = [];
  const { streams } = collector();
  const flags = parseArgs(ARGS).flags;

  await assert.rejects(
    runInvoke("/pcb/order/getOrderPageList", flags, {
      env: ENV,
      fetchImpl: mockFetch(capture, "server down", 502),
      now: () => NOW_MS,
      nonce: NONCE,
      ...streams,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 3,
  );
});

test("大整数响应逐位保留", async () => {
  const capture: Capture[] = [];
  const { streams, out } = collector();
  const flags = parseArgs(ARGS).flags;

  const body = '{"code":200,"data":{"list":[{"customerOrderId":1234567890123456789}]}}';
  const code = await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, body),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  assert.equal(code, 0);
  assert.ok(out.join("").includes("1234567890123456789"));
});

test("--json 直接指定 body 并使用原文签名", async () => {
  const capture: Capture[] = [];
  const { streams } = collector();
  const raw = '{ "orderType" : "examples", "pageNum": 1 }';
  const flags = parseArgs([
    "/pcb/order/getOrderPageList",
    "--json",
    raw,
  ]).flags;

  const code = await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, JSON.stringify({ code: 200 })),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  assert.equal(code, 0);
  assert.equal(capture[0]!.init.body, raw);
});

test("--json 与逐字段参数互斥", async () => {
  const capture: Capture[] = [];
  const { streams } = collector();
  const flags = parseArgs([
    "/pcb/order/getOrderPageList",
    "--json",
    "{}",
    "--orderType",
    "examples",
  ]).flags;

  await assert.rejects(
    runInvoke("/pcb/order/getOrderPageList", flags, {
      env: ENV,
      fetchImpl: mockFetch(capture, "{}"),
      ...streams,
    }),
    /不能与逐字段参数同时使用/,
  );
});

test("--endpoint 覆盖配置", async () => {
  const capture: Capture[] = [];
  const { streams } = collector();
  const flags = parseArgs([...ARGS, "--endpoint", "https://override.example.com"]).flags;

  await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, JSON.stringify({ code: 200 })),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  assert.equal(capture[0]!.url, "https://override.example.com/pcb/order/getOrderPageList");
});

test("未传可选字段时 body 中不出现 null", async () => {
  const capture: Capture[] = [];
  const { streams } = collector();
  const flags = parseArgs([
    "/pcb/order/getOrderPageList",
    "--orderType",
    "batch",
    "--orderDateBegin",
    "2026-11-11 00:00:00",
    "--orderDateEnd",
    "2026-11-16 18:00:00",
    "--pageSize",
    "5",
    "--pageNum",
    "2",
  ]).flags;

  await runInvoke("/pcb/order/getOrderPageList", flags, {
    env: ENV,
    fetchImpl: mockFetch(capture, JSON.stringify({ code: 200 })),
    now: () => NOW_MS,
    nonce: NONCE,
    ...streams,
  });

  const body = capture[0]!.init.body as string;
  assert.equal(body.includes("null"), false);
  assert.deepEqual(Object.keys(JSON.parse(body)), [
    "orderType",
    "orderDateBegin",
    "orderDateEnd",
    "pageSize",
    "pageNum",
  ]);
});
