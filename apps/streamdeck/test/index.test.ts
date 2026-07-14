import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Duration, Effect, ManagedRuntime, Redacted, TestClock, TestContext } from "effect";

import { listBalanceProviderOptions } from "@ai-workbench/action-balance";
import { listUsageProviderOptions } from "@ai-workbench/action-usage";
import { PROVIDER_IDS, serializeSchedulerKey, type MetricDirection, type NormalizedSnapshot, type SchedulerKeyParts } from "@ai-workbench/contracts";
import { evaluateSeverity, type DisplayRendererInput } from "@ai-workbench/display";
import { createSanitizedFailure } from "@ai-workbench/errors";
import type { SanitizedLogEvent, StreamDeckLogSink } from "@ai-workbench/logging";
import type {
  Scheduler,
  SchedulerActivateInput,
  SchedulerDeactivateInput,
  SchedulerGlobalSettingsChangeInput,
  SchedulerOutput,
  SchedulerSettingsChangeInput,
} from "@ai-workbench/scheduler";
import { parseActionSettings, parsePropertyInspectorPayload } from "@ai-workbench/settings";
import { afterAll, describe, expect, it } from "vitest";

import { BALANCE_ACTION_UUID, PLUGIN_UUID, USAGE_ACTION_UUID, packageName } from "../src/constants.js";
import { resolveCredentialMaterialFromGlobalSettings } from "../src/credentials.js";
import { createSdkLogSink, writeShellLog } from "../src/logging.js";
import { listProviderOptionsForFamily } from "../src/property-inspector.js";
import { prepareLogoSvg } from "../src/logo-loader.js";
import { renderDisplayInput } from "../src/renderer.js";
import { createAppManagedRuntime, createRuntimeServices } from "../src/runtime.js";
import { createSchedulerFetchForActionSettings, withFetchPathLogging } from "../src/scheduler-fetch.js";
import { startRenderLoop, StreamDeckShell, type GlobalSettingsPort, type StreamDeckActionPort } from "../src/shell.js";
import { parseClaudeCodeKeychainPayload, parseCodexAuthJsonPayload, parseLastRateLimitsLine } from "../src/local-usage-sources.js";
import {
  defaultActionSettingsForFamily,
  legacySeverityProfileForBalanceInput,
  legacySeverityProfileForUsageInput,
  parseActionSettingsForFamily,
  withLegacyCredentialProfiles,
  type WritableActionSettings,
} from "../src/settings.js";

const RAW_NEEDLES = {
  account: "account_014-secret-fixture",
  apiKey: "fixture-api-key-value",
  token: "Bearer fixture-token-value",
} as const;

const balanceSettings = {
  familyId: "balance",
  providerId: "fal",
  refreshIntervalSeconds: 600,
  displayPreferences: {
    label: "Fal",
  },
} as const;

const usageSettings = {
  familyId: "usage",
  providerId: "claude-code",
  refreshIntervalSeconds: 600,
  displayPreferences: {
    usageDisplayMode: "used",
  },
  windowOrPeriod: "five-hour",
} as const;

const testProviderRequestRuntimeServices = createRuntimeServices({ write: () => undefined });
const testProviderRequestRuntime = testProviderRequestRuntimeServices.providerRequestRuntime;

afterAll(async () => {
  await testProviderRequestRuntimeServices.shutdown();
});

function manifestPath(): string {
  return fileURLToPath(new URL("../com.blackice.ai-workbench.sdPlugin/manifest.json", import.meta.url));
}

function propertyInspectorPath(fileName: string): string {
  return fileURLToPath(new URL(`../com.blackice.ai-workbench.sdPlugin/ui/${fileName}`, import.meta.url));
}

class FakeAction implements StreamDeckActionPort {
  readonly id: string;
  settings: unknown;
  readonly settingsWrites: WritableActionSettings[] = [];
  readonly images: string[] = [];
  readonly titles: string[] = [];
  alerts = 0;
  oks = 0;

  constructor(id: string, settings: unknown = balanceSettings) {
    this.id = id;
    this.settings = settings;
  }

  async getSettings(): Promise<unknown> {
    return this.settings;
  }

  async setSettings(settings: WritableActionSettings): Promise<void> {
    this.settingsWrites.push(settings);
    this.settings = settings;
  }

  async setImage(image?: string): Promise<void> {
    this.images.push(image ?? "");
  }

  async setTitle(title?: string): Promise<void> {
    this.titles.push(title ?? "");
  }

  async showAlert(): Promise<void> {
    this.alerts += 1;
  }

  async showOk(): Promise<void> {
    this.oks += 1;
  }
}

class FakeScheduler implements Scheduler {
  private readonly activationRecords: SchedulerActivateInput[] = [];
  private readonly activeByInstanceId = new Map<string, SchedulerActivateInput>();
  private readonly deactivationRecords: SchedulerDeactivateInput[] = [];
  private readonly refreshRecords: string[] = [];
  private readonly settingsChangeRecords: SchedulerSettingsChangeInput[] = [];
  private readonly globalSettingsChangeRecords: SchedulerGlobalSettingsChangeInput[] = [];
  refreshOutput?: SchedulerOutput;
  /** Stages the current push-model output a background poll fiber would have produced (read by getOutput). */
  getOutputResult?: SchedulerOutput;
  private outputChangedListener: ((schedulerKey: string) => void) | undefined;

  activate(input: SchedulerActivateInput): SchedulerOutput {
    this.activationRecords.push(input);
    this.activeByInstanceId.set(input.instanceId, input);
    return {
      activeRefCount: 1,
      displayState: "no-data-yet",
      failure: createSanitizedFailure({
        category: "no-data-yet",
        diagnostics: {
          boundary: "streamdeck-test",
          reasonCode: "activated",
        },
      }),
      inFlight: false,
      refreshIntervalSeconds: input.refreshIntervalSeconds,
      schedulerKey: serializeSchedulerKey(input.keyParts),
    };
  }

  deactivate(input: SchedulerDeactivateInput): SchedulerOutput {
    this.deactivationRecords.push(input);
    this.activeByInstanceId.delete(input.instanceId);
    return {
      activeRefCount: 0,
      displayState: "no-data-yet",
      failure: createSanitizedFailure({
        category: "no-data-yet",
        diagnostics: {
          boundary: "streamdeck-test",
          reasonCode: "deactivated",
        },
      }),
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey: input.schedulerKey,
    };
  }

  async refresh(schedulerKey: string): Promise<SchedulerOutput> {
    this.refreshRecords.push(schedulerKey);
    return this.refreshOutput ?? this.getOutput(schedulerKey);
  }

  async runDue(): Promise<readonly SchedulerOutput[]> {
    return [];
  }

  getOutput(schedulerKey: string): SchedulerOutput {
    if (this.getOutputResult !== undefined) {
      return { ...this.getOutputResult, schedulerKey };
    }
    return {
      activeRefCount: 1,
      displayState: "no-data-yet",
      failure: createSanitizedFailure({
        category: "no-data-yet",
        diagnostics: {
          boundary: "streamdeck-test",
          reasonCode: "no-current-data",
        },
      }),
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey,
    };
  }

  async handleActionSettingsChange(input: SchedulerSettingsChangeInput): Promise<SchedulerOutput> {
    this.settingsChangeRecords.push(input);
    return this.getOutput(input.schedulerKey);
  }

  async handleGlobalSettingsChange(input: SchedulerGlobalSettingsChangeInput): Promise<readonly SchedulerOutput[]> {
    this.globalSettingsChangeRecords.push(input);
    return input.schedulerKeys.map((schedulerKey) => this.getOutput(schedulerKey));
  }

  onOutputChanged(listener: (schedulerKey: string) => void): () => void {
    this.outputChangedListener = listener;
    return () => {
      if (this.outputChangedListener === listener) {
        this.outputChangedListener = undefined;
      }
    };
  }

  /** Test helper: simulate a poll fiber settling `schedulerKey` and notifying the subscribed shell. */
  emitOutputChanged(schedulerKey: string): void {
    this.outputChangedListener?.(schedulerKey);
  }

  async shutdown(): Promise<void> {
    return undefined;
  }

  activationCount(): number {
    return this.activationRecords.length;
  }

  isActivatedFor(instanceId: string): boolean {
    return this.activeByInstanceId.has(instanceId);
  }

  activatedSchedulerKeyPartsFor(instanceId: string): SchedulerKeyParts | undefined {
    return this.activeByInstanceId.get(instanceId)?.keyParts;
  }

  activatedSchedulerKeyFor(instanceId: string): string | undefined {
    const keyParts = this.activatedSchedulerKeyPartsFor(instanceId);
    return keyParts === undefined ? undefined : serializeSchedulerKey(keyParts);
  }

  lastRefreshKey(): string | undefined {
    return this.refreshRecords.at(-1);
  }

  refreshCountFor(schedulerKey: string): number {
    return this.refreshRecords.filter((key) => key === schedulerKey).length;
  }

  globalSettingsChangeCount(): number {
    return this.globalSettingsChangeRecords.length;
  }

  lastGlobalSettingsChange(): SchedulerGlobalSettingsChangeInput | undefined {
    return this.globalSettingsChangeRecords.at(-1);
  }

  lastDeactivationFor(instanceId: string): SchedulerDeactivateInput | undefined {
    return this.deactivationRecords.findLast((input) => input.instanceId === instanceId);
  }
}

function createShell(input: {
  readonly scheduler?: FakeScheduler;
  readonly globalWrites?: unknown[];
  readonly globalRead?: unknown;
  readonly logEvents?: SanitizedLogEvent[];
} = {}): { readonly shell: StreamDeckShell; readonly scheduler: FakeScheduler; readonly globalWrites: unknown[]; readonly logEvents: SanitizedLogEvent[] } {
  const scheduler = input.scheduler ?? new FakeScheduler();
  const globalWrites = input.globalWrites ?? [];
  const logEvents = input.logEvents ?? [];
  const globalSettings: GlobalSettingsPort = {
    read: async () => input.globalRead ?? {},
    write: async (settings) => {
      globalWrites.push(settings);
    },
  };
  const logSink: StreamDeckLogSink = {
    write: (event) => {
      logEvents.push(event);
    },
  };

  return {
    globalWrites,
    logEvents,
    scheduler,
    shell: new StreamDeckShell({
      globalSettings,
      logSink,
      providerRequestRuntime: testProviderRequestRuntime,
      scheduler,
    }),
  };
}

function balanceSnapshot(keyParts: SchedulerKeyParts): NormalizedSnapshot {
  return {
    coverage: { kind: "evergreen" },
    familyId: "balance",
    fetchedAtEpochMs: 1,
    metricDirection: "lower-bound",
    metricKind: "remaining-balance",
    providerId: keyParts.providerId as "fal",
    unit: "money",
    value: 42,
  };
}

function activeSchedulerKeyParts(scheduler: FakeScheduler, instanceId: string): SchedulerKeyParts {
  const keyParts = scheduler.activatedSchedulerKeyPartsFor(instanceId);
  if (keyParts === undefined) {
    throw new Error("Expected an activated scheduler entry");
  }
  return keyParts;
}

