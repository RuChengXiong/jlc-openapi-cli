import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractFormatError,
  flattenInput,
  mapCatalog,
  mapDetail,
  mapServerType,
  mergeRemoteEndpoint,
  validateCatalog,
  validateDetail,
  type RemoteDetail,
} from "../src/contracts";
import type { EndpointDef } from "../src/types";

test("catalog 映射为接口摘要并按路径去重", () => {
  const endpoints = mapCatalog([
    {
      businessTypeCode: "PCB",
      businessTypeName: "PCB业务",
      apis: [
        { apiUri: "/pcb/order/create", apiName: "创建订单", apiDescn: "创建 PCB 订单" },
        { apiUri: "/pcb/order/create", apiName: "重复" },
      ],
    },
    {
      businessTypeName: "嘉立创云ERP",
      apis: [{ apiUri: "/open/api/saas/erp/projectTask/page", apiName: "分页查询项目任务" }],
    },
  ]);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0]!.path, "/pcb/order/create");
  assert.equal(endpoints[0]!.category, "PCB业务");
  assert.equal(endpoints[0]!.method, "POST");
  assert.equal(endpoints[1]!.category, "嘉立创云ERP");
});

test("detail 递归拍平嵌套对象、对象数组和文件字段", () => {
  const detail: RemoteDetail = {
    apiUri: "/3dp-open/order/submitOrder",
    apiName: "提交订单",
    businessTypeName: "3DP业务",
    method: "POST",
    contentType: "json",
    input: [
      {
        name: "orderTechnical",
        type: "Object",
        required: true,
        desc: "订单工艺",
        children: [{ name: "plateType", type: "Integer", required: true, desc: "板材类型" }],
      },
      {
        name: "modelPriceParamList",
        type: "List<ModelPriceParam>",
        required: true,
        desc: "商品集合",
        items: {
          type: "Object",
          children: [
            { name: "modelAccessId", type: "String", required: true, desc: "模型 id" },
            {
              name: "surfaceTreatmentList",
              type: "List<SurfaceTreatment>",
              items: {
                type: "Object",
                children: [{ name: "craftCode", type: "String", required: true }],
              },
            },
          ],
        },
      },
      { name: "file", type: "MultipartFile", required: true, desc: "模型文件" },
    ],
    output: [{ name: "orderId", type: "Long", desc: "订单 id" }],
    errorCode: [{ name: "200", type: "Integer", required: true, desc: "成功" }],
    agentGuidance: "写操作，先确认参数。",
  };

  const endpoint = mapDetail(detail, { apiUri: detail.apiUri });
  const paths = endpoint.fields.map((field) => field.path);
  assert.ok(paths.includes("orderTechnical"));
  assert.ok(paths.includes("orderTechnical.plateType"));
  assert.ok(paths.includes("modelPriceParamList"));
  assert.ok(paths.includes("modelPriceParamList.modelAccessId"));
  assert.ok(paths.includes("modelPriceParamList.surfaceTreatmentList"));
  assert.ok(paths.includes("modelPriceParamList.surfaceTreatmentList.craftCode"));
  assert.equal(endpoint.contentType, "multipart");
  assert.deepEqual(endpoint.fileFields, ["file"]);
  assert.equal(endpoint.agentGuidance, "写操作，先确认参数。");
  assert.equal(endpoint.outputFields?.[0]?.path, "orderId");
  assert.equal(endpoint.errorCodes?.[0]?.name, "200");

  const parent = endpoint.fields.find((field) => field.path === "modelPriceParamList");
  assert.equal(parent?.type, "array");
  assert.equal(parent?.items, "object");
});

test("旧版平铺字段名带点号时按完整路径处理", () => {
  const fields = flattenInput([
    { name: "orderTechnical.plateType", type: "String", required: "true" },
    { name: "pageNum", type: "Integer" },
  ]);
  assert.deepEqual(
    fields.map((field) => field.path),
    ["orderTechnical.plateType", "pageNum"],
  );
  assert.equal(fields[0]!.required, true);
});

test("Java 类型映射", () => {
  assert.deepEqual(mapServerType("java.util.List<java.lang.String>"), {
    type: "array",
    items: "string",
  });
  assert.deepEqual(mapServerType("List<ModelPriceParam>"), { type: "array", items: "object" });
  assert.deepEqual(mapServerType("BigDecimal"), { type: "number" });
  assert.deepEqual(mapServerType("LocalDateTime"), { type: "string", format: "datetime" });
  assert.deepEqual(mapServerType("MultipartFile"), { type: "file" });
  assert.deepEqual(mapServerType("int[]"), { type: "array", items: "integer" });
  assert.deepEqual(mapServerType("Map<String,Object>"), { type: "object" });
});

test("detail apiUri 不一致时拒绝", () => {
  assert.throws(
    () =>
      validateDetail(
        { apiUri: "/other", method: "POST", input: [] },
        "/expected",
      ),
    ContractFormatError,
  );
});

test("GET 与 multipart 同时出现时拒绝", () => {
  assert.throws(
    () =>
      validateDetail(
        {
          apiUri: "/x",
          method: "GET",
          contentType: "multipart",
          input: [{ name: "file", type: "MultipartFile" }],
        },
        "/x",
      ),
    ContractFormatError,
  );
});

test("catalog 顶层不是数组时拒绝", () => {
  assert.throws(() => validateCatalog({}), ContractFormatError);
  assert.deepEqual(validateCatalog([]), []);
});

test("远程契约合并保留签名相关元数据，并允许字段更新", () => {
  const bundled: EndpointDef = {
    path: "/x",
    method: "POST",
    title: "内置标题",
    category: "PCB业务",
    description: "内置描述",
    contentType: "multipart",
    fileFields: ["file"],
    strict: true,
    legacy: true,
    fields: [
      { path: "meta", type: "string", required: false, description: "meta" },
      { path: "oldField", type: "string", required: false, description: "旧字段" },
    ],
    example: "jlc-openapi-cli /x",
  };

  const remote = mapDetail(
    {
      apiUri: "/x",
      method: "GET",
      contentType: "json",
      input: [
        { name: "oldField", type: "Integer", required: true, desc: "新类型" },
        { name: "newField", type: "String", desc: "新字段" },
      ],
      output: [{ name: "ok", type: "Boolean" }],
      agentGuidance: "远程指引",
    },
    { apiUri: "/x", bundled },
  );

  const merged = mergeRemoteEndpoint(remote, bundled, (endpoint) => ({
    ...endpoint,
    fields: [
      ...endpoint.fields,
      { path: "overrideField", type: "string", required: false, description: "override" },
    ],
  }));

  assert.equal(merged.method, "POST");
  assert.equal(merged.contentType, "multipart");
  assert.deepEqual(merged.fileFields, ["file"]);
  assert.equal(merged.strict, true);
  assert.equal(merged.legacy, true);
  assert.equal(merged.title, "内置标题");
  assert.equal(merged.fields.find((field) => field.path === "oldField")?.type, "integer");
  assert.ok(merged.fields.some((field) => field.path === "meta"));
  assert.ok(merged.fields.some((field) => field.path === "newField"));
  assert.ok(merged.fields.some((field) => field.path === "overrideField"));
  assert.equal(merged.agentGuidance, "远程指引");
});
