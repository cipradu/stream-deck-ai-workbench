import { Schema } from "effect";

import {
  METRIC_KIND_DIRECTION,
  METRIC_KIND_UNIT,
  type BalanceMetricKind,
  type BalanceProviderId,
  type CoverageKind,
  type MetricSnapshot,
} from "@ai-workbench/contracts";
import type { SanitizedFailure } from "@ai-workbench/errors";
import { findProviderEntry, type ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import { parseUnknown } from "@ai-workbench/validation";

import { semanticValidationFailure, unsupportedNormalizationFailure } from "./provider-failures.js";
import type {
  BalanceProviderNormalizationResult,
  NormalizeBalanceProviderResponseInput,
} from "./types.js";

export const NumberOrStringSchema = Schema.Union(Schema.Number, Schema.String);

export function parseBalanceResponse<Value, Encoded>(
  schema: Schema.Schema<Value, Encoded, never>,
  input: NormalizeBalanceProviderResponseInput,
  reasonCode: string,
):
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    } {
  return parseUnknown(schema, input.response, {
    boundary: `provider-adapters-balance-${input.providerId}`,
    reasonCode,
    fieldPaths: ["<redacted-provider-field>"],
  });
}

/**
 * Optional renderer-safe snapshot extras carried over from the old working
 * plugin's balance snapshots: a vendor-reported period reset, the end of the
 * covered data window for lagged spend sources, and the count of additional
 * currency entries beyond the prominent first one. All identifier-free.
 */
export interface BalanceSnapshotExtras {
  readonly resetsAtEpochMs?: number;
  readonly dataThroughEpochMs?: number;
  readonly extraCurrencies?: number;
}

export function balanceSnapshotResult(
  input: NormalizeBalanceProviderResponseInput,
  value: number,
  currencyCode?: string,
  extras?: BalanceSnapshotExtras,
): BalanceProviderNormalizationResult {
  if (!Number.isFinite(value)) {
    return semanticValidationFailure(input.providerId, `balance-${input.providerId}-numeric-value-invalid`);
  }

  const capability = balanceCapabilityForProvider(input.providerId);
  if (capability === undefined) {
    return unsupportedNormalizationFailure("balance-provider-not-found");
  }

  const metricKind = capability.metricKind as BalanceMetricKind;
  if (capability.coverageKind === "rolling-window") {
    return semanticValidationFailure(input.providerId, "balance-rolling-window-coverage-unsupported");
  }

  return {
    ok: true,
    snapshot: {
      familyId: "balance",
      providerId: input.providerId,
      metricKind,
      metricDirection: METRIC_KIND_DIRECTION[metricKind],
      unit: METRIC_KIND_UNIT[metricKind],
      coverage: coverageFromKind(capability.coverageKind),
      value,
      fetchedAtEpochMs: input.fetchedAtEpochMs,
      ...(isPositiveFinite(extras?.resetsAtEpochMs) ? { resetsAtEpochMs: extras.resetsAtEpochMs } : {}),
      ...(isPositiveFinite(extras?.dataThroughEpochMs) ? { dataThroughEpochMs: extras.dataThroughEpochMs } : {}),
      ...(extras?.extraCurrencies !== undefined && extras.extraCurrencies > 0 ? { extraCurrencies: extras.extraCurrencies } : {}),
    },
    ...(currencyCode === undefined ? {} : { currencyCode: normalizeCurrencyCode(currencyCode) }),
  };
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function numberFromProviderValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.NaN;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function hasNonEmptyPageToken(nextPage: string | null | undefined): boolean {
  return nextPage !== null && nextPage !== undefined && nextPage.length > 0;
}

/**
 * Single source for "first day of the current UTC calendar month", derived from a
 * scheduler-seam epoch (e.g. a fetch cycle's `fetchedAtEpochMs`). Callers format it as
 * they need: epoch ms (`monthStartEpochMs`), epoch seconds (`monthStartEpochMs(...) / 1000`),
 * `YYYY-MM-DD` (`monthStartDateString`), or a full ISO string. `Date.UTC(year, month, 1)`
 * fixes the instant to 00:00:00.000 UTC on the first of that month.
 */
export function monthStartEpochMs(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function monthStartDateString(epochMs: number): string {
  return new Date(monthStartEpochMs(epochMs)).toISOString().slice(0, 10);
}

function balanceCapabilityForProvider(providerId: BalanceProviderId): ProviderCapabilityMetadata | undefined {
  return findProviderEntry(providerId)?.capabilities.find((capability) => capability.actionFamilyId === "balance");
}

function coverageFromKind(coverageKind: Exclude<CoverageKind, "rolling-window">): MetricSnapshot["coverage"] {
  switch (coverageKind) {
    case "evergreen":
      return { kind: "evergreen" };
    case "month-to-date":
      return { kind: "month-to-date" };
    case "current-period":
      return { kind: "current-period" };
  }
}

function normalizeCurrencyCode(currencyCode: string): string {
  return currencyCode.toUpperCase();
}