function activeSchedulerKey(scheduler: FakeScheduler, instanceId: string): string {
  const schedulerKey = scheduler.activatedSchedulerKeyFor(instanceId);
  if (schedulerKey === undefined) {
    throw new Error("Expected an activated scheduler key");
  }
  return schedulerKey;
}

function rateLimitedFailure() {
  return createSanitizedFailure({
    category: "rate-limited",
    diagnostics: {
      boundary: "streamdeck-test",
      reasonCode: "rate-limited",
    },
  });
}

describe("scheduler fetch-path logging", () => {
  it("emits one existing failed event with only catalog-normalized Claude response diagnostic labels", async () => {
    const parsed = parseActionSettings(usageSettings);
    if (!parsed.ok) {
      throw new Error("Expected valid Claude Code usage test settings");
    }

    const logEvents: SanitizedLogEvent[] = [];
    const logSink: StreamDeckLogSink = {
      write: (event) => {
        logEvents.push(event);
      },
    };
    const loggedFetch = withFetchPathLogging(
      parsed.value,
      {
        logSink,
        now: () => 100,
        readGlobalSettings: async () => ({}),
        sourceFlightRuntime: testProviderRequestRuntime.sourceFlightRuntime,
      },
      () =>
        Effect.fail({
          failure: createSanitizedFailure({
            category: "validation-drift",
            diagnostics: {
              reasonCode: "claude-code-usage-five-hour-utilization-invalid",
              responseDiagnostic: {
                code: "claude-code-usage-five-hour-utilization-invalid",
                receivedType: "string",
              },
            },
          }),
        }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        loggedFetch({
          key: parsed.value.schedulerKey,
          keyParts: parsed.value.schedulerKeyParts,
          schedulerKey: parsed.value.schedulerKey,
          signal: new AbortController().signal,
          startedAtEpochMs: 100,
          trigger: "healthy-poll",
        }),
      ),
    );

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: {
        failure: {
          category: "validation-drift",
          diagnostics: {
            reasonCode: "claude-code-usage-five-hour-utilization-invalid",
            responseDiagnostic: {
              code: "claude-code-usage-five-hour-utilization-invalid",
              expectedType: "number-or-null",
              receivedType: "string",
            },
          },
          retryClass: "rate-limit-backoff",
        },
      },
    });

    expect(logEvents.map((event) => event.eventName)).toEqual([
      "streamdeck-provider-fetch-started",
      "streamdeck-provider-fetch-failed",
    ]);
    const failureEvents = logEvents.filter((event) => event.eventName === "streamdeck-provider-fetch-failed");
    expect(failureEvents).toEqual([
      {
        context: {
          actionFamilyId: "usage",
          elapsedMs: 0,
          expectedResponseType: "number-or-null",
          providerId: "claude-code",
          reasonCode: "claude-code-usage-five-hour-utilization-invalid",
          receivedResponseType: "string",
          retryClass: "rate-limit-backoff",
        },
        eventName: "streamdeck-provider-fetch-failed",
        level: "warn",
        message: "Provider response validation failed.",
        sanitized: true,
      },
    ]);
  });

  it("keeps successful Claude fetch logging on the existing context without response type labels", async () => {
    const parsed = parseActionSettings(usageSettings);
    if (!parsed.ok) {
      throw new Error("Expected valid Claude Code usage test settings");
    }

    const logEvents: SanitizedLogEvent[] = [];
    const loggedFetch = withFetchPathLogging(
      parsed.value,
      {
        logSink: {
          write: (event) => {
            logEvents.push(event);
          },
        },
        now: () => 100,
        readGlobalSettings: async () => ({}),
        sourceFlightRuntime: testProviderRequestRuntime.sourceFlightRuntime,
      },
      () =>
        Effect.succeed<NormalizedSnapshot>({
          coverage: { kind: "rolling-window", window: "five-hour" },
          familyId: "usage",
          fetchedAtEpochMs: 100,
          metricDirection: "upper-bound",
          metricKind: "usage-percent",
          providerId: "claude-code",
          unit: "percent",
          value: 42,
        }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        loggedFetch({
          key: parsed.value.schedulerKey,
          keyParts: parsed.value.schedulerKeyParts,
          schedulerKey: parsed.value.schedulerKey,
          signal: new AbortController().signal,
          startedAtEpochMs: 100,
          trigger: "healthy-poll",
        }),
      ),
    );

    expect(outcome).toMatchObject({
      _tag: "Right",
      right: {
        coverage: { kind: "rolling-window", window: "five-hour" },
        providerId: "claude-code",
        value: 42,
      },
    });
    expect(logEvents.map((event) => event.eventName)).toEqual([
      "streamdeck-provider-fetch-started",
      "streamdeck-provider-fetch-succeeded",
    ]);
    const successEvents = logEvents.filter((event) => event.eventName === "streamdeck-provider-fetch-succeeded");
    expect(successEvents).toEqual([
      {
        context: {
          actionFamilyId: "usage",
          elapsedMs: 0,
          providerId: "claude-code",
          reasonCode: "fetch-succeeded",
        },
        eventName: "streamdeck-provider-fetch-succeeded",
        level: "info",
        message: "Provider fetch succeeded.",
        sanitized: true,
      },
    ]);
    expect(successEvents[0]?.context).not.toHaveProperty("expectedResponseType");
    expect(successEvents[0]?.context).not.toHaveProperty("receivedResponseType");
  });

  it("keeps non-response failures on the existing context without response type labels", async () => {
    const parsed = parseActionSettings(usageSettings);
    if (!parsed.ok) {
      throw new Error("Expected valid Claude Code usage test settings");
    }

    const logEvents: SanitizedLogEvent[] = [];
    const runFetch = createSchedulerFetchForActionSettings(parsed.value, {
      localSources: {},
      logSink: {
        write: (event) => {
          logEvents.push(event);
        },
      },
      now: () => 100,
      readGlobalSettings: async () => ({}),
      sourceFlightRuntime: testProviderRequestRuntime.sourceFlightRuntime,
    });

    const outcome = await Effect.runPromise(
      Effect.either(
        runFetch({
          key: parsed.value.schedulerKey,
          keyParts: parsed.value.schedulerKeyParts,
          schedulerKey: parsed.value.schedulerKey,
          signal: new AbortController().signal,
          startedAtEpochMs: 100,
          trigger: "healthy-poll",
        }),
      ),
    );

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: {
        failure: {
          category: "no-data-yet",
          diagnostics: { reasonCode: "usage-claude-source-reader-missing" },
          retryClass: "healthy-poll",
        },
      },
    });

    expect(logEvents.map((event) => event.eventName)).toEqual([
      "streamdeck-provider-fetch-started",
      "streamdeck-provider-fetch-failed",
    ]);
    const failureEvents = logEvents.filter((event) => event.eventName === "streamdeck-provider-fetch-failed");
    expect(failureEvents).toEqual([
      {
        context: {
          actionFamilyId: "usage",
          elapsedMs: 0,
          providerId: "claude-code",
          reasonCode: "usage-claude-source-reader-missing",
          retryClass: "healthy-poll",
        },
        eventName: "streamdeck-provider-fetch-failed",
        level: "warn",
        message: "No provider data is available yet.",
        sanitized: true,
      },
    ]);
    expect(failureEvents[0]?.context).not.toHaveProperty("expectedResponseType");
    expect(failureEvents[0]?.context).not.toHaveProperty("receivedResponseType");
  });
});

describe("provider logo assets", () => {
  it("every deployed provider logo, including minimax, prepares to a renderable lockup", async () => {
    // The renderer loads provider artwork from <plugin>.sdPlugin/assets/logos/<file>.svg at runtime
    // (bundle-relative, so renderDisplayInput cannot exercise it from src). Iterating the deployed set
    // is the only coverage of that path and catches a missing or broken SVG — minimax was the gap here.
    const logosDirUrl = new URL("../com.blackice.ai-workbench.sdPlugin/assets/logos/", import.meta.url);
    const files = (await readdir(fileURLToPath(logosDirUrl))).filter((name) => name.endsWith(".svg"));
    expect(files).toContain("minimax.svg");
    for (const file of files) {
      const prepared = prepareLogoSvg(await readFile(fileURLToPath(new URL(file, logosDirUrl)), "utf8"));
      expect({ file, renderable: prepared !== undefined && prepared.body.length > 0 }).toEqual({ file, renderable: true });
    }
  });
});

describe("@ai-workbench/streamdeck package and manifest", () => {
  it("keeps the package identity export", () => {
    expect(packageName).toBe("@ai-workbench/streamdeck");
  });

  it("uses the approved Stream Deck manifest baseline and prefixed action UUIDs", async () => {
    const manifest = JSON.parse(await readFile(manifestPath(), "utf8")) as {
      readonly SDKVersion: number;
      readonly Nodejs: { readonly Version: string };
      readonly Software: { readonly MinimumVersion: string };
      readonly CodePath: string;
      readonly UUID: string;
      readonly Actions: readonly { readonly UUID: string; readonly PropertyInspectorPath: string }[];
    };

    expect(manifest).toMatchObject({
      CodePath: "bin/plugin.js",
      Nodejs: { Version: "24" },
      SDKVersion: 2,
      Software: { MinimumVersion: "7.1" },
      UUID: PLUGIN_UUID,
    });
    expect(manifest.Actions.map((action) => action.UUID)).toEqual([USAGE_ACTION_UUID, BALANCE_ACTION_UUID]);
    for (const action of manifest.Actions) {
      expect(action.UUID.startsWith(`${PLUGIN_UUID}.`)).toBe(true);
      expect(action.PropertyInspectorPath.endsWith(".html")).toBe(true);
    }
  });
});

