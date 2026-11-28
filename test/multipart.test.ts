import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../src/args";
import { runInvoke } from "../src/commands/invoke";
import { getEndpoint } from "../src/endpoints";
import type { FetchLike, ResponseLike } from "../src/http";
import { buildPayload } from "../src/payload";
import { computeSignature } from "../src/sign";

const ENV = {
  JLC_OPENAPI_APP_ID: "test-app",
  JLC_OPENAPI_ACCESS_KEY: "test-ak",
  JLC_OPENAPI_SECRET_KEY: "test-sk",
  JLC_OPENAPI_ENDPOINT: "https://api.example.com",
  JLC_OPENAPI_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "jlc-multipart-cache-")),
} as NodeJS.ProcessEnv;

function tempFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jlc-multipart-"));
  const file = path.join(dir, "model.stl");
  fs.writeFileSync(file, "solid test\nendsolid test\n");
  return { dir, file };
}

function collector(): { out: string[]; err: string[]; stdout: any; stderr: any } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (chunk: string) => (out.push(chunk), true) },
    stderr: { write: (chunk: string) => (err.push(chunk), true) },
  };
}

test("3DP 上传：meta 作为签名体", () => {
  const endpoint = getEndpoint("/3dp-open/order/uploadModelFile");
  assert.ok(endpoint);
  const { dir, file } = tempFile();
  try {
    const { payload, fileValues, signBody } = buildPayload(
      endpoint,
      { file, meta: '{"traceId":"abc"}' },
      { strict: false },
    );
    assert.equal(fileValues.file, file);
    assert.equal(signBody, '{"traceId":"abc"}');
    assert.equal(payload.meta, '{"traceId":"abc"}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3DP 上传未传 meta 时默认 {}", () => {
  const endpoint = getEndpoint("/3dp-open/order/uploadModelFile");
  assert.ok(endpoint);
  const { dir, file } = tempFile();
  try {
    const { signBody, payload } = buildPayload(endpoint, { file }, { strict: false });
    assert.equal(signBody, "{}");
    assert.equal(payload.meta, "{}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multipart 请求发送 FormData 且不手写 Content-Type", async () => {
  const endpoint = getEndpoint("/3dp-open/order/uploadModelFile");
  assert.ok(endpoint);
  const { dir, file } = tempFile();
  const capture: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    capture.push({ url, init });
    const response: ResponseLike = {
      status: 200,
      text: async () => JSON.stringify({ code: 200, data: { modelAccessId: "m1" } }),
    };
    return response as Response;
  };

  const flags = parseArgs([
    "/3dp-open/order/uploadModelFile",
    "--file",
    file,
    "--meta",
    '{"traceId":"abc"}',
  ]).flags;
  const { stdout, stderr, err } = collector();

  try {
    const code = await runInvoke("/3dp-open/order/uploadModelFile", flags, {
      env: ENV,
      cwd: dir,
      fetchImpl,
      now: () => 1_700_000_000_000,
      nonce: "N".repeat(32),
      stdout,
      stderr,
    });
    assert.equal(code, 0);
    assert.equal(err.join(""), "");

    const request = capture[0]!;
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], undefined);
    assert.ok(headers.Authorization);
    assert.ok(request.init.body instanceof FormData);

    const form = request.init.body as FormData;
    assert.equal(form.get("meta"), '{"traceId":"abc"}');
    assert.ok(form.get("file"));

    const signature = /signature="([^"]+)"/.exec(headers.Authorization)?.[1];
    assert.ok(signature);
    const stringToSign = `POST\n/3dp-open/order/uploadModelFile\n1700000000\n${"N".repeat(32)}\n{"traceId":"abc"}\n`;
    assert.equal(computeSignature("test-sk", stringToSign), signature);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
