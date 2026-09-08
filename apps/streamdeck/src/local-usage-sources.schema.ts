import { Schema } from "effect";

const RefreshTokenSchema = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0 && !value.includes("\0")),
);
const ScopeSchema = Schema.String.pipe(Schema.filter((value) => value.length > 0 && !/[\s\0]/.test(value)));

export const ClaudeCodeRefreshPayloadSchema = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    refreshToken: Schema.Redacted(RefreshTokenSchema),
    scopes: Schema.NonEmptyArray(ScopeSchema),
    expiresAt: Schema.optional(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
  }),
});