describe("Property Inspector registry data and static UI", () => {
  const internalProofPhrases = [
    "Adapter source proof",
    "Docs-backed metric truth",
    "Owner-gated proof",
    "Owner decision",
  ] as const;

  it("maps action provider options into PI-safe labels without internal proof metadata", () => {
    const usageOptions = listProviderOptionsForFamily("usage");
    const balanceOptions = listProviderOptionsForFamily("balance");

    expect(usageOptions.map((option) => option.providerId)).toEqual(
      listUsageProviderOptions().map((option) => option.providerId),
    );
    expect(balanceOptions.map((option) => option.providerId)).toEqual(
      listBalanceProviderOptions().map((option) => option.providerId),
    );

    const claudeCode = usageOptions.find((option) => option.providerId === "claude-code");
    const codex = usageOptions.find((option) => option.providerId === "codex");
    const fal = balanceOptions.find((option) => option.providerId === "fal");
    expect(claudeCode).toMatchObject({
      productLabel: "Claude Code",
      selectionEligible: true,
    });
    expect(codex).toMatchObject({
      productLabel: "Codex",
      selectionEligible: true,
    });
    expect(claudeCode).not.toHaveProperty("availabilityLabel");
    expect(codex).not.toHaveProperty("availabilityLabel");
    expect(claudeCode).not.toHaveProperty("credentialClass");
    expect(codex).not.toHaveProperty("credentialClass");
    expect(fal).toMatchObject({
      productLabel: "Fal.AI",
      selectionEligible: true,
      credentialClass: "plugin-api-key",
    });

    const serializedOptions = JSON.stringify([...usageOptions, ...balanceOptions]);
    for (const phrase of internalProofPhrases) {
      expect(serializedOptions).not.toContain(phrase);
    }
    for (const option of [...usageOptions, ...balanceOptions]) {
      expect(option).not.toHaveProperty("unavailableReason");
      expect(option).not.toHaveProperty("openDecision");
    }
  });

  it("mirrors the Usage panel's static provider/window lists against the registry (parity guard)", async () => {
    const usageHtml = await readFile(propertyInspectorPath("usage-display.html"), "utf8");

    // Old settings vocabulary -> canonical provider ids (the settings boundary
    // normalizes these on save). The static panel must mirror the registry.
    const legacyUsageIds = { "claude-code": "claude", codex: "codex", "zai-coding-plan": "zai", minimax: "minimax" } as const;
    // "credits"/"resets"/"fable"/"credit-spend" are new current-vocabulary categories with no
    // old-plugin rename; each locks the registry↔PI window lockstep the same as the rolling windows.
    const legacyWindowIds = { "five-hour": "five_hour", "seven-day": "weekly", "monthly-mcp": "mcp_monthly", credits: "credits", resets: "resets", fable: "fable", "credit-spend": "credit-spend" } as const;

    const options = listProviderOptionsForFamily("usage");
    const optionValues = [...usageHtml.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]);
    const providerValues = optionValues.filter(([value]) => Object.values(legacyUsageIds).includes(value as never));
    expect(providerValues.map(([value]) => value)).toEqual(options.map((option) => legacyUsageIds[option.providerId as keyof typeof legacyUsageIds]));
    expect(providerValues.map(([, label]) => label)).toEqual(options.map((option) => option.productLabel));

    const windowOptionsBlock = usageHtml.slice(usageHtml.indexOf("WINDOW_OPTIONS"));
    for (const option of options) {
      if (option.actionFamilyId !== "usage") {
        continue;
      }
      const legacyProvider = legacyUsageIds[option.providerId as keyof typeof legacyUsageIds];
      const row = windowOptionsBlock.slice(windowOptionsBlock.indexOf(`${legacyProvider}:`));
      const declared = option.supportedWindows.map((window) => legacyWindowIds[window]);
      // Bidirectional lockstep: the PI row must declare EXACTLY the registry's windows
      // (same set + order) — catches a window missing from the PI AND a stale extra window
      // the registry no longer supports (e.g. a hidden window left behind in the panel).
      const rowSlice = row.slice(0, row.indexOf("]],") + 3);
      const panelWindows = [...rowSlice.matchAll(/\["([^"]+)",/g)].map((match) => match[1]);
      expect(panelWindows).toEqual(declared);
    }
  });

  it("mirrors the Balance panel's static vendor list, labels, and credential copy against the registry (parity guard)", async () => {
    const balanceHtml = await readFile(propertyInspectorPath("balance-display.html"), "utf8");

    const legacyBalanceIds = {
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
    } as const;

    const options = listProviderOptionsForFamily("balance");
    // Registry metric direction per provider (source truth). The alignment invariant
    // requires VENDOR_META mode to mirror it: upper-bound=spend (fires ABOVE),
    // lower-bound=balance (fires BELOW).
    const balanceMetricDirections = new Map<string, MetricDirection>(
      listBalanceProviderOptions().map((option) => [option.providerId, option.metricDirection]),
    );
    const vendorSection = balanceHtml.slice(balanceHtml.indexOf('setting="vendor"'), balanceHtml.indexOf("</sdpi-select>"));
    const vendorValues = [...vendorSection.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]);
    expect(vendorValues.map(([value]) => value)).toEqual(
      options.map((option) => legacyBalanceIds[option.providerId as keyof typeof legacyBalanceIds]),
    );
    expect(vendorValues.map(([, label]) => label)).toEqual(options.map((option) => option.productLabel));

    for (const option of options) {
      expect(balanceHtml).toContain(`label="${option.credentialLabel ?? ""}"`);
      expect(balanceHtml).toContain(`placeholder="${option.credentialPlaceholder ?? ""}"`);
      const presentation = option.presentation;
      // The per-vendor "About" guidance and the "This key" explainer were removed from the Balance
      // Property Inspector (owner directive: they have no business in the panel), so the PI no longer
      // mirrors registry guidance. The registry retains the guidance metadata; it is simply not surfaced.
      if (presentation?.unitShortLabel !== undefined) {
        const legacyVendor = legacyBalanceIds[option.providerId as keyof typeof legacyBalanceIds];
        // VENDOR_META mode is locked to the registry metric direction (alignment
        // invariant): upper-bound => "spend" (fires ABOVE), lower-bound => "balance"
        // (fires BELOW). The PI wording and the severity fire direction both derive
        // from this one direction.
        const expectedMode = balanceMetricDirections.get(option.providerId) === "upper-bound" ? "spend" : "balance";
        expect(balanceHtml).toContain(`${legacyVendor}: { mode: "${expectedMode}"`);
        expect(balanceHtml).toContain(`unit: "${presentation.unitShortLabel}"`);
      }
    }

    // Direction-aware floor wording derives from the ONE metric direction (mode):
    // remaining fires BELOW the floor, spend/used fires ABOVE it.
    expect(balanceHtml).toContain('meta.mode === "balance" ? "below" : "above"');

    expect(balanceHtml).not.toContain("unavailableReason");
    expect(balanceHtml).not.toContain("Not available yet");
  });

  it("keeps both panels on sdpi setting bindings so every control saves itself", async () => {
    const usageHtml = await readFile(propertyInspectorPath("usage-display.html"), "utf8");
    const balanceHtml = await readFile(propertyInspectorPath("balance-display.html"), "utf8");

    for (const html of [usageHtml, balanceHtml]) {
      expect(html).toContain("sdpi-components.js");
      expect(html).toContain("<sdpi-item");
      expect(html).toContain('<sdpi-select setting="');
      expect(html).not.toContain("property-inspector.js");
      expect(html).not.toContain("reasonCode");
    }
    expect(usageHtml).toContain('setting="zaiApiKey" global');
    expect(usageHtml).toContain('setting="minimaxApiKey" global');
    expect(usageHtml).toContain('setting="displayMode"');
    expect(usageHtml).toContain('setting="intervalSeconds"');
    expect(balanceHtml).toContain('setting="balanceApiKeys.anthropic" global');
    expect(balanceHtml).toContain('setting="warnFloor"');
    expect(balanceHtml).toContain('setting="criticalFloor"');
  });

});

