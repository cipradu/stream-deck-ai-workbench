// @ts-expect-error Deferred imports are parser-supported but not emit-supported by NodeNext.
import defer * as http from "@ai-workbench/http";

export const deferredNamespace = http;
