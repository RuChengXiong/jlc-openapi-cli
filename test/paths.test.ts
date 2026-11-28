import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApiPath, splitApiPath, stripMsysPrefix } from "../src/paths";

test("普通接口路径保持不变", () => {
  assert.equal(stripMsysPrefix("/pcb/order/create"), "/pcb/order/create");
  assert.deepEqual(normalizeApiPath("/pcb/order/create"), {
    path: "/pcb/order/create",
    query: "",
    rewritten: false,
  });
});

test("剥离 Git Bash 的 C:/Program Files/Git 前缀", () => {
  assert.equal(
    stripMsysPrefix("C:/Program Files/Git/pcb/order/create"),
    "/pcb/order/create",
  );
  assert.equal(
    stripMsysPrefix("C:\\Program Files\\Git\\pcb\\order\\create"),
    "/pcb/order/create",
  );
  assert.equal(
    stripMsysPrefix("/c/Program Files/Git/pcb/order/create"),
    "/pcb/order/create",
  );
});

test("MSYS 的 // 转义折叠为单斜杠", () => {
  assert.equal(stripMsysPrefix("//pcb/order/create"), "/pcb/order/create");
});

test("先拆 query，再归一化路径", () => {
  assert.deepEqual(splitApiPath("/pcb/order/create?orderType=examples&pageSize=10"), {
    path: "/pcb/order/create",
    query: "orderType=examples&pageSize=10",
  });
  assert.deepEqual(
    normalizeApiPath("C:/Program Files/Git/pcb/order/create?x=1"),
    {
      path: "/pcb/order/create",
      query: "x=1",
      rewritten: true,
    },
  );
});

test("未知的 Windows 绝对路径用已知接口后缀匹配", () => {
  assert.deepEqual(
    normalizeApiPath("C:/Users/demo/Git/pcb/order/create", {
      knownPaths: ["/pcb/order/create", "/pcb/order/getList"],
    }),
    {
      path: "/pcb/order/create",
      query: "",
      rewritten: true,
    },
  );
});

test("无法匹配的路径只保证以 / 开头", () => {
  const result = normalizeApiPath("C:/temp/new/endpoint");
  assert.equal(result.path, "/C:/temp/new/endpoint");
  assert.equal(result.rewritten, true);
});

test("不进行 URL 解码，保留签名拼写", () => {
  assert.equal(
    normalizeApiPath("/pcb/order/getList?orderIds=1%2C2").query,
    "orderIds=1%2C2",
  );
  assert.equal(normalizeApiPath("/lcsc/openapi/product/search/global").path, "/lcsc/openapi/product/search/global");
});
