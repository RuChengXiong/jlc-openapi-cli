import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getCachedDetail,
  getCatalog,
  getDetail,
} from "../src/contract-client";
import {
  catalogCacheKey,
  emptyContractCache,
  setCacheEntry,
  writeContractCache,
} from "../src/contract-cache";
import type { FetchLike, ResponseLike } from "../src/http";
import { CliError } from "../src/output";

const ENDPOINT = "https://api.example.com";
const CONFIG = { appId: "app", ak: "ak", endpoint: ENDPOINT };
const NOW = 1_700_000_000_000;

const CATALOG = [
  {
    businessTypeCode: "PCB",
    businessTypeName: "PCB业务",
    apis: [
      { apiUri: "/pcb/order/create", apiName: "创建订单", apiDescn: "创建 PCB 订单" },
    ],
  },
];

const DETAIL = {
  apiUri: "/remote/newEndpoint",
  apiName: "新接口",
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

function tempCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-contract-client-"));
  return path.join(dir, "contracts-cache.json");
}

function response(status: number, body: unknown): ResponseLike {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function mockFetch(
  handler: (url: string, init: RequestInit) => ResponseLike | Promise<ResponseLike>,
): { fetchImpl: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

test("getCatalog 请求 /list，成功写缓存并使用服务端结果", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));

  const result = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW,
  });

  assert.equal(result.source, "server");
  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0]!.path, "/pcb/order/create");
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.url, `${ENDPOINT}/list`);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body as string), { appId: "app", ak: "ak" });
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["Content-Type"], "application/json");

  // 第二次应命中缓存，不再请求。
  const second = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW + 1000,
  });
  assert.equal(second.source, "cache");
  assert.equal(calls.length, 1);
});

test("--refresh 跳过新鲜缓存", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));
  await getCatalog({ config: CONFIG, cachePath, fetchImpl, now: () => NOW });
  const refreshed = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW + 1000,
    refresh: true,
  });
  assert.equal(refreshed.source, "server");
  assert.equal(calls.length, 2);
});

test("服务端失败时回退过期缓存", async () => {
  const cachePath = tempCachePath();
  const cache = emptyContractCache();
  setCacheEntry(cache, catalogCacheKey(ENDPOINT, "app", "ak"), CATALOG, NOW - 7 * 60 * 60 * 1000);
  writeContractCache(cache, { cachePath });

  const { fetchImpl } = mockFetch(() => response(500, "down"));
  const result = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.source, "stale-cache");
  assert.equal(result.stale, true);
  assert.ok(result.warning?.includes("500"));
});

test("服务端失败且无缓存时回退内置", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl } = mockFetch(() => response(500, "down"));
  const result = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.source, "bundled");
  assert.equal(result.endpoints.length, 111);
});

test("--builtin 和 --offline 不访问网络", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));

  const builtin = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    builtin: true,
  });
  assert.equal(builtin.source, "bundled");
  assert.equal(calls.length, 0);

  const offline = await getCatalog({
    config: CONFIG,
    cachePath,
    fetchImpl,
    offline: true,
  });
  assert.equal(offline.source, "bundled");
  assert.equal(calls.length, 0);
});

test("没有 appId/ak 时目录降级到内置", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, CATALOG));
  const result = await getCatalog({
    config: { endpoint: ENDPOINT },
    cachePath,
    fetchImpl,
  });
  assert.equal(result.source, "bundled");
  assert.ok(result.warning?.includes("appId/ak"));
  assert.equal(calls.length, 0);
});

test("--refresh 没有 appId/ak 时报配置错误", async () => {
  const cachePath = tempCachePath();
  await assert.rejects(
    getCatalog({
      config: { endpoint: ENDPOINT },
      cachePath,
      refresh: true,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 2,
  );
});

test("--refresh 与 --offline 互斥", async () => {
  await assert.rejects(
    getCatalog({ config: CONFIG, refresh: true, offline: true }),
    /不能同时使用/,
  );
});

test("getDetail 请求 /detail 并映射嵌套字段与 agentGuidance", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, DETAIL));

  const result = await getDetail("/remote/newEndpoint", {
    config: CONFIG,
    cachePath,
    fetchImpl,
    now: () => NOW,
  });

  assert.equal(result.source, "server");
  assert.equal(result.endpoint.path, "/remote/newEndpoint");
  assert.equal(result.endpoint.agentGuidance, "先确认订单状态。");
  assert.ok(result.endpoint.fields.some((field) => field.path === "items.code"));
  assert.equal(result.endpoint.errorCodes?.[0]?.name, "200");
  assert.equal(calls[0]!.url, `${ENDPOINT}/detail`);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    apiUri: "/remote/newEndpoint",
  });
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined);

  const cached = getCachedDetail("/remote/newEndpoint", {
    config: CONFIG,
    cachePath,
    now: () => NOW + 1000,
  });
  assert.ok(cached);
  assert.equal(cached?.source, "cache");
});

test("getDetail 的 apiUri 不一致时拒绝，且无内置兜底时报网络错误", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl } = mockFetch(() =>
    response(200, { ...DETAIL, apiUri: "/other" }),
  );
  await assert.rejects(
    getDetail("/remote/newEndpoint", {
      config: CONFIG,
      cachePath,
      fetchImpl,
      now: () => NOW,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 3,
  );
});

test("getDetail 没有 appId/ak 也能工作", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl, calls } = mockFetch(() => response(200, DETAIL));
  const result = await getDetail("/remote/newEndpoint", {
    config: { endpoint: ENDPOINT },
    cachePath,
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.source, "server");
  assert.equal(calls.length, 1);
});

test("getDetail 404 且无内置契约时给出用法错误", async () => {
  const cachePath = tempCachePath();
  const { fetchImpl } = mockFetch(() => response(404, "not found"));
  await assert.rejects(
    getDetail("/remote/missing", {
      config: CONFIG,
      cachePath,
      fetchImpl,
      now: () => NOW,
    }),
    (error: unknown) => error instanceof CliError && error.exitCode === 2,
  );
});
