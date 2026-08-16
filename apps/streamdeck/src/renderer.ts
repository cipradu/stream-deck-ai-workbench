import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DisplayRendererInput, MetricDisplayRendererInput, StatusValueRendererInput } from "@ai-workbench/display";
import type { SanitizedFailure } from "@ai-workbench/errors";

import { prepareLogoSvg, type PreparedLogo } from "./logo-loader.js";

/**
 * SVG key renderer, ported from the old working plugin's key layouts: header
 * lockup with an optional provider logo, big severity-colored value, dim
 * context row, percent-used gauge for usage keys, reset countdown / coverage
 * markers, stale-age badge, and last-checked clock. Pure with respect to the
 * display input and the injected clock; renders always come from cached
 * scheduler output and never fetch.
 */

export interface RenderedKey {
  readonly image: string;
}

const SIZE = 144;
const GAUGE_X = 16;
const GAUGE_TRACK_WIDTH = 112;

const keyColors = {
  background: "#1a1d21",
  text: "#e8e8e8",
  dim: "#9aa0a6",
  track: "#3a3f46",
  normal: "#2ecc71",
  informational: "#3498db",
  warning: "#f39c12",
  critical: "#e01e1e",
} as const;

const HEADER_FONT_SIZE = 15;
const HEADER_BASELINE_Y = 24;
const LOGO_SIZE = 16;
const LOGO_TEXT_GAP = 6;

const VALUE_MAX_WIDTH = 124;
const VALUE_MAX_PX = 40;
const VALUE_MIN_PX = 12;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function renderDisplayInput(input: DisplayRendererInput, now: number): RenderedKey {
  const header = headerLockup(input.headerLabel ?? "AI Workbench", logoForProvider(input.providerId));

  if (input.freshness === "degraded") {
    const degraded = degradedMessage(input);
    return { image: toDataUri(svgShell(header + centeredMessage(degraded.lines, degraded.color))) };
  }

  if (input.actionFamilyId === "status") {
    return { image: toDataUri(svgShell(header + statusBody(input, now))) };
  }

  // Usage PERCENT keys carry a bounded percentage (progressPercent) and use the gauge layout.
  // The Codex "credits" category is an absolute count with no bounded percentage, so it renders
  // through the balance-style body (severity-colored shrink-fit amount + dim unit row, no gauge),
  // exactly like a balance count key. Only usage-percent snapshots set progressPercent, so it is
  // the reliable signal for the gauge layout.
  const body = input.progressPercent !== undefined ? usageBody(input, now) : balanceBody(input, now);
  return { image: toDataUri(svgShell(header + body)) };
}

export function displayInputFromFailure(failure: SanitizedFailure): DisplayRendererInput {
  return {
    valueText: valueTextForDisplayState(failure.displayState),
    severity: "not-evaluated",
    displayState: failure.displayState,
    stale: false,
    rendererSeverityState: "normal",
    freshness: "degraded",
    failureContext: {
      category: failure.category,
      displayState: failure.displayState,
      retryClass: failure.retryClass,
      safePublicMessage: failure.safePublicMessage,
      reasonCode: failure.diagnostics.reasonCode,
      ...(failure.diagnostics.boundary === undefined ? {} : { boundary: failure.diagnostics.boundary }),
      ...(failure.diagnostics.httpStatusClass === undefined ? {} : { httpStatusClass: failure.diagnostics.httpStatusClass }),
      ...(failure.diagnostics.issueCount === undefined ? {} : { issueCount: failure.diagnostics.issueCount }),
      ...(failure.provider === undefined
        ? {}
        : {
            providerFailureClass: failure.provider.failureClass,
            providerReasonCode: failure.provider.reasonCode,
          }),
    },
  };
}

// ---------------------------------------------------------------------------
// Usage layout (old key-svg.ts): percent, mode label, gauge, reset line.
// ---------------------------------------------------------------------------

