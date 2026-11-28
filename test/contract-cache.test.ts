import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_TTL_MS,
  catalogCacheKey,
  detailCacheKey,
  emptyContractCache,
  getCacheEntry,
  pruneContractCache,
  readContractCache,
  setCacheEntry,
  writeContractCache,
} from "../src/contract-cache";

function tempCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-contract-cache-"));
  return path.join(dir, "contracts-cache.json");
}

test("catalog 缓存键区分 endpoint/appId/ak", () => {
  const base = catalogCacheKey("https://api.example.com", "app1", "ak1");
  assert.notEqual(base, catalogCacheKey("https://api.example.com", "app1", "ak2"));
  assert.notEqual(base, catalogCacheKey("https://api.example.com", "app2", "ak1"));
  assert.notEqual(base, catalogCacheKey("https://staging.example.com", "app1", "ak1"));
  // 尾部斜杠和大小写归一化后应相同。
  assert.equal(
    base,
    catalogCacheKey("HTTPS://API.EXAMPLE.COM/", "app1", "ak1"),
  );
});

test("detail 缓存键包含 endpoint", () => {
  assert.notEqual(
    detailCacheKey("https://api.example.com", "/pcb/order/create"),
    detailCacheKey("https://staging.example.com", "/pcb/order/create"),
  );
});

test("缓存读写与 TTL 边界", () => {
  const cachePath = tempCachePath();
  const now = 1_700_000_000_000;
  const cache = emptyContractCache();
  setCacheEntry(cache, "detail:one", { ok: true }, now);
  writeContractCache(cache, { cachePath });

  const loaded = readContractCache({ cachePath });
  assert.deepEqual(loaded.entries["detail:one"], { fetchedAt: now, data: { ok: true } });

  assert.equal(getCacheEntry(loaded, "detail:one", now + 1).state, "fresh");
  assert.equal(
    getCacheEntry(loaded, "detail:one", now + CONTRACT_TTL_MS - 1).state,
    "fresh",
  );
  assert.equal(
    getCacheEntry(loaded, "detail:one", now + CONTRACT_TTL_MS).state,
    "stale",
  );
  assert.equal(getCacheEntry(loaded, "detail:missing", now).state, "miss");
});

test("损坏或版本不符的缓存视为空", () => {
  const cachePath = tempCachePath();
  fs.writeFileSync(cachePath, "{not-json", "utf8");
  assert.deepEqual(readContractCache({ cachePath }), emptyContractCache());

  fs.writeFileSync(cachePath, JSON.stringify({ version: 99, entries: {} }), "utf8");
  assert.deepEqual(readContractCache({ cachePath }), emptyContractCache());

  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  assert.deepEqual(readContractCache({ cachePath }), emptyContractCache());
});

test("目录刷新可以删除不再出现的 detail", () => {
  const cache = emptyContractCache();
  setCacheEntry(cache, "detail:keep", { ok: 1 }, 1);
  setCacheEntry(cache, "detail:drop", { ok: 2 }, 2);
  pruneContractCache(cache, { allowedDetailKeys: new Set(["detail:keep"]) });
  assert.ok(cache.entries["detail:keep"]);
  assert.equal(cache.entries["detail:drop"], undefined);
});

test("detail 超过 500 条时淘汰最旧", () => {
  const cache = emptyContractCache();
  for (let i = 0; i < 505; i += 1) {
    setCacheEntry(cache, `detail:${i}`, { i }, i);
  }
  pruneContractCache(cache);
  const keys = Object.keys(cache.entries).filter((key) => key.startsWith("detail:"));
  assert.equal(keys.length, 500);
  assert.equal(cache.entries["detail:0"], undefined);
  assert.ok(cache.entries["detail:504"]);
});
