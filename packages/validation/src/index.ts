import { Either, Schema } from "effect";

import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";

export const packageName = "@ai-workbench/validation" as const;

export interface ParseUnknownOptions {
  readonly boundary: string;
  readonly reasonCode: string;
  readonly fieldPaths?: readonly string[];
}

export type ParseUnknownResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };

export function parseUnknown<Value, Encoded>(
  schema: Schema.Schema<Value, Encoded, never>,
  input: unknown,
  options: ParseUnknownOptions,
): ParseUnknownResult<Value> {
  const result = Schema.decodeUnknownEither(schema)(input);

  if (Either.isRight(result)) {
    return {
      ok: true,
      value: result.right,
    };
  }

  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "validation-drift",
      diagnostics: {
        boundary: options.boundary,
        fieldPaths: options.fieldPaths ?? ["<redacted-field>"],
        issueCount: 1,
        reasonCode: options.reasonCode,
      },
      cause: result.left,
    }),
  };
}