describe("settings boundary and PI writes", () => {
  it("defaults empty Stream Deck action settings to selectable provider/window combinations", () => {
    expect(defaultActionSettingsForFamily("usage")).toMatchObject({
      familyId: "usage",
      providerId: "claude-code",
      displayPreferences: {
        usageDisplayMode: "used",
      },
      windowOrPeriod: "five-hour",
    });
    expect(defaultActionSettingsForFamily("balance")).toMatchObject({
      familyId: "balance",
      providerId: "anthropic-api",
      displayPreferences: {},
    });

    const usage = parseActionSettingsForFamily("usage", {});
    const balance = parseActionSettingsForFamily("balance", {});

    expect(usage).toMatchObject({
      ok: true,
      value: {
        familyId: "usage",
        providerId: "claude-code",
        windowOrPeriod: "five-hour",
      },
    });
    expect(balance).toMatchObject({
      ok: true,
      value: {
        familyId: "balance",
        providerId: "anthropic-api",
      },
    });
  });

  it("accepts old project action settings fields without accepting secret-shaped action payloads", () => {
    expect(
      parseActionSettingsForFamily("usage", {
        provider: "codex",
        window: "weekly",
        displayMode: "remaining",
        intervalSeconds: 900,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        providerId: "codex",
        windowOrPeriod: "seven-day",
        refreshIntervalSeconds: 900,
        displayPreferences: {
          usageDisplayMode: "remaining",
        },
      },
    });
    expect(
      parseActionSettingsForFamily("balance", {
        vendor: "openai",
        intervalSeconds: 900,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        providerId: "openai-api",
        refreshIntervalSeconds: 900,
      },
    });
    expect(parseActionSettingsForFamily("usage", { provider: "zai", apiKey: RAW_NEEDLES.apiKey })).toMatchObject({
      ok: false,
    });
  });

  it("defaults every missing field on partial Property Inspector saves like the old plugin", () => {
    // sdpi controls save only the fields the user touched — partial payloads
    // are the NORMAL case and must default, never fail validation.
    expect(parseActionSettingsForFamily("usage", { displayMode: "remaining" })).toMatchObject({
      ok: true,
      value: {
        familyId: "usage",
        providerId: "claude-code",
        windowOrPeriod: "five-hour",
        displayPreferences: { usageDisplayMode: "remaining" },
      },
    });
    expect(parseActionSettingsForFamily("usage", { window: "weekly" })).toMatchObject({
      ok: true,
      value: { providerId: "claude-code", windowOrPeriod: "seven-day" },
    });
    // A persisted window the provider does not declare falls back to the
    // provider's FIRST supported window (old toKeyConfig behavior).
    expect(parseActionSettingsForFamily("usage", { provider: "codex", window: "mcp_monthly" })).toMatchObject({
      ok: true,
      value: { providerId: "codex", windowOrPeriod: "five-hour" },
    });
    // Unknown provider values default instead of failing (old behavior).
    expect(parseActionSettingsForFamily("usage", { provider: "not-a-provider" })).toMatchObject({
      ok: true,
      value: { providerId: "claude-code" },
    });
    // sdpi number fields save strings; coerce and clamp legacy intervals.
    expect(parseActionSettingsForFamily("usage", { intervalSeconds: "300" })).toMatchObject({
      ok: true,
      value: { refreshIntervalSeconds: 300 },
    });
    expect(parseActionSettingsForFamily("usage", { intervalSeconds: "30" })).toMatchObject({
      ok: true,
      value: { refreshIntervalSeconds: 60 },
    });
    expect(parseActionSettingsForFamily("balance", { warnFloor: "10" })).toMatchObject({
      ok: true,
      value: {
        familyId: "balance",
        providerId: "anthropic-api",
      },
    });
  });

  it("clamps legacy old-plugin refresh intervals into the current bounds and resolves canonical credential refs", () => {
    const clamped = parseActionSettingsForFamily("usage", {
      provider: "zai",
      window: "five_hour",
      intervalSeconds: 30,
    });
    expect(clamped).toMatchObject({
      ok: true,
      value: {
        providerId: "zai-coding-plan",
        windowOrPeriod: "five-hour",
        refreshIntervalSeconds: 60,
        credentialProfileRef: {
          kind: "credential-profile",
          credentialClass: "plugin-api-key",
          profileId: "profile:usage:zai-coding-plan:plugin-api-key",
        },
      },
    });

    // Locks the minimax silent-mis-route trap: provider "minimax" must resolve to providerId
    // "minimax" (NOT the claude-code fallback), window "weekly" -> "seven-day", and mint the
    // canonical plugin-api-key credential profile ref.
    const minimax = parseActionSettingsForFamily("usage", { provider: "minimax", window: "weekly" });
    expect(minimax).toMatchObject({
      ok: true,
      value: {
        providerId: "minimax",
        windowOrPeriod: "seven-day",
        credentialProfileRef: {
          kind: "credential-profile",
          credentialClass: "plugin-api-key",
          profileId: "profile:usage:minimax:plugin-api-key",
        },
      },
    });

    const balance = parseActionSettingsForFamily("balance", { vendor: "anthropic" });
    expect(balance).toMatchObject({
      ok: true,
      value: {
        providerId: "anthropic-api",
        credentialProfileRef: {
          kind: "credential-profile",
          credentialClass: "admin-api-credential",
          profileId: "profile:balance:anthropic-api:admin-api-credential",
        },
      },
    });

    const localSource = parseActionSettingsForFamily("usage", { provider: "claude" });
    expect(localSource).toMatchObject({ ok: true, value: { providerId: "claude-code" } });
    expect((localSource as { value: { credentialProfileRef?: unknown } }).value.credentialProfileRef).toBeUndefined();
  });

  it("maps old-plugin global settings keys into canonical credential profiles at read time", () => {
    const augmented = withLegacyCredentialProfiles({
      zaiApiKey: "legacy-zai-key-fixture",
      minimaxApiKey: "legacy-minimax-key-fixture",
      balanceApiKeys: {
        anthropic: "legacy-anthropic-key-fixture",
        fal: "legacy-fal-key-fixture",
      },
    }) as { credentialProfiles: readonly Record<string, unknown>[] };

    expect(augmented.credentialProfiles).toContainEqual(
      expect.objectContaining({
        profileId: "profile:usage:zai-coding-plan:plugin-api-key",
        actionFamilyId: "usage",
        providerId: "zai-coding-plan",
        credentialClass: "plugin-api-key",
        credentialMaterial: { kind: "inline-secret", value: "legacy-zai-key-fixture" },
      }),
    );
    expect(augmented.credentialProfiles).toContainEqual(
      expect.objectContaining({
        profileId: "profile:usage:minimax:plugin-api-key",
        actionFamilyId: "usage",
        providerId: "minimax",
        credentialClass: "plugin-api-key",
        credentialMaterial: { kind: "inline-secret", value: "legacy-minimax-key-fixture" },
      }),
    );
    expect(augmented.credentialProfiles).toContainEqual(
      expect.objectContaining({
        profileId: "profile:balance:anthropic-api:admin-api-credential",
        credentialClass: "admin-api-credential",
      }),
    );
    expect(augmented.credentialProfiles).toContainEqual(
      expect.objectContaining({
        profileId: "profile:balance:fal:plugin-api-key",
        credentialClass: "plugin-api-key",
      }),
    );

    const existing = withLegacyCredentialProfiles({
      zaiApiKey: "legacy-zai-key-fixture",
      credentialProfiles: [
        {
          profileId: "profile:usage:zai-coding-plan:plugin-api-key",
          actionFamilyId: "usage",
          providerId: "zai-coding-plan",
          credentialClass: "plugin-api-key",
          credentialMaterial: { kind: "inline-secret", value: "canonical-zai-key-fixture" },
        },
      ],
    }) as { credentialProfiles: readonly { credentialMaterial?: { value?: string } }[] };
    expect(existing.credentialProfiles).toHaveLength(1);
    expect(existing.credentialProfiles[0]?.credentialMaterial?.value).toBe("canonical-zai-key-fixture");
  });

  it("rejects secret-bearing action settings on receipt and never activates a fetch for them", async () => {
    const action = new FakeAction("action-secret");
    const { logEvents, scheduler, shell } = createShell();

    await shell.handleDidReceiveSettings("balance", action, {
      ...balanceSettings,
      apiKey: RAW_NEEDLES.apiKey,
    });

    expect(action.settingsWrites).toEqual([]);
    expect(action.alerts).toBe(1);
    expect(scheduler.activationCount()).toBe(0);
    const serialized = JSON.stringify({ logEvents, titles: action.titles });
    expect(serialized).not.toContain(RAW_NEEDLES.apiKey);
    expect(serialized).not.toContain("apiKey");
  });

  it("activates the scheduler from sdpi-received settings without the plugin writing settings back", async () => {
    const action = new FakeAction("action-valid");
    const { scheduler, shell } = createShell();

    await shell.handleDidReceiveSettings("balance", action, balanceSettings);

    // sdpi owns the write; the plugin only validates and activates.
    expect(action.settingsWrites).toEqual([]);
    expect(scheduler.activationCount()).toBe(1);
    expect(scheduler.isActivatedFor(action.id)).toBe(true);
  });

  it("classifies secret-bearing global settings changes without leaking material into logs or writes", async () => {
    const action = new FakeAction("action-global");
    const { globalWrites, logEvents, shell } = createShell();
    void action;

    shell.primeGlobalSettingsBaseline({ credentialProfiles: [], severityProfiles: [] });
    await shell.handleGlobalSettingsChanged({
      credentialProfiles: [
        {
          actionFamilyId: "balance",
          credentialClass: "admin-api-credential",
          credentialMaterial: {
            kind: "inline-secret",
            value: RAW_NEEDLES.token,
          },
          displayName: "OpenAI admin",
          profileId: "profile-openai",
          providerId: "openai-api",
        },
      ],
      severityProfiles: [],
    });

    // sdpi owns the write; classification must never echo credential material.
    expect(globalWrites).toEqual([]);
    const serialized = JSON.stringify({ logEvents });
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.account);
    expect(serialized).not.toContain(RAW_NEEDLES.apiKey);
  });

  it("routes provider-source global changes to affected active scheduler keys only", async () => {
    const scheduler = new FakeScheduler();
    const falAction = new FakeAction("action-fal");
    const deepgramAction = new FakeAction("action-deepgram");
    const falSettings = {
      ...balanceSettings,
      credentialProfileRef: {
        credentialClass: "plugin-api-key",
        kind: "credential-profile",
        profileId: "profile-fal-primary",
      },
    } as const;
    const deepgramSettings = {
      ...balanceSettings,
      credentialProfileRef: {
        credentialClass: "plugin-api-key",
        kind: "credential-profile",
        profileId: "profile-deepgram-primary",
      },
      displayPreferences: {
        label: "Deepgram",
      },
      providerId: "deepgram",
    } as const;
    const previousGlobalSettings = {
      credentialProfiles: [
        {
          actionFamilyId: "balance",
          credentialClass: "plugin-api-key",
          credentialMaterial: {
            kind: "inline-secret",
            value: "fixture-fal-credential-old",
          },
          profileId: "profile-fal-primary",
          providerId: "fal",
        },
        {
          actionFamilyId: "balance",
          credentialClass: "plugin-api-key",
          credentialMaterial: {
            kind: "inline-secret",
            value: "fixture-deepgram-credential",
          },
          profileId: "profile-deepgram-primary",
          providerId: "deepgram",
        },
      ],
      severityProfiles: [],
    };
    const { globalWrites, shell } = createShell({ globalRead: previousGlobalSettings, scheduler });

    await shell.handleWillAppear("balance", falAction, falSettings);
    await shell.handleWillAppear("balance", deepgramAction, deepgramSettings);
    const falKey = activeSchedulerKey(scheduler, falAction.id);

    shell.primeGlobalSettingsBaseline(previousGlobalSettings);
    await shell.handleGlobalSettingsChanged({
      credentialProfiles: [
        {
          ...previousGlobalSettings.credentialProfiles[0],
          credentialMaterial: {
            kind: "inline-secret",
            value: "fixture-fal-credential-new",
          },
        },
        previousGlobalSettings.credentialProfiles[1],
      ],
      severityProfiles: [],
    });

    // sdpi owns the global-settings write; the plugin only classifies/refetches.
    expect(globalWrites).toEqual([]);
    expect(scheduler.globalSettingsChangeCount()).toBe(1);
    expect(scheduler.lastGlobalSettingsChange()).toMatchObject({
      change: {
        kind: "provider-source-affecting",
        affectedCredentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
      },
      schedulerKeys: [falKey],
    });
    expect(falAction.images).toHaveLength(2);
    expect(deepgramAction.images).toHaveLength(1);
  });

  it("classifies sdpi global-settings events and refetches exactly the affected legacy-key provider", async () => {
    const scheduler = new FakeScheduler();
    const zaiAction = new FakeAction("action-zai-legacy-key");
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("usage", zaiAction, { provider: "zai", window: "five_hour" });
    const zaiKey = activeSchedulerKey(scheduler, zaiAction.id);

    shell.primeGlobalSettingsBaseline({});
    await shell.handleGlobalSettingsChanged({ zaiApiKey: "fixture-zai-key-new" });

    expect(scheduler.globalSettingsChangeCount()).toBe(1);
    expect(scheduler.lastGlobalSettingsChange()).toMatchObject({
      change: {
        kind: "provider-source-affecting",
        bypassBackoffAllowed: true,
        affectedCredentialProfiles: [
          {
            actionFamilyId: "usage",
            credentialClass: "plugin-api-key",
            profileId: "profile:usage:zai-coding-plan:plugin-api-key",
            providerId: "zai-coding-plan",
          },
        ],
      },
      schedulerKeys: [zaiKey],
    });

    // An identical repeat classifies as unchanged and triggers nothing.
    await shell.handleGlobalSettingsChanged({ zaiApiKey: "fixture-zai-key-new" });
    expect(scheduler.globalSettingsChangeCount()).toBe(1);
  });

  it("fails closed and invalidates active scheduler keys when previous global settings are malformed", async () => {
    const scheduler = new FakeScheduler();
    const falAction = new FakeAction("action-fal-malformed-global");
    const deepgramAction = new FakeAction("action-deepgram-malformed-global");
    const falSettings = {
      ...balanceSettings,
      credentialProfileRef: {
        credentialClass: "plugin-api-key",
        kind: "credential-profile",
        profileId: "profile-fal-primary",
      },
    } as const;
    const deepgramSettings = {
      ...balanceSettings,
      credentialProfileRef: {
        credentialClass: "plugin-api-key",
        kind: "credential-profile",
        profileId: "profile-deepgram-primary",
      },
      displayPreferences: {
        label: "Deepgram",
      },
      providerId: "deepgram",
    } as const;
    const { globalWrites, logEvents, shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", falAction, falSettings);
    await shell.handleWillAppear("balance", deepgramAction, deepgramSettings);
    const falKey = activeSchedulerKey(scheduler, falAction.id);
    const deepgramKey = activeSchedulerKey(scheduler, deepgramAction.id);

    shell.primeGlobalSettingsBaseline({ credentialProfiles: [], severityProfiles: [] });
    await shell.handleGlobalSettingsChanged({
      credentialProfiles: [
        {
          profileId: 123,
        },
      ],
    });

    expect(globalWrites).toEqual([]);
    expect(scheduler.globalSettingsChangeCount()).toBe(1);
    expect(scheduler.lastGlobalSettingsChange()?.change).toMatchObject({
      bypassBackoffAllowed: true,
      kind: "provider-source-affecting",
      providerRefetchRequired: true,
      reasons: ["global-settings-classification-failed"],
    });
    expect(new Set(scheduler.lastGlobalSettingsChange()?.schedulerKeys)).toEqual(new Set([falKey, deepgramKey]));
    expect(falAction.images).toHaveLength(2);
    expect(deepgramAction.images).toHaveLength(2);
    expect(JSON.stringify({ globalWrites, logEvents })).not.toContain("profileId\":123");
  });
});