function usageBody(input: MetricDisplayRendererInput, now: number): string {
  const modeLabel = input.valueLabel === "remaining" ? "left" : "used";
  const color = severityColorFor(input);
  const expiredKimiRollingWindow = shouldDefaultExpiredKimiRollingWindow(input, now);
  const progress = expiredKimiRollingWindow ? 0 : clampPercent(input.progressPercent ?? 0);
  const fillWidth = ((GAUGE_TRACK_WIDTH * progress) / 100).toFixed(1);
  const valueText = expiredKimiRollingWindow ? (input.valueLabel === "remaining" ? "100%" : "0%") : input.valueText;

  const reset = formatTimeToReset(input.resetsAtEpochMs, now);
  const resetLine =
    reset.kind === "passed"
      ? `<text data-part="reset-line" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${keyColors.dim}">reset passed</text>`
      : reset.kind === "idle"
        ? `<text data-part="reset-line" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${keyColors.dim}">idle</text>`
        : `<text data-part="reset-line" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${keyColors.dim}">&#9203; ${escapeXml(reset.text)}</text>`;

  // The credit-spend gauge carries a dim "$used / $cap" secondary
  // line instead of a reset countdown; only that category sets secondaryLine, so the 5h/7d/fable
  // percentage keys keep their reset line unchanged.
  const bottomLine =
    input.secondaryLine !== undefined
      ? `<text data-part="secondary-line" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${keyColors.dim}">${escapeXml(input.secondaryLine)}</text>`
      : resetLine;

  return [
    staleTopRow(input, now),
    `<text data-part="key-value" x="72" y="76" text-anchor="middle" font-family="sans-serif" font-size="40" font-weight="bold" fill="${keyColors.text}">${escapeXml(valueText)}</text>`,
    `<text data-part="value-context" x="72" y="93" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${keyColors.dim}">${escapeXml(modeLabel)}</text>`,
    `<rect x="${GAUGE_X}" y="101" width="${GAUGE_TRACK_WIDTH}" height="10" rx="5" fill="${keyColors.track}"/>`,
    `<rect data-part="gauge-fill" x="${GAUGE_X}" y="101" width="${fillWidth}" height="10" rx="5" fill="${color}"/>`,
    bottomLine,
  ].join("");
}

function shouldDefaultExpiredKimiRollingWindow(input: MetricDisplayRendererInput, now: number): boolean {
  return (
    input.providerId === "kimi-code" &&
    (input.usageWindow === "five-hour" || input.usageWindow === "seven-day") &&
    input.freshness === "stale" &&
    input.staleReason === "refresh-failed" &&
    input.failureContext?.category === "no-data-yet" &&
    input.resetsAtEpochMs !== undefined &&
    now >= input.resetsAtEpochMs
  );
}

// ---------------------------------------------------------------------------
// Balance layout (old balance-key-svg.ts): shrink-fit amount, dim unit row,
// coverage/reset marker, last-checked clock.
// ---------------------------------------------------------------------------

function balanceBody(input: MetricDisplayRendererInput, now: number): string {
  const stale = input.freshness === "stale";
  // The credit-spend off/out-of-credits status keys route through
  // this non-gauge body and drive a NON-severity tone: neutral dim ("Off" / "Out") by default, or
  // critical red only when out-of-credits with auto-reload on — never the green "healthy" tone a
  // not-evaluated severity would otherwise give. Every other balance/status key is unchanged.
  const color =
    input.statusTone === "critical"
      ? keyColors.critical
      : input.statusTone === "neutral"
        ? keyColors.dim
        : severityColorFor(input);

  const amount = `<text data-part="balance-value" x="72" y="80" text-anchor="middle" font-family="sans-serif" font-size="${fitFontSize(input.valueText)}" font-weight="bold" fill="${color}">${escapeXml(input.valueText)}</text>`;

  const extraMarker = input.extraCurrencies !== undefined && input.extraCurrencies > 0 ? `+${input.extraCurrencies}` : undefined;
  const unitParts = [input.valueLabel, input.unitRowText, extraMarker].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const unitText = unitParts.join(" · ");
  const unitRow =
    unitParts.length > 0
      ? `<text data-part="unit-row" x="72" y="101" text-anchor="middle" font-family="sans-serif" font-size="${fitFontSize(unitText, 15, 10)}" fill="${keyColors.dim}">${escapeXml(unitText)}</text>`
      : "";

  const isSpendLike = input.displayBasis === "current-period-value" || input.displayBasis === "used-value";
  const marker = isSpendLike ? coverageMarker(input.dataThroughEpochMs, now) : resetMarker(input.resetsAtEpochMs, now);

  // Clock-derived peak-pricing phase (e.g. DeepSeek): informational only, never a
  // severity tone — amber while inside a peak window, dim off-peak. Renders between
  // the unit row (y=101) and the marker line (y=128) on fresh and stale keys alike.
  const phaseRow =
    input.pricingPhase === undefined
      ? ""
      : `<text data-part="pricing-phase" x="72" y="115" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${input.pricingPhase.tone === "amber" ? keyColors.warning : keyColors.dim}">${input.pricingPhase.phase === "peak" ? "peak hrs" : "off-peak"}</text>`;

  // Last-checked timestamp sits centered under the vendor name; when the
  // refresh failed, the amber stale badge owns that band instead.
  const checked =
    stale || input.fetchedAtEpochMs === undefined
      ? ""
      : `<text data-part="last-checked" x="72" y="43" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${keyColors.dim}">&#10003; ${formatClockTime(input.fetchedAtEpochMs)}</text>`;

  return staleTopRow(input, now) + amount + unitRow + phaseRow + marker + checked;
}

