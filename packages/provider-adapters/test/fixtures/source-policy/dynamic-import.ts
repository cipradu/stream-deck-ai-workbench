export async function bypass() {
  const http = await import("@ai-workbench/http");
  return http.requestJsonSchema;
}