describe("direction-aware balance severity floors", () => {
  // The single warn/critical floor numbers are direction-agnostic; the provider's
  // registry metric direction decides whether the central engine fires them ABOVE
  // (spend/used, upper-bound) or BELOW (remaining, lower-bound). These prove the
  // user override actually REACHES the engine in BOTH directions — the spend/used
  // case was previously dropped because the profile direction was hardcoded
  // lower-bound and the engine rejects a direction mismatch.
  function balanceMetricDirection(providerId: string) {
    const option = listBalanceProviderOptions().find((candidate) => candidate.providerId === providerId);
    if (option === undefined) {
      throw new Error(`no balance provider option for ${providerId}`);
    }
    return option.metricDirection;
  }

  it("maps a SPEND/USED vendor's floors to an upper-bound profile the engine fires ABOVE", () => {
    const profile = legacySeverityProfileForBalanceInput({ vendor: "anthropic", warnFloor: 40, criticalFloor: 50 });
    expect(profile).toEqual({
      profileId: "floors:balance:anthropic-api",
      thresholds: { direction: "upper-bound", basis: "absolute", warningAt: 40, criticalAt: 50 },
    });
    if (profile === undefined) {
      throw new Error("spend vendor floors must produce a severity profile");
    }

    const metricDirection = balanceMetricDirection("anthropic-api");
    expect(metricDirection).toBe("upper-bound");
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection, valueBasis: "absolute", thresholds: profile.thresholds, value });
    // ABOVE: healthy below warn, warning at/above warn, critical at/above critical.
    expect(severityAt(30).severity).toBe("healthy");
    const warning = severityAt(45);
    expect(warning.severity).toBe("warning");
    // The user floors — not a registry default — are what the engine evaluated.
    expect(warning.thresholdResolution).toMatchObject({ kind: "evaluated", source: "user-override" });
    expect(severityAt(50).severity).toBe("critical");
    expect(severityAt(55).severity).toBe("critical");
  });

  it("maps a REMAINING vendor's floors to a lower-bound profile the engine fires BELOW", () => {
    const profile = legacySeverityProfileForBalanceInput({ vendor: "fal", warnFloor: 10, criticalFloor: 5 });
    expect(profile).toEqual({
      profileId: "floors:balance:fal",
      thresholds: { direction: "lower-bound", basis: "absolute", warningAt: 10, criticalAt: 5 },
    });
    if (profile === undefined) {
      throw new Error("remaining vendor floors must produce a severity profile");
    }

    const metricDirection = balanceMetricDirection("fal");
    expect(metricDirection).toBe("lower-bound");
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection, valueBasis: "absolute", thresholds: profile.thresholds, value });
    // BELOW: healthy above warn, warning at/below warn, critical at/below critical.
    expect(severityAt(50).severity).toBe("healthy");
    const warning = severityAt(10);
    expect(warning.severity).toBe("warning");
    expect(warning.thresholdResolution).toMatchObject({ kind: "evaluated", source: "user-override" });
    expect(severityAt(5).severity).toBe("critical");
    expect(severityAt(3).severity).toBe("critical");
  });

  it("keeps a lone floor optional and still direction-correct for a spend/used vendor", () => {
    // A lone warn floor colors amber only (old working plugin UX) — and for a
    // used-time (upper-bound) vendor it must still resolve upper-bound, not be
    // dropped as a direction mismatch.
    const profile = legacySeverityProfileForBalanceInput({ vendor: "speechmatics", warnFloor: 2 });
    expect(profile).toEqual({
      profileId: "floors:balance:speechmatics",
      thresholds: { direction: "upper-bound", basis: "absolute", warningAt: 2 },
    });
    if (profile === undefined) {
      throw new Error("lone spend floor must produce a severity profile");
    }

    const metricDirection = balanceMetricDirection("speechmatics");
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection, valueBasis: "absolute", thresholds: profile.thresholds, value }).severity;
    expect(severityAt(1)).toBe("healthy");
    expect(severityAt(3)).toBe("warning");
  });
});

describe("Codex credits floors migration", () => {
  it("maps Codex credits floors to a lower-bound absolute severity profile the engine fires BELOW", () => {
    const profile = legacySeverityProfileForUsageInput({
      providerId: "codex",
      windowOrPeriod: "credits",
      warnFloor: 5000,
      criticalFloor: 1000,
    });
    expect(profile).toEqual({
      profileId: "floors:usage:codex:credits",
      thresholds: { direction: "lower-bound", basis: "absolute", warningAt: 5000, criticalAt: 1000 },
    });
    if (profile === undefined) {
      throw new Error("codex credits floors must produce a severity profile");
    }

    // BELOW: healthy above warn, warning at/below warn, critical at/below critical.
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection: "lower-bound", valueBasis: "absolute", thresholds: profile.thresholds, value });
    expect(severityAt(6000).severity).toBe("healthy");
    expect(severityAt(5000).severity).toBe("warning");
    expect(severityAt(1000).severity).toBe("critical");
    // The user floors — not a registry default — are what the engine evaluated.
    expect(severityAt(5000).thresholdResolution).toMatchObject({ kind: "evaluated", source: "user-override" });
  });

  it("migrates the credits floors through the legacy PI window vocabulary (window=credits) into a profile reference", () => {
    // The PI saves the window under the legacy `window` key and the floors as warnFloor/criticalFloor.
    const parsed = parseActionSettingsForFamily("usage", {
      provider: "codex",
      window: "credits",
      warnFloor: 5000,
      criticalFloor: 1000,
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        providerId: "codex",
        windowOrPeriod: "credits",
        severityProfileRef: { kind: "severity-profile", profileId: "floors:usage:codex:credits" },
      },
    });
  });

  it("does not migrate floors for the percentage windows (they use the registry default)", () => {
    expect(
      legacySeverityProfileForUsageInput({ providerId: "codex", windowOrPeriod: "five-hour", warnFloor: 80 }),
    ).toBeUndefined();

    const parsed = parseActionSettingsForFamily("usage", { provider: "codex", window: "five_hour", warnFloor: 80 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.windowOrPeriod).toBe("five-hour");
      expect(parsed.value.severityProfileRef).toBeUndefined();
    }
  });

  it("does not migrate credits floors for a provider without a credits category (Claude Code), and needs at least one floor", () => {
    expect(
      legacySeverityProfileForUsageInput({ providerId: "claude-code", windowOrPeriod: "credits", warnFloor: 5000 }),
    ).toBeUndefined();
    expect(legacySeverityProfileForUsageInput({ providerId: "codex", windowOrPeriod: "credits" })).toBeUndefined();
  });
});

describe("Codex resets floors migration", () => {
  it("maps Codex resets floors to a lower-bound absolute severity profile the engine fires BELOW", () => {
    const profile = legacySeverityProfileForUsageInput({
      providerId: "codex",
      windowOrPeriod: "resets",
      warnFloor: 2,
      criticalFloor: 1,
    });
    expect(profile).toEqual({
      profileId: "floors:usage:codex:resets",
      thresholds: { direction: "lower-bound", basis: "absolute", warningAt: 2, criticalAt: 1 },
    });
    if (profile === undefined) {
      throw new Error("codex resets floors must produce a severity profile");
    }

    // BELOW: healthy above warn, warning at/below warn, critical at/below critical — evaluated on the
    // days-remaining runway (the resets floor numbers are DAYS, not the count).
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection: "lower-bound", valueBasis: "absolute", thresholds: profile.thresholds, value });
    expect(severityAt(3).severity).toBe("healthy");
    expect(severityAt(2).severity).toBe("warning");
    expect(severityAt(1).severity).toBe("critical");
    expect(severityAt(2).thresholdResolution).toMatchObject({ kind: "evaluated", source: "user-override" });
  });

  it("migrates the resets floors through the legacy PI window vocabulary (window=resets) into a profile reference", () => {
    const parsed = parseActionSettingsForFamily("usage", {
      provider: "codex",
      window: "resets",
      warnFloor: 2,
      criticalFloor: 1,
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        providerId: "codex",
        windowOrPeriod: "resets",
        severityProfileRef: { kind: "severity-profile", profileId: "floors:usage:codex:resets" },
      },
    });
  });

  it("does not migrate resets floors for a provider without a resets category (Claude Code), and needs at least one floor", () => {
    expect(
      legacySeverityProfileForUsageInput({ providerId: "claude-code", windowOrPeriod: "resets", warnFloor: 2 }),
    ).toBeUndefined();
    expect(legacySeverityProfileForUsageInput({ providerId: "codex", windowOrPeriod: "resets" })).toBeUndefined();
  });
});