function statusBody(input: StatusValueRendererInput, now: number): string {
  const stale = input.freshness === "stale";
  const checked =
    stale || input.fetchedAtEpochMs === undefined
      ? ""
      : `<text data-part="last-checked" x="72" y="43" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${keyColors.dim}">&#10003; ${formatClockTime(input.fetchedAtEpochMs)}</text>`;
  const count = `<text data-part="status-value" x="72" y="80" text-anchor="middle" font-family="sans-serif" font-size="${fitFontSize(input.valueText)}" font-weight="bold" fill="${statusColorFor(input)}">${escapeXml(input.valueText)}</text>`;
  const unitRow = `<text data-part="unit-row" x="72" y="101" text-anchor="middle" font-family="sans-serif" font-size="15" fill="${keyColors.dim}">incidents</text>`;

  return staleTopRow(input, now) + checked + count + unitRow;
}

// ---------------------------------------------------------------------------
// Degraded states (old centered-message layouts and copy).
// ---------------------------------------------------------------------------

function degradedMessage(input: DisplayRendererInput): { readonly lines: readonly string[]; readonly color: string } {
  switch (input.displayState) {
    case "missing-credentials":
      return input.actionFamilyId === "balance"
        ? { lines: ["enter API key", "in settings"], color: keyColors.dim }
        : { lines: ["not signed in"], color: keyColors.dim };
    case "invalid-credentials":
    case "unauthorized-expired":
      return { lines: ["auth expired", input.authExpiredHint ?? "check settings"], color: keyColors.warning };
    case "rate-limited":
      return { lines: ["rate", "limited"], color: keyColors.warning };
    case "timeout":
    case "network-failure":
      return { lines: ["network", "error"], color: keyColors.warning };
    case "unsupported-capability":
      return { lines: ["not supported"], color: keyColors.dim };
    case "not-implemented":
      return { lines: ["not available", "yet"], color: keyColors.dim };
    case "settings-invalid":
      return { lines: ["settings", "invalid"], color: keyColors.warning };
    case "no-data-yet":
      return { lines: ["no data yet"], color: keyColors.dim };
    default:
      return { lines: ["error"], color: keyColors.critical };
  }
}

function valueTextForDisplayState(displayState: DisplayRendererInput["displayState"]): string {
  switch (displayState) {
    case "settings-invalid":
      return "Settings invalid";
    case "missing-credentials":
      return "Missing credentials";
    case "invalid-credentials":
      return "Invalid credentials";
    case "rate-limited":
      return "Rate limited";
    case "timeout":
      return "Timed out";
    case "network-failure":
      return "Network failure";
    case "unsupported-capability":
      return "Unsupported";
    case "not-implemented":
      return "Not implemented";
    case "provider-unavailable":
      return "Unavailable";
    case "validation-drift":
      return "Validation drift";
    default:
      return "No data";
  }
}

// ---------------------------------------------------------------------------
// Shared building blocks (old key-svg.ts primitives).
// ---------------------------------------------------------------------------

function svgShell(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="14" fill="${keyColors.background}"/>${body}</svg>`;
}

function toDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function centeredMessage(lines: readonly string[], color: string): string {
  const startY = 70 - (lines.length - 1) * 10;
  return lines
    .map(
      (line, index) =>
        `<text data-part="center-message" x="72" y="${startY + index * 20}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="${color}">${escapeXml(line)}</text>`,
    )
    .join("");
}

