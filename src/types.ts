/** 接口与字段的公共类型定义。生成器与运行时共用。 */

export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "file"
  | "unknown";

export interface FieldDef {
  /** 请求 body 中的完整点号路径，例如 `orderTechnical.plateType`。 */
  path: string;
  type: FieldType;
  required: boolean;
  description: string;
  enum?: string[];
  /** array 字段的元素类型。 */
  items?: FieldType;
  min?: number;
  max?: number;
  format?: "datetime" | "date";
  example?: string;
  confidence?: "high" | "low";
}

export interface ErrorCodeDef {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface EndpointDef {
  path: string;
  method: "POST" | "GET";
  title: string;
  category: string;
  description: string;
  contentType: "json" | "multipart";
  /** multipart 接口中需要上传的文件字段名。 */
  fileFields?: string[];
  fields: FieldDef[];
  /** 仅人工校对过的接口为 true，启用必填与未知参数校验。 */
  strict: boolean;
  /** 兼容保留、不在当前接口文档中的接口。 */
  legacy?: boolean;
  /** api-docs 下的相对路径，或服务端契约来源。 */
  source?: string;
  example?: string;
  /** 服务端契约附带的 agent 使用指引。 */
  agentGuidance?: string;
  inputExample?: unknown;
  outputExample?: unknown;
  /** 响应字段，仅用于展示，绝不参与请求必填校验。 */
  outputFields?: FieldDef[];
  errorCodes?: ErrorCodeDef[];
  contractSource?: "server" | "cache" | "stale-cache" | "bundled";
}