describe("Claude Code credit-spend floors migration", () => {
  it("maps claude-code credit-spend floors to an UPPER-BOUND absolute severity profile the engine fires ABOVE", () => {
    const profile = legacySeverityProfileForUsageInput({
      providerId: "claude-code",
      windowOrPeriod: "credit-spend",
      warnFloor: 10,
      criticalFloor: 20,
    });
    expect(profile).toEqual({
      profileId: "floors:usage:claude-code:credit-spend",
      thresholds: { direction: "upper-bound", basis: "absolute", warningAt: 10, criticalAt: 20 },
    });
    if (profile === undefined) {
      throw new Error("claude-code credit-spend floors must produce a severity profile");
    }

    // ABOVE (upper-bound): healthy below warn, warning at/above warn, critical at/above critical —
    // evaluated on the DOLLARS spent (absolute), the spend guard's severity basis. Distinct from the
    // lower-bound Codex floors (which fire BELOW): a spend guard worsens as the money rises.
    const severityAt = (value: number) =>
      evaluateSeverity({ metricDirection: "upper-bound", valueBasis: "absolute", thresholds: profile.thresholds, value });
    expect(severityAt(5).severity).toBe("healthy");
    expect(severityAt(10).severity).toBe("warning");
    expect(severityAt(20).severity).toBe("critical");
    expect(severityAt(10).thresholdResolution).toMatchObject({ kind: "evaluated", source: "user-override" });
  });

  it("migrates the credit-spend floors through the legacy PI window vocabulary (window=credit-spend) into a profile reference", () => {
    const parsed = parseActionSettingsForFamily("usage", {
      provider: "claude",
      window: "credit-spend",
      warnFloor: 10,
      criticalFloor: 20,
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        providerId: "claude-code",
        windowOrPeriod: "credit-spend",
        severityProfileRef: { kind: "severity-profile", profileId: "floors:usage:claude-code:credit-spend" },
      },
    });
  });

  it("does not migrate floors for the claude-code percentage windows, nor credit-spend for a provider without it (Codex)", () => {
    // The 5h/7d/fable percentage windows keep the fixed registry default and never migrate floors.
    expect(
      legacySeverityProfileForUsageInput({ providerId: "claude-code", windowOrPeriod: "five-hour", warnFloor: 80 }),
    ).toBeUndefined();
    expect(
      legacySeverityProfileForUsageInput({ providerId: "claude-code", windowOrPeriod: "fable", warnFloor: 80 }),
    ).toBeUndefined();
    // Only claude-code declares credit-spend; Codex resolves it to its default percentage metric.
    expect(
      legacySeverityProfileForUsageInput({ providerId: "codex", windowOrPeriod: "credit-spend", warnFloor: 10 }),
    ).toBeUndefined();
    // At least one floor is required.
    expect(legacySeverityProfileForUsageInput({ providerId: "claude-code", windowOrPeriod: "credit-spend" })).toBeUndefined();
  });
});

describe("credential resolution to Redacted<string>", () => {
  const CREDENTIAL_SECRET = "fixture-fal-credential-secret-value";

  function resolvedActionSettings() {
    const parsed = parseActionSettings({
      familyId: "balance",
      providerId: "fal",
      refreshIntervalSeconds: 600,
      displayPreferences: { label: "Fal" },
      credentialProfileRef: {
        kind: "credential-profile",
        credentialClass: "plugin-api-key",
        profileId: "profile-fal-primary",
      },
    });
    if (!parsed.ok) {
      throw new Error("fixture action settings must parse");
    }
    return parsed.value;
  }

  const globalSettingsWithSecret = {
    credentialProfiles: [
      {
        actionFamilyId: "balance",
        credentialClass: "plugin-api-key",
        credentialMaterial: { kind: "inline-secret", value: CREDENTIAL_SECRET },
        profileId: "profile-fal-primary",
        providerId: "fal",
      },
    ],
    severityProfiles: [],
  };

  it("decodes the credential secret from unknown global settings into a Redacted<string> at the edge", () => {
    const result = resolveCredentialMaterialFromGlobalSettings({
      actionSettings: resolvedActionSettings(),
      globalSettings: globalSettingsWithSecret,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The raw secret is recoverable only through Redacted.value.
    expect(Redacted.value(result.value.value)).toBe(CREDENTIAL_SECRET);
    // It renders <redacted> and never exposes the raw secret when stringified/logged.
    expect(String(result.value.value)).toBe("<redacted>");
    expect(JSON.stringify(result.value)).not.toContain(CREDENTIAL_SECRET);
  });

  it("returns a sanitized missing-credentials failure when no matching profile exists", () => {
    const result = resolveCredentialMaterialFromGlobalSettings({
      actionSettings: resolvedActionSettings(),
      globalSettings: { credentialProfiles: [], severityProfiles: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failure.displayState).toBe("missing-credentials");
  });

  it("rejects a whitespace-only credential secret as missing", () => {
    const result = resolveCredentialMaterialFromGlobalSettings({
      actionSettings: resolvedActionSettings(),
      globalSettings: {
        credentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            credentialMaterial: { kind: "inline-secret", value: "   " },
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
        severityProfiles: [],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failure.displayState).toBe("missing-credentials");
  });

  it("classifies a present credential with a header-invalid character as invalid-credentials without leaking the value", () => {
    // FAKE keys only. An internal line break and an astral (non-Latin-1) code point are the
    // two confirmed corrupted-paste shapes that make Node's fetch throw synchronously when the
    // value is forwarded into the provider authorization header (previously surfacing as a
    // misleading network failure). Distinctive body/tail markers let the leak assertion bite.
    const internalNewlineKey = "sk-fixture-INVALIDBODY-abc" + "\n" + "def-TAILMARK";
    const astralKey = "sk-fixture-INVALIDBODY-abc" + String.fromCodePoint(0x1f600) + "def-TAILMARK";

    for (const malformedValue of [internalNewlineKey, astralKey]) {
      const result = resolveCredentialMaterialFromGlobalSettings({
        actionSettings: resolvedActionSettings(),
        globalSettings: {
          credentialProfiles: [
            {
              actionFamilyId: "balance",
              credentialClass: "plugin-api-key",
              credentialMaterial: { kind: "inline-secret", value: malformedValue },
              profileId: "profile-fal-primary",
              providerId: "fal",
            },
          ],
          severityProfiles: [],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.failure.category).toBe("invalid-credentials");
      expect(result.failure.displayState).toBe("invalid-credentials");
      expect(result.failure.safePublicMessage).toBe("Provider credentials are invalid.");
      expect(result.failure.diagnostics.reasonCode).toBe("credential-format-invalid");
      expect(result.failure.diagnostics.boundary).toBe("streamdeck-credentials");
      expect(result.failure.provider?.failureClass).toBe("credentials");
      expect(result.failure.provider?.reasonCode).toBe("credential-format-invalid");
      // Nothing derived from the key reaches the sanitized failure.
      const serialized = JSON.stringify(result.failure);
      expect(serialized).not.toContain("INVALIDBODY");
      expect(serialized).not.toContain("TAILMARK");
    }
  });

  it("resolves a normal valid key with base64/JWT punctuation to ok (no false rejection)", () => {
    const validKey = "sk-fixture-Abc123._+/=";
    const result = resolveCredentialMaterialFromGlobalSettings({
      actionSettings: resolvedActionSettings(),
      globalSettings: {
        credentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            credentialMaterial: { kind: "inline-secret", value: validKey },
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
        severityProfiles: [],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Redacted.value(result.value.value)).toBe(validKey);
  });

  it("resolves a valid key with trailing whitespace to ok without mutating the stored value (Node trims the trailing edge)", () => {
    const trailingWhitespaceKey = "sk-fixture-Abc123-trailing  ";
    const result = resolveCredentialMaterialFromGlobalSettings({
      actionSettings: resolvedActionSettings(),
      globalSettings: {
        credentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            credentialMaterial: { kind: "inline-secret", value: trailingWhitespaceKey },
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
        severityProfiles: [],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Single-unwrap invariant: the ORIGINAL untrimmed Redacted flows onward.
    expect(Redacted.value(result.value.value)).toBe(trailingWhitespaceKey);
  });
});

describe("local usage source parsing (read-only stores)", () => {
  it("parses the Claude Code Keychain payload and rejects malformed shapes with reason codes only", () => {
    expect(
      parseClaudeCodeKeychainPayload(
        JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access-token", expiresAt: 1_800_000_000_000 } }),
      ),
    ).toEqual({
      ok: true,
      accessToken: "fixture-access-token",
      expiresAt: 1_800_000_000_000,
    });
    expect(parseClaudeCodeKeychainPayload(JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access-token" } }))).toEqual({
      ok: true,
      accessToken: "fixture-access-token",
    });
    expect(parseClaudeCodeKeychainPayload("not-json")).toEqual({
      ok: false,
      reasonCode: "claude-code-keychain-malformed",
    });
    expect(parseClaudeCodeKeychainPayload(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toEqual({
      ok: false,
      reasonCode: "claude-code-keychain-malformed",
    });
    expect(parseClaudeCodeKeychainPayload(JSON.stringify({ somethingElse: true }))).toEqual({
      ok: false,
      reasonCode: "claude-code-keychain-malformed",
    });
  });

  it("parses Codex auth.json in chatgpt mode and rejects other modes with reason codes only", () => {
    expect(
      parseCodexAuthJsonPayload(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-codex-token", account_id: "fixture-account" } }),
      ),
    ).toEqual({
      ok: true,
      accessToken: "fixture-codex-token",
      accountId: "fixture-account",
    });
    expect(parseCodexAuthJsonPayload(JSON.stringify({ auth_mode: "apikey" }))).toEqual({
      ok: false,
      reasonCode: "codex-auth-wrong-mode",
    });
    expect(parseCodexAuthJsonPayload(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "" } }))).toEqual({
      ok: false,
      reasonCode: "codex-auth-malformed",
    });
    expect(parseCodexAuthJsonPayload("{broken")).toEqual({
      ok: false,
      reasonCode: "codex-auth-malformed",
    });
  });
});

describe("Codex session-file tail parsing (old fallback shape)", () => {
  it("extracts the LAST rate_limits line, skips malformed lines, and keeps the file timestamp", () => {
    const lines = [
      JSON.stringify({ type: "other", payload: { note: "no limits here" } }),
      JSON.stringify({
        payload: {
          rate_limits: {
            primary: { window_minutes: 300, used_percent: 10 },
            secondary: { window_minutes: 10_080, used_percent: 3 },
          },
        },
      }),
      '{ broken json with "rate_limits" inside',
      JSON.stringify({
        payload: {
          rate_limits: {
            primary: { window_minutes: 300, used_percent: 42 },
            secondary: { window_minutes: 10_080, used_percent: 12 },
          },
        },
      }),
    ].join("\n");

    expect(parseLastRateLimitsLine(lines, 5_000)).toEqual({
      fetchedAtEpochMs: 5_000,
      fiveHourPercent: 42,
      sevenDayPercent: 12,
    });
  });

  it("derives Codex session windows by exact minutes across normal, reversed, and temporary slot placement", () => {
    const normal = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { window_minutes: 300, used_percent: 42, resets_at: 1_805_000_000 },
          secondary: { window_minutes: 10_080, used_percent: 12, resets_at: 1_806_000_000 },
        },
      },
    });
    expect(parseLastRateLimitsLine(normal, 5_000)).toEqual({
      fetchedAtEpochMs: 5_000,
      fiveHourPercent: 42,
      sevenDayPercent: 12,
      fiveHourResetsAtEpochMs: 1_805_000_000_000,
      sevenDayResetsAtEpochMs: 1_806_000_000_000,
    });

    const reversed = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { window_minutes: 10_080, used_percent: 12, resets_at: 1_806_000_000 },
          secondary: { window_minutes: 300, used_percent: 42, resets_at: 1_805_000_000 },
        },
      },
    });
    expect(parseLastRateLimitsLine(reversed, 5_000)).toEqual({
      fetchedAtEpochMs: 5_000,
      fiveHourPercent: 42,
      sevenDayPercent: 12,
      fiveHourResetsAtEpochMs: 1_805_000_000_000,
      sevenDayResetsAtEpochMs: 1_806_000_000_000,
    });

    const temporary = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { window_minutes: 10_080, used_percent: 7, resets_at: 1_806_000_000 },
          secondary: null,
        },
      },
    });
    expect(parseLastRateLimitsLine(temporary, 5_000)).toEqual({
      fetchedAtEpochMs: 5_000,
      sevenDayPercent: 7,
      sevenDayResetsAtEpochMs: 1_806_000_000_000,
    });
  });

  it("omits Codex session windows with missing, unsupported, duplicate, or malformed minute durations", () => {
    for (const rate_limits of [
      { primary: { used_percent: 42 } },
      { primary: { window_minutes: 60, used_percent: 42 } },
      { primary: { window_minutes: 300, used_percent: 42 }, secondary: { window_minutes: 300, used_percent: 43 } },
      { primary: { window_minutes: "300", used_percent: 42 } },
    ]) {
      expect(parseLastRateLimitsLine(JSON.stringify({ payload: { rate_limits } }), 5_000)).toBeUndefined();
    }
  });

  it("carries per-window resets_at (epoch seconds) as reset milliseconds", () => {
    const line = JSON.stringify({
      payload: {
        rate_limits: {
          primary: { window_minutes: 300, used_percent: 42, resets_at: 1_805_000_000 },
          secondary: { window_minutes: 10_080, used_percent: 12, resets_at: 1_806_000_000 },
        },
      },
    });

    expect(parseLastRateLimitsLine(line, 5_000)).toEqual({
      fetchedAtEpochMs: 5_000,
      fiveHourPercent: 42,
      sevenDayPercent: 12,
      fiveHourResetsAtEpochMs: 1_805_000_000_000,
      sevenDayResetsAtEpochMs: 1_806_000_000_000,
    });
  });

  it("returns undefined when no usable rate_limits line exists", () => {
    expect(parseLastRateLimitsLine(JSON.stringify({ type: "other" }), 5_000)).toBeUndefined();
    expect(parseLastRateLimitsLine("", 5_000)).toBeUndefined();
    expect(
      parseLastRateLimitsLine(
        JSON.stringify({ payload: { rate_limits: { primary: { window_minutes: 300, used_percent: "not-a-number" } } } }),
        5_000,
      ),
    ).toBeUndefined();
  });
});