function severityColorFor(input: MetricDisplayRendererInput): string {
  return keyColors[input.rendererSeverityState];
}

function statusColorFor(input: StatusValueRendererInput): string {
  switch (input.statusDisplayTone) {
    case "operational":
      return keyColors.normal;
    case "informational":
      return keyColors.informational;
    case "warning":
      return keyColors.warning;
    case "critical":
      return keyColors.critical;
  }
}

function staleTopRow(input: DisplayRendererInput, now: number): string {
  return failureIndicator(input) + staleBadge(input, now);
}

function failureIndicator(input: DisplayRendererInput): string {
  if (input.failureIndicator === undefined) {
    return "";
  }
  return `<text data-part="failure-indicator" x="6" y="42" text-anchor="start" font-family="sans-serif" font-size="9" font-weight="bold" fill="${keyColors.warning}">${escapeXml(input.failureIndicator)}</text>`;
}

function staleBadge(input: DisplayRendererInput, now: number): string {
  // Local-fallback snapshots always carry the badge (old plugin honesty:
  // the value did not come from the provider's live endpoint).
  const stale = input.freshness === "stale" || (input.actionFamilyId !== "status" && input.sourceFallback === true);
  if (!stale || input.fetchedAtEpochMs === undefined) {
    return "";
  }
  return `<text data-part="stale-badge" x="138" y="42" text-anchor="end" font-family="sans-serif" font-size="13" font-weight="bold" fill="${keyColors.warning}">&#10227;${escapeXml(formatAge(now - input.fetchedAtEpochMs))}</text>`;
}

/** Dim "thru <date>" marker ONLY when the covered window ends before the current UTC day. */
function coverageMarker(dataThroughEpochMs: number | undefined, now: number): string {
  if (dataThroughEpochMs === undefined || dataThroughEpochMs >= utcDayStart(now)) {
    return "";
  }
  const date = new Date(dataThroughEpochMs);
  const label = `thru ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return `<text data-part="coverage-marker" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${keyColors.dim}">${escapeXml(label)}</text>`;
}

function resetMarker(resetsAtEpochMs: number | undefined, now: number): string {
  if (resetsAtEpochMs === undefined) {
    return "";
  }
  const reset = formatTimeToReset(resetsAtEpochMs, now);
  const text = reset.kind === "passed" ? "reset passed" : reset.kind === "idle" ? "idle" : `&#9203; ${escapeXml(reset.text)}`;
  return `<text data-part="reset-marker" x="72" y="128" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${keyColors.dim}">${text}</text>`;
}

function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

type TimeToReset = { readonly kind: "countdown"; readonly text: string } | { readonly kind: "idle" } | { readonly kind: "passed" };

/**
 * Old countdown semantics: `Xd Yh` at a day or more, `Xh YYm` under a day,
 * `Ym` under an hour; "idle" when nothing is scheduled; "reset passed" when
 * the moment elapsed. A missing reset must never read as an elapsed one.
 */
function formatTimeToReset(resetsAtEpochMs: number | undefined, now: number): TimeToReset {
  if (resetsAtEpochMs === undefined || resetsAtEpochMs === 0 || !Number.isFinite(resetsAtEpochMs)) {
    return { kind: "idle" };
  }
  if (resetsAtEpochMs <= now) {
    return { kind: "passed" };
  }
  const totalMinutes = Math.floor((resetsAtEpochMs - now) / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    return { kind: "countdown", text: `${days}d ${totalHours % 24}h` };
  }
  const minutes = totalMinutes % 60;
  if (totalHours === 0) {
    return { kind: "countdown", text: `${minutes}m` };
  }
  return { kind: "countdown", text: `${totalHours}h ${String(minutes).padStart(2, "0")}m` };
}

