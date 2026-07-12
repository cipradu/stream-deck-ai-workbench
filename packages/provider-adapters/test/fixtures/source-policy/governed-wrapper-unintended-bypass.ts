import { executeRequest, requestJsonSchema, requestTextBody } from "@ai-workbench/http";

export function governedRequestJsonSchema() {
  return requestJsonSchema;
}

export function governedRequestTextBody() {
  return requestTextBody;
}

export function governedExecuteRequest() {
  return executeRequest;
}

export function unintendedSourcePolicyBypass() {
  return requestJsonSchema;
}