describe("action lifecycle, scheduler handoff, and renderer states", () => {
  const keyFeedbackCases = [
    {
      expectedAlerts: 0,
      expectedImageNeedles: ['data-part="balance-value"', "42"],
      expectedOks: 1,
      name: "fresh output as OK feedback",
      outputFor: ({ keyParts, schedulerKey }: { readonly keyParts: SchedulerKeyParts; readonly schedulerKey: string }): SchedulerOutput => ({
        activeRefCount: 1,
        displayState: "fresh",
        inFlight: false,
        refreshIntervalSeconds: 600,
        schedulerKey,
        snapshot: balanceSnapshot(keyParts),
      }),
    },
    {
      expectedAlerts: 0,
      expectedImageNeedles: ['data-part="stale-badge"'],
      expectedOks: 0,
      name: "stale output as no key feedback",
      outputFor: ({ keyParts, schedulerKey }: { readonly keyParts: SchedulerKeyParts; readonly schedulerKey: string }): SchedulerOutput => ({
        activeRefCount: 1,
        backoff: {
          attempt: 1,
          baseDelayMs: 60_000,
          class: "rate-limit",
          delayMs: 60_000,
          nextRetryAtEpochMs: 60_000,
        },
        displayState: "stale",
        failure: rateLimitedFailure(),
        inFlight: false,
        refreshIntervalSeconds: 600,
        schedulerKey,
        snapshot: balanceSnapshot(keyParts),
        staleReason: "refresh-failed",
      }),
    },
    {
      expectedAlerts: 1,
      expectedImageNeedles: ['data-part="center-message"', "rate", "limited"],
      expectedOks: 0,
      name: "rate-limited output as alert feedback",
      outputFor: ({ schedulerKey }: { readonly keyParts: SchedulerKeyParts; readonly schedulerKey: string }): SchedulerOutput => ({
        activeRefCount: 1,
        displayState: "rate-limited",
        failure: rateLimitedFailure(),
        inFlight: false,
        refreshIntervalSeconds: 600,
        schedulerKey,
      }),
    },
  ] as const;

  it.each(keyFeedbackCases)("maps key-down $name", async ({ expectedAlerts, expectedImageNeedles, expectedOks, outputFor }) => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-key-feedback", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const schedulerKey = serializeSchedulerKey(keyParts);
    scheduler.refreshOutput = outputFor({ keyParts, schedulerKey });

    await shell.handleKeyDown("balance", action);

    expect(action.alerts).toBe(expectedAlerts);
    expect(action.oks).toBe(expectedOks);
    for (const needle of expectedImageNeedles) {
      expect(decodeURIComponent(action.images.at(-1) ?? "")).toContain(needle);
    }
  });

  it("activates scheduler entries on appear and routes manual refresh through scheduler.refresh", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-refresh", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const schedulerKey = serializeSchedulerKey(keyParts);

    scheduler.refreshOutput = {
      activeRefCount: 1,
      backoff: {
        attempt: 1,
        baseDelayMs: 60_000,
        class: "rate-limit",
        delayMs: 60_000,
        nextRetryAtEpochMs: 60_000,
      },
      displayState: "stale",
      failure: createSanitizedFailure({
        category: "rate-limited",
        diagnostics: {
          boundary: "streamdeck-test",
          reasonCode: "rate-limited",
        },
      }),
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey,
      snapshot: balanceSnapshot(keyParts),
      staleReason: "refresh-failed",
    };

    await shell.handleKeyDown("balance", action);

    expect(scheduler.lastRefreshKey()).toBe(schedulerKey);
    expect(scheduler.refreshCountFor(schedulerKey)).toBe(1);
    expect(decodeURIComponent(action.images.at(-1) ?? "")).toContain('data-part="stale-badge"');
    expect(action.oks).toBe(0);
  });

  it("deactivates the prior scheduler entry when received settings become invalid", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-invalid-settings", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const schedulerKey = activeSchedulerKey(scheduler, action.id);

    await shell.handleDidReceiveSettings("balance", action, {
      ...balanceSettings,
      apiKey: RAW_NEEDLES.apiKey,
    });
    await shell.handleWillDisappear({ id: action.id });

    expect(scheduler.lastDeactivationFor(action.id)).toEqual({
      instanceId: action.id,
      schedulerKey,
    });
    expect(scheduler.isActivatedFor(action.id)).toBe(false);
    expect(action.alerts).toBe(1);
  });

  it("deactivates scheduler entries on disappear", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-disappear", usageSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("usage", action, usageSettings);
    const schedulerKey = activeSchedulerKey(scheduler, action.id);
    await shell.handleWillDisappear({ id: action.id });

    expect(scheduler.lastDeactivationFor(action.id)).toEqual({
      instanceId: action.id,
      schedulerKey,
    });
    expect(scheduler.isActivatedFor(action.id)).toBe(false);
  });

  it("renders fresh, stale, degraded, and not-evaluated states distinctly from DisplayRendererInput only", () => {
    const freshNotEvaluated: DisplayRendererInput = {
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Claude Code · 5h",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueLabel: "used",
      progressPercent: 99,
      valueText: "99 tokens",
    };
    const stale: DisplayRendererInput = {
      ...freshNotEvaluated,
      displayState: "stale",
      freshness: "stale",
      stale: true,
      staleReason: "age-stale",
      valueText: "$42.00",
      fetchedAtEpochMs: 1_699_999_000_000,
    };
    const degraded: DisplayRendererInput = {
      displayState: "settings-invalid",
      freshness: "degraded",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueText: "Settings invalid",
    };

    const renderedAt = 1_700_000_000_000;
    const svgFor = (input: DisplayRendererInput): string => decodeURIComponent(renderDisplayInput(input, renderedAt).image);
    expect(svgFor(freshNotEvaluated)).toContain("#1a1d21");
    expect(svgFor(freshNotEvaluated)).toContain("Claude Code · 5h");
    expect(svgFor(freshNotEvaluated)).toContain('data-part="gauge-fill"');
    expect(svgFor(freshNotEvaluated)).toContain("#2ecc71");
    expect(svgFor(stale)).toContain('data-part="stale-badge"');
    expect(svgFor(degraded)).toContain("settings");
    expect(svgFor(degraded)).toContain("invalid");
  });

  it("shows the stale badge and reset countdown together for a fresh local-fallback snapshot", () => {
    const fallbackFresh: DisplayRendererInput = {
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Codex · 5h",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueLabel: "used",
      progressPercent: 61,
      valueText: "61 used",
      sourceFallback: true,
      fetchedAtEpochMs: 1_699_999_000_000,
      resetsAtEpochMs: 1_700_003_000_000,
    };

    const rendered = decodeURIComponent(renderDisplayInput(fallbackFresh, 1_700_000_000_000).image);
    // Local-fallback honesty and restored reset countdown render together.
    expect(rendered).toContain('data-part="stale-badge"');
    expect(rendered).toContain('data-part="reset-line"');
    expect(rendered).toContain("50m");
    expect(rendered).toContain('data-part="gauge-fill"');
  });

  it("renders the Codex resets key as a plain count with a reset-credit countdown and NO gauge", () => {
    const now = 1_700_000_000_000;
    // The reset-credit countdown reuses the shared reset-marker breakdown: `Xd Yh` at a day or more,
    // `Xh YYm` under a day (minutes zero-padded), `Xm` under an hour.
    const breakdowns: ReadonlyArray<readonly [number, string]> = [
      [5 * 86_400_000 + 3 * 3_600_000, "5d 3h"],
      [3 * 3_600_000 + 5 * 60_000, "3h 05m"],
      [45 * 60_000, "45m"],
    ];
    for (const [deltaMs, expectedCountdown] of breakdowns) {
      const resetsInput: DisplayRendererInput = {
        displayState: "fresh",
        freshness: "fresh",
        headerLabel: "Codex · Resets",
        rendererSeverityState: "normal",
        severity: "not-evaluated",
        stale: false,
        valueLabel: "available",
        valueText: "2",
        displayBasis: "remaining-value",
        fetchedAtEpochMs: now,
        resetsAtEpochMs: now + deltaMs,
      };

      const rendered = decodeURIComponent(renderDisplayInput(resetsInput, now).image);
      // Prominent plain count via the balance-style body, reset-credit countdown under it, NO gauge.
      expect(rendered).toContain('data-part="balance-value"');
      expect(rendered).toContain(">2<");
      expect(rendered).toContain('data-part="reset-marker"');
      expect(rendered).toContain(expectedCountdown);
      expect(rendered).not.toContain('data-part="gauge-fill"');
    }
  });

  it("renders the Codex resets key with no countdown when no reset-credit expiry is present", () => {
    const resetsInput: DisplayRendererInput = {
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Codex · Resets",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueLabel: "available",
      valueText: "0",
      displayBasis: "remaining-value",
      fetchedAtEpochMs: 1_700_000_000_000,
    };

    const rendered = decodeURIComponent(renderDisplayInput(resetsInput, 1_700_000_000_000).image);
    expect(rendered).toContain(">0<");
    expect(rendered).not.toContain('data-part="reset-marker"');
    expect(rendered).not.toContain('data-part="gauge-fill"');
  });

  it("renders the active credit-spend key as a percent gauge with a $used/$cap money line, NO reset line", () => {
    const now = 1_700_000_000_000;
    const activeInput: DisplayRendererInput = {
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Claude · Credits",
      rendererSeverityState: "normal",
      severity: "healthy",
      stale: false,
      valueLabel: "used",
      valueText: "0%",
      progressPercent: 0,
      displayBasis: "current-period-value",
      secondaryLine: "CA$0.00 / CA$25.00",
      fetchedAtEpochMs: now,
    };

    const rendered = decodeURIComponent(renderDisplayInput(activeInput, now).image);
    // The spend gauge: percent number + gauge bar (like a usage-percent key) with the $used/$cap money
    // pair on the dim secondary line INSTEAD of a reset countdown.
    expect(rendered).toContain('data-part="gauge-fill"');
    expect(rendered).toContain(">0%<");
    expect(rendered).toContain('data-part="secondary-line"');
    expect(rendered).toContain("CA$0.00 / CA$25.00");
    expect(rendered).not.toContain('data-part="reset-line"');
  });

  it("renders the off / out-of-credits credit-spend status keys as a neutral (dim) word, never a green 0% gauge", () => {
    const now = 1_700_000_000_000;
    const statusInput = (valueText: string): DisplayRendererInput => ({
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Claude · Credits",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueLabel: "",
      valueText,
      displayBasis: "current-period-value",
      statusTone: "neutral",
      fetchedAtEpochMs: now,
    });

    for (const word of ["Off", "Out"]) {
      const rendered = decodeURIComponent(renderDisplayInput(statusInput(word), now).image);
      // A non-gauge status word in the neutral dim tone — NOT the healthy green a not-evaluated
      // severity would otherwise give, NOT a gauge, and no money line.
      expect(rendered).toContain('data-part="balance-value"');
      expect(rendered).toContain(`>${word}<`);
      expect(rendered).toContain("#9aa0a6");
      expect(rendered).not.toContain("#2ecc71");
      expect(rendered).not.toContain('data-part="gauge-fill"');
      expect(rendered).not.toContain('data-part="secondary-line"');
    }
  });

  it("renders the out-of-credits credit-spend key in critical red when auto-reload is on (the burn condition)", () => {
    const now = 1_700_000_000_000;
    const criticalOut: DisplayRendererInput = {
      displayState: "fresh",
      freshness: "fresh",
      headerLabel: "Claude · Credits",
      rendererSeverityState: "normal",
      severity: "not-evaluated",
      stale: false,
      valueLabel: "",
      valueText: "Out",
      displayBasis: "current-period-value",
      statusTone: "critical",
      fetchedAtEpochMs: now,
    };

    const rendered = decodeURIComponent(renderDisplayInput(criticalOut, now).image);
    expect(rendered).toContain(">Out<");
    expect(rendered).toContain("#e01e1e");
    expect(rendered).not.toContain('data-part="gauge-fill"');
  });
});