function formatAge(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Local wall-clock HH:MM (24 h) of the last successful check. */
function formatClockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Shrink-to-fit font size for the amount row (old estimator): bold sans glyph
 * widths estimated per char, sized so the row fits the usable key width.
 * Below the 12 px readability floor, readability wins over fit.
 */
function fitFontSize(text: string, maxPx: number = VALUE_MAX_PX, minPx: number = VALUE_MIN_PX): number {
  let units = 0;
  for (const ch of text) {
    if (".,: '".includes(ch) || ch === "i" || ch === "l" || ch === "j") units += 0.34;
    else if (ch === "/" || ch === " ") units += 0.4;
    else units += 0.62;
  }
  const fit = Math.floor(VALUE_MAX_WIDTH / Math.max(units, 0.62));
  return Math.max(minPx, Math.min(maxPx, fit));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ---------------------------------------------------------------------------
// Provider logos (old logo-loader flow): optional vendor artwork from
// assets/logos/<name>.svg; absence degrades to the text-only header.
// ---------------------------------------------------------------------------

const LOGO_FILE_BY_PROVIDER: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
  "zai-coding-plan": "zai",
  minimax: "minimax",
  "anthropic-api": "anthropic",
  "openai-api": "openai",
  moonshot: "moonshot",
  deepseek: "deepseek",
  tavily: "tavily",
  exa: "exa",
  deepgram: "deepgram",
  jina: "jina",
  fal: "fal",
  elevenlabs: "elevenlabs",
  runpod: "runpod",
  speechmatics: "speechmatics",
};

const logoCache = new Map<string, PreparedLogo | undefined>();

function logoForProvider(providerId: string | undefined): PreparedLogo | undefined {
  if (providerId === undefined) {
    return undefined;
  }
  if (logoCache.has(providerId)) {
    return logoCache.get(providerId);
  }

  let prepared: PreparedLogo | undefined;
  const fileName = LOGO_FILE_BY_PROVIDER[providerId];
  if (fileName !== undefined) {
    try {
      const logoPath = path.join(assetsSourcesRoot(), `${fileName}.svg`);
      if (existsSync(logoPath)) {
        prepared = prepareLogoSvg(readFileSync(logoPath, "utf8"));
      }
    } catch {
      prepared = undefined;
    }
  }
  logoCache.set(providerId, prepared);
  return prepared;
}

function assetsSourcesRoot(): string {
  // The bundle lives at <plugin>.sdPlugin/bin/plugin.js; provider artwork
  // carried over from the old plugin sits in <plugin>.sdPlugin/assets/logos.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "logos");
}

/** One centered header lockup: `[logo][gap][label]` when a logo exists, else centered text. */
function headerLockup(label: string, logo: PreparedLogo | undefined): string {
  if (logo === undefined) {
    return `<text data-part="header" x="72" y="${HEADER_BASELINE_Y}" text-anchor="middle" font-family="sans-serif" font-size="${HEADER_FONT_SIZE}" fill="${keyColors.dim}">${escapeXml(label)}</text>`;
  }

  const textWidth = estimateTextWidth(label, HEADER_FONT_SIZE);
  const lockupWidth = LOGO_SIZE + LOGO_TEXT_GAP + textWidth;
  const lockupX = (SIZE - lockupWidth) / 2;
  const capCenterY = HEADER_BASELINE_Y - HEADER_FONT_SIZE * 0.36;
  const logoY = capCenterY - LOGO_SIZE / 2;

  // Plain group transform — the Stream Deck key rasterizer does not render nested <svg>.
  const scale = LOGO_SIZE / Math.max(logo.viewBox.width, logo.viewBox.height);
  const tx = lockupX - logo.viewBox.minX * scale;
  const ty = logoY - logo.viewBox.minY * scale;
  const positioned = `<g data-part="provider-logo" transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})">${logo.body}</g>`;
  const text = `<text data-part="header" x="${(lockupX + LOGO_SIZE + LOGO_TEXT_GAP).toFixed(3)}" y="${HEADER_BASELINE_Y}" text-anchor="start" font-family="sans-serif" font-size="${HEADER_FONT_SIZE}" fill="${keyColors.dim}">${escapeXml(label)}</text>`;
  return positioned + text;
}

/** Deterministic width estimate so the logo+label lockup can be centered as one unit. */
function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    if (ch === "i" || ch === "l") units += 0.28;
    else if (ch === " ") units += 0.28;
    else if (ch === "·") units += 0.32;
    else if ("CDHKOX".includes(ch)) units += 0.72;
    else units += 0.55;
  }
  return units * fontSize;
}