/** A real event-loop macrotask: lets a freshly-forked render fiber run its immediate render and arm its
 * `Schedule.fixed` sleep BEFORE the first `TestClock.adjust` (the fork/adjust ordering seam). */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("render fiber, ManagedRuntime composition root, and Logger install", () => {
  it("runs the render fiber on the fixed 30s cadence via Effect.repeat(Schedule.fixed) on the Effect Clock", async () => {
    const runtime = ManagedRuntime.make(TestContext.TestContext);
    let renders = 0;
    const stop = startRenderLoop({
      render: async () => {
        renders += 1;
      },
      runtime,
    });

    // The freshly-forked fiber renders once immediately and arms the 30s Schedule.fixed sleep.
    await macrotask();
    expect(renders).toBe(1);

    // Each 30s of virtual time fires exactly one render; advancing less than the interval fires none.
    await runtime.runPromise(TestClock.adjust(Duration.seconds(30)));
    await macrotask();
    expect(renders).toBe(2);

    await runtime.runPromise(TestClock.adjust(Duration.seconds(15)));
    await macrotask();
    expect(renders).toBe(2);

    await runtime.runPromise(TestClock.adjust(Duration.seconds(15)));
    await macrotask();
    expect(renders).toBe(3);

    // The returned stop interrupts the fiber: further virtual time fires no more renders (no leaked loop).
    stop();
    await macrotask();
    const rendersAfterStop = renders;
    await runtime.runPromise(TestClock.adjust(Duration.seconds(120)));
    await macrotask();
    expect(renders).toBe(rendersAfterStop);

    await runtime.dispose();
  });

  it("surfaces each active key's current scheduler.getOutput on the render tick without a manual refresh (push model)", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-render-tick", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const imagesBefore = action.images.length;

    // A background poll fiber has since produced a fresh balance snapshot; the render tick reads it from
    // getOutput (the role the retired 1s runDue scan used to play) — no manual refresh, no cached output.
    scheduler.getOutputResult = {
      activeRefCount: 1,
      displayState: "fresh",
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey: serializeSchedulerKey(keyParts),
      snapshot: balanceSnapshot(keyParts),
    };

    await shell.renderActiveFromScheduler();

    expect(action.images.length).toBeGreaterThan(imagesBefore);
    expect(decodeURIComponent(action.images.at(-1) ?? "")).toContain("42");
  });

  it("renders a manual refresh immediately through the SDK callback, not waiting for the render tick", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-prompt-render", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const schedulerKey = serializeSchedulerKey(keyParts);
    const imagesBefore = action.images.length;
    scheduler.refreshOutput = {
      activeRefCount: 1,
      displayState: "fresh",
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey,
      snapshot: balanceSnapshot(keyParts),
    };

    await shell.handleKeyDown("balance", action);

    // The key press drove refresh + a synchronous render (no render-tick / 30s wait needed).
    expect(scheduler.refreshCountFor(schedulerKey)).toBe(1);
    expect(action.images.length).toBeGreaterThan(imagesBefore);
    expect(decodeURIComponent(action.images.at(-1) ?? "")).toContain("42");
  });

  it("installs the sanitizing Effect Logger via Logger.replace so effects log through the sink with no raw cause or secret", async () => {
    const events: SanitizedLogEvent[] = [];
    const sink: StreamDeckLogSink = {
      write: (event) => {
        events.push(event);
      },
    };
    const runtime = createAppManagedRuntime(sink);

    await runtime.runPromise(Effect.logInfo("render-fiber-armed"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "info", sanitized: true });
    expect(events[0]?.message).toBe("render-fiber-armed");

    // A Redacted secret logged on the runtime never surfaces its inner value.
    events.length = 0;
    await runtime.runPromise(Effect.logWarning("credential", Redacted.make("Bearer sk-secret-fixture")));
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
    expect(events[0]?.message).toContain("[redacted]");
    expect(events[0]?.message).not.toContain("sk-secret-fixture");

    await runtime.dispose();
  });

  it("creates a disposable ManagedRuntime composition root and refuses work after disposal", async () => {
    const sink: StreamDeckLogSink = { write: () => undefined };
    const runtime = createAppManagedRuntime(sink);

    await expect(runtime.runPromise(Effect.succeed("ready"))).resolves.toBe("ready");

    await runtime.dispose();

    await expect(runtime.runPromise(Effect.succeed("after-dispose"))).rejects.toBeDefined();
  });
});

describe("scheduler output-change notification -> prompt re-render", () => {
  it("re-renders the affected key from getOutput the moment the scheduler notifies, with no manual refresh or 30s render tick", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-output-change", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const schedulerKey = serializeSchedulerKey(keyParts);
    const imagesBefore = action.images.length;

    // A background poll fiber has produced a fresh snapshot and notified the shell (push, not the tick).
    scheduler.getOutputResult = {
      activeRefCount: 1,
      displayState: "fresh",
      inFlight: false,
      refreshIntervalSeconds: 600,
      schedulerKey,
      snapshot: balanceSnapshot(keyParts),
    };
    scheduler.emitOutputChanged(schedulerKey);
    // The handler defers one microtask before touching getOutput/rendering (no fiber re-entrancy).
    await macrotask();

    expect(action.images.length).toBeGreaterThan(imagesBefore);
    expect(decodeURIComponent(action.images.at(-1) ?? "")).toContain("42");
  });

  it("ignores an output-change notification for a key with no active action", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-unrelated-change", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const imagesBefore = action.images.length;

    scheduler.emitOutputChanged("balance::provider=fal::not-an-active-key");
    await macrotask();

    expect(action.images.length).toBe(imagesBefore);
  });

  it("stops re-rendering from notifications after the shell shuts down (unsubscribes)", async () => {
    const scheduler = new FakeScheduler();
    const action = new FakeAction("action-change-after-shutdown", balanceSettings);
    const { shell } = createShell({ scheduler });

    await shell.handleWillAppear("balance", action, balanceSettings);
    const keyParts = activeSchedulerKeyParts(scheduler, action.id);
    const schedulerKey = serializeSchedulerKey(keyParts);

    await shell.shutdown();
    const imagesBefore = action.images.length;
    scheduler.emitOutputChanged(schedulerKey);
    await macrotask();

    expect(action.images.length).toBe(imagesBefore);
  });
});

describe("sanitized SDK logging sink", () => {
  it("writes sanitized log events to the SDK logger without raw message or context values", async () => {
    const calls: Array<{ readonly level: string; readonly message: string; readonly context: unknown }> = [];
    const sink = createSdkLogSink({
      debug: (message, context) => calls.push({ context, level: "debug", message }),
      error: (message, context) => calls.push({ context, level: "error", message }),
      info: (message, context) => calls.push({ context, level: "info", message }),
      warn: (message, context) => calls.push({ context, level: "warn", message }),
    });

    await writeShellLog(sink, {
      context: {
        correlationId: RAW_NEEDLES.account,
        providerId: "fal",
        reasonCode: RAW_NEEDLES.account,
      },
      eventName: "authorization failure",
      level: "warn",
      message: `Failed with ${RAW_NEEDLES.token} for ${RAW_NEEDLES.account}`,
    });

    expect(calls).toHaveLength(1);
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.account);
  });

  it("keeps SDK logger method calls bound to the logger instance", async () => {
    const calls: string[] = [];
    const logger = {
      debug(message: string) {
        calls.push(`${this.prefix}:${message}`);
      },
      error(message: string) {
        calls.push(`${this.prefix}:${message}`);
      },
      info(message: string) {
        calls.push(`${this.prefix}:${message}`);
      },
      prefix: "sdk",
      warn(message: string) {
        calls.push(`${this.prefix}:${message}`);
      },
    };

    await writeShellLog(createSdkLogSink(logger), {
      eventName: "bound-call",
      level: "error",
      message: "message",
    });

    expect(calls).toEqual(["sdk:bound-call: message"]);
  });
});
