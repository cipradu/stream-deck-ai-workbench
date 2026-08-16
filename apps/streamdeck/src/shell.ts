import { buildBalanceRendererInput } from "@ai-workbench/action-balance";
import { buildStatusRendererInput, resolveStatusProviderOption } from "@ai-workbench/action-status";
import { buildUsageRendererInput } from "@ai-workbench/action-usage";
import type { ActionFamilyId, DisplayState, SchedulerKey, SeverityThresholdSet } from "@ai-workbench/contracts";
import type { DisplayRendererInput } from "@ai-workbench/display";
import type { SanitizedFailure } from "@ai-workbench/errors";
import type { StreamDeckLogSink } from "@ai-workbench/logging";
import type { Scheduler, SchedulerOutput } from "@ai-workbench/scheduler";
import {
  classifyActionSettingsChange,
  classifyGlobalSettingsChange,
  parseGlobalSettings,
  type GlobalSettingsChangeClassification,
  type GlobalSettingsAffectedCredentialProfile,
  type NormalizedActionSettingsView,
} from "@ai-workbench/settings";
import { Effect, Fiber, Schedule, type Duration, type ManagedRuntime } from "effect";

import { writeShellLog } from "./logging.js";
import { displayInputFromFailure, renderDisplayInput } from "./renderer.js";
import type { ProviderRequestRuntime } from "./runtime.js";
import { createSchedulerFetchForActionSettings } from "./scheduler-fetch.js";
import {
  legacySeverityProfileForBalanceInput,
  legacySeverityProfileForUsageInput,
  parseActionSettingsForFamily,
  upsertSeverityProfilePayload,
  withLegacyCredentialProfiles,
  type WritableActionSettings,
  type WritableSeverityProfile,
} from "./settings.js";

export interface StreamDeckActionPort {
  readonly id: string;
  readonly getSettings: () => Promise<unknown>;
  readonly setSettings: (settings: WritableActionSettings) => Promise<void>;
  readonly setImage: (image?: string) => Promise<void>;
  readonly setTitle: (title?: string) => Promise<void>;
  readonly showAlert: () => Promise<void>;
  readonly showOk: () => Promise<void>;
}

export interface GlobalSettingsPort {
  readonly read: () => Promise<unknown>;
  readonly write: (settings: unknown) => Promise<void>;
}

export interface StreamDeckShellOptions {
  readonly scheduler: Scheduler;
  readonly providerRequestRuntime: ProviderRequestRuntime;
  readonly globalSettings: GlobalSettingsPort;
  readonly logSink: StreamDeckLogSink;
  readonly now?: () => number;
}

interface ActiveAction {
  readonly familyId: ActionFamilyId;
  readonly action: StreamDeckActionPort;
  readonly settings: NormalizedActionSettingsView;
}

type KeyFeedback = "alert" | "none" | "ok";

export class StreamDeckShell {
  private readonly scheduler: Scheduler;
  private readonly providerRequestRuntime: ProviderRequestRuntime;
  private readonly globalSettings: GlobalSettingsPort;
  private readonly logSink: StreamDeckLogSink;
  private readonly now: () => number;
  private readonly activeActions = new Map<string, ActiveAction>();
  /** Baseline for classifying Property Inspector global-settings writes (legacy-mapped shape). */
  private globalSettingsBaseline: unknown;
  private globalSettingsBaselinePrimed = false;
  /** Tears down the scheduler output-change subscription on shutdown. */
  private readonly unsubscribeOutputChanged: () => void;

  constructor(options: StreamDeckShellOptions) {
    this.scheduler = options.scheduler;
    this.providerRequestRuntime = options.providerRequestRuntime;
    this.globalSettings = options.globalSettings;
    this.logSink = options.logSink;
    // Imperative-shell wall-clock: Effect `Clock` owns time INSIDE the foundation, but this
    // `now` is read only by the SDK Promise render callbacks (renderSchedulerOutput/renderFailure), which
    // are not Effect programs — so it stays a plain wall-clock at the imperative edge. The `options.now`
    // seam is kept for deterministic render tests; no `Date.now` lives in Effect code.
    this.now = options.now ?? Date.now;
    // Subscribe to the scheduler's push notification: when a background poll or a manual
    // refresh settles a key, re-render THAT key immediately so its fetched value surfaces within one poll
    // round-trip instead of waiting for the periodic render tick.
    this.unsubscribeOutputChanged = this.scheduler.onOutputChanged((schedulerKey) => {
      this.handleSchedulerOutputChanged(schedulerKey);
    });
  }

  private async log(
    level: "info" | "warn",
    eventName: string,
    message: string,
    context: {
      readonly actionFamilyId?: ActionFamilyId;
      readonly providerId?: string;
      readonly reasonCode?: string;
      readonly retryClass?: string;
    },
  ): Promise<void> {
    await writeShellLog(this.logSink, {
      context,
      eventName,
      level,
      message,
    });
  }

  async handleWillAppear(familyId: ActionFamilyId, action: StreamDeckActionPort, rawSettings: unknown): Promise<void> {
    const parsed = parseActionSettingsForFamily(familyId, rawSettings);
    if (!parsed.ok) {
      await this.renderFailure(action, parsed.failure);
      return;
    }

    await this.log("info", "streamdeck-action-appeared", "Action appeared on key.", {
      actionFamilyId: familyId,
      providerId: parsed.value.providerId,
      reasonCode: "will-appear",
    });
    await this.migrateLegacySeverityFloors(familyId, rawSettings);
    await this.activateParsedSettings(familyId, action, parsed.value);
  }

  /**
   * Old-plugin keys carried warn/critical floors in action settings. Balance keys
   * (every vendor) and the lower-bound Usage credits category migrate into a
   * provider/category-scoped severity profile in global settings so the referenced
   * thresholds resolve (best-effort compat path).
   */
  private async migrateLegacySeverityFloors(familyId: ActionFamilyId, rawSettings: unknown): Promise<void> {
    if (familyId === "status") {
      return;
    }
    const profile =
      familyId === "balance"
        ? legacySeverityProfileForBalanceInput(rawSettings)
        : legacySeverityProfileForUsageInput(rawSettings);
    if (profile === undefined) {
      return;
    }

    try {
      const previous = await this.globalSettings.read();
      if (severityProfileAlreadyPresent(previous, profile)) {
        return;
      }
      const merged = upsertSeverityProfilePayload(previous, profile);
      const parsedGlobalSettings = parseGlobalSettings(merged);
      if (!parsedGlobalSettings.ok) {
        return;
      }
      // Write the validated merged payload as-is: Property Inspector-owned
      // fields (zaiApiKey, balanceApiKeys.<vendor>) must survive plugin-side
      // writes so the PI keeps showing configured keys.
      await this.globalSettings.write(merged);
      this.globalSettingsBaseline = withLegacyCredentialProfiles(merged);
    } catch {
      // Best-effort migration; the key still renders without user thresholds.
    }
  }

  async handleWillDisappear(action: Pick<StreamDeckActionPort, "id">): Promise<void> {
    const active = this.activeActions.get(action.id);
    if (active === undefined) {
      return;
    }

    this.scheduler.deactivate({
      instanceId: action.id,
      schedulerKey: active.settings.schedulerKey,
    });
    this.activeActions.delete(action.id);
    await this.log("info", "streamdeck-action-disappeared", "Action disappeared from key.", {
      actionFamilyId: active.familyId,
      providerId: active.settings.providerId,
      reasonCode: "will-disappear",
    });
    await this.log("info", "streamdeck-scheduler-deactivated", "Scheduler deactivated an action instance.", {
      actionFamilyId: active.familyId,
      providerId: active.settings.providerId,
      reasonCode: "instance-deactivated",
    });
  }

  async handleDidReceiveSettings(familyId: ActionFamilyId, action: StreamDeckActionPort, rawSettings: unknown): Promise<void> {
    const parsed = parseActionSettingsForFamily(familyId, rawSettings);
    if (!parsed.ok) {
      await this.log("warn", "streamdeck-action-settings-rejected", parsed.failure.safePublicMessage, {
        actionFamilyId: familyId,
        reasonCode: parsed.failure.diagnostics.reasonCode,
      });
      this.deactivateAction(action.id);
      await this.renderFailure(action, parsed.failure);
      return;
    }

    await this.log("info", "streamdeck-action-settings-accepted", "Action settings validated.", {
      actionFamilyId: familyId,
      providerId: parsed.value.providerId,
      reasonCode: "settings-change",
    });
    await this.migrateLegacySeverityFloors(familyId, rawSettings);

    const previous = this.activeActions.get(action.id);
    if (previous === undefined || previous.settings.schedulerKey !== parsed.value.schedulerKey) {
      if (previous !== undefined) {
        this.scheduler.deactivate({
          instanceId: action.id,
          schedulerKey: previous.settings.schedulerKey,
        });
      }
      await this.activateParsedSettings(familyId, action, parsed.value);
      return;
    }

    const change = classifyActionSettingsChange(previous.settings, parsed.value);
    this.activeActions.set(action.id, {
      action,
      familyId,
      settings: parsed.value,
    });
    const output = await this.scheduler.handleActionSettingsChange({
      change,
      refreshIntervalSeconds: parsed.value.refreshIntervalSeconds,
      schedulerKey: parsed.value.schedulerKey,
    });
    await this.renderSchedulerOutput(action, parsed.value, output);
  }

  async handleKeyDown(familyId: ActionFamilyId, action: StreamDeckActionPort): Promise<void> {
    const active = await this.ensureActive(familyId, action);
    if (active === undefined) {
      return;
    }

    await this.log("info", "streamdeck-key-down", "Key press received; manual refresh requested.", {
      actionFamilyId: familyId,
      providerId: active.settings.providerId,
      reasonCode: "manual-refresh",
    });
    const output = await this.scheduler.refresh(active.settings.schedulerKey);
    await this.renderSchedulerOutput(action, active.settings, output);
    const feedback = keyFeedbackForDisplayState(output.displayState);
    if (feedback === "ok") {
      await action.showOk();
    } else if (feedback === "alert") {
      await action.showAlert();
    }
  }

  /**
   * The Property Inspector saves exclusively through sdpi `setting=` bindings:
   * the plugin only
   * logs the appearance; settings arrive through the did-receive events and
   * the central settings boundary validates them there.
   */
  async handlePropertyInspectorDidAppear(familyId: ActionFamilyId): Promise<void> {
    await this.log("info", "streamdeck-property-inspector-appeared", "Property Inspector appeared.", {
      actionFamilyId: familyId,
      reasonCode: "property-inspector-did-appear",
    });
  }

  /** Seeds the change-classification baseline from the startup global-settings read. */
  primeGlobalSettingsBaseline(rawSettings: unknown): void {
    this.globalSettingsBaseline = withLegacyCredentialProfiles(rawSettings);
    this.globalSettingsBaselinePrimed = true;
  }

  /**
   * Handles Stream Deck's did-receive-global-settings event (fired when the
   * Property Inspector's `global`-bound fields save). Classifies the change
   * centrally and refetches exactly the affected provider keys — the old
   * plugin's paste-a-key-and-it-takes-effect-immediately behavior.
   */
  async handleGlobalSettingsChanged(rawSettings: unknown): Promise<void> {
    const next = withLegacyCredentialProfiles(rawSettings);
    const previous = this.globalSettingsBaseline;
    this.globalSettingsBaseline = next;
    if (!this.globalSettingsBaselinePrimed) {
      this.globalSettingsBaselinePrimed = true;
      return;
    }

    const change = classifyGlobalSettingsChange(previous, next);
    if (!change.ok) {
      await this.handleGlobalSettingsSchedulerChange(
        failClosedGlobalSettingsChange(),
        this.activeCredentialDependentSchedulerKeys(),
      );
      await this.log("warn", "streamdeck-global-settings-change-classification-failed", change.failure.safePublicMessage, {
        reasonCode: change.failure.diagnostics.reasonCode,
      });
      return;
    }

    await this.log("info", "streamdeck-global-settings-changed", "Global settings changed from the Property Inspector.", {
      reasonCode: change.value.kind,
    });
    if (change.value.kind === "unchanged") {
      return;
    }
    if (change.value.kind === "provider-source-affecting") {
      await Promise.all(
        change.value.affectedCredentialProfiles.map((profile) =>
          this.providerRequestRuntime.advanceCredentialGeneration(profile.profileId),
        ),
      );
    }
    await this.handleGlobalSettingsSchedulerChange(
      change.value,
      this.schedulerKeysAffectedByGlobalSettingsChange(change.value.affectedCredentialProfiles),
    );
  }

  async shutdown(): Promise<void> {
    // Drop the output-change subscription before tearing the scheduler down so no late
    // notification schedules a render against a shutting-down shell.
    this.unsubscribeOutputChanged();
    await this.scheduler.shutdown();
    this.activeActions.clear();
  }

  private async ensureActive(familyId: ActionFamilyId, action: StreamDeckActionPort): Promise<ActiveAction | undefined> {
    const active = this.activeActions.get(action.id);
    if (active !== undefined) {
      return active;
    }

    const parsed = parseActionSettingsForFamily(familyId, await action.getSettings());
    if (!parsed.ok) {
      await this.renderFailure(action, parsed.failure);
      return undefined;
    }
    await this.activateParsedSettings(familyId, action, parsed.value);
    return this.activeActions.get(action.id);
  }

  private async activateParsedSettings(
    familyId: ActionFamilyId,
    action: StreamDeckActionPort,
    settings: NormalizedActionSettingsView,
  ): Promise<void> {
    const output = this.scheduler.activate({
      fetch: createSchedulerFetchForActionSettings(settings, {
        logSink: this.logSink,
        readGlobalSettings: () => this.globalSettings.read(),
        sourceFlightRuntime: this.providerRequestRuntime.sourceFlightRuntime,
      }),
      instanceId: action.id,
      keyParts: settings.schedulerKeyParts,
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
    });
    this.activeActions.set(action.id, {
      action,
      familyId,
      settings,
    });
    await this.log("info", "streamdeck-scheduler-activated", "Scheduler activated an action instance.", {
      actionFamilyId: familyId,
      providerId: settings.providerId,
      reasonCode: "instance-activated",
    });
    await this.renderSchedulerOutput(action, settings, output);
  }

  private deactivateAction(actionId: string): void {
    const active = this.activeActions.get(actionId);
    if (active === undefined) {
      return;
    }

    this.scheduler.deactivate({
      instanceId: actionId,
      schedulerKey: active.settings.schedulerKey,
    });
    this.activeActions.delete(actionId);
  }

  private schedulerKeysAffectedByGlobalSettingsChange(
    affectedCredentialProfiles: readonly GlobalSettingsAffectedCredentialProfile[],
  ): readonly SchedulerKey[] {
    const affectedProfileKeys = new Set(affectedCredentialProfiles.map((profile) => credentialProfileIdentityKey(profile)));
    const schedulerKeys = new Set<SchedulerKey>();
    for (const active of this.activeActions.values()) {
      const credentialProfileRef = active.settings.credentialProfileRef;
      if (credentialProfileRef === undefined) {
        continue;
      }
      const activeProfileKey = credentialProfileIdentityKey({
        actionFamilyId: active.settings.familyId,
        credentialClass: credentialProfileRef.credentialClass,
        profileId: credentialProfileRef.profileId,
        providerId: active.settings.providerId,
      });
      if (affectedProfileKeys.has(activeProfileKey)) {
        schedulerKeys.add(active.settings.schedulerKey);
      }
    }
    return [...schedulerKeys];
  }

  private activeCredentialDependentSchedulerKeys(): readonly SchedulerKey[] {
    return [
      ...new Set(
        [...this.activeActions.values()]
          .filter((active) => active.settings.credentialProfileRef !== undefined)
          .map((active) => active.settings.schedulerKey),
      ),
    ];
  }

  private async handleGlobalSettingsSchedulerChange(
    change: GlobalSettingsChangeClassification,
    schedulerKeys: readonly SchedulerKey[],
  ): Promise<void> {
    if (schedulerKeys.length === 0) {
      return;
    }
    const outputs = await this.scheduler.handleGlobalSettingsChange({
      change,
      schedulerKeys,
    });
    await Promise.all(outputs.map((output) => this.renderActiveActionsForOutput(output)));
  }

  private async renderActiveActionsForOutput(output: SchedulerOutput): Promise<void> {
    const matching = [...this.activeActions.values()].filter((active) => active.settings.schedulerKey === output.schedulerKey);
    await Promise.all(matching.map((active) => this.renderSchedulerOutput(active.action, active.settings, output)));
  }

  private async renderSchedulerOutput(
    action: StreamDeckActionPort,
    settings: NormalizedActionSettingsView,
    output: SchedulerOutput,
    options?: { readonly quiet?: boolean },
  ): Promise<void> {
    try {
      let input: DisplayRendererInput;
      if (settings.familyId === "status") {
        const statusOption = resolveStatusProviderOption(settings.providerId);
        if (statusOption === undefined) {
          await this.log("warn", "streamdeck-key-render-failed", "Key render failed.", {
            actionFamilyId: settings.familyId,
            providerId: settings.providerId,
            reasonCode: "status-provider-unavailable",
          });
          return;
        }
        input = buildStatusRendererInput({
          providerId: statusOption.providerId,
          schedulerOutput: output,
        });
      } else if (settings.familyId === "usage") {
        const thresholds = await this.severityThresholdsForSettings(settings);
        input = buildUsageRendererInput({
          actionSettings: settings,
          schedulerOutput: output,
          ...(thresholds === undefined ? {} : { thresholds }),
        });
      } else if (settings.familyId === "balance") {
        const thresholds = await this.severityThresholdsForSettings(settings);
        input = buildBalanceRendererInput({
          actionSettings: settings,
          schedulerOutput: output,
          now: this.now(),
          ...(thresholds === undefined ? {} : { thresholds }),
        });
      } else {
        await this.log("warn", "streamdeck-key-render-failed", "Key render failed.", {
          reasonCode: "action-family-invalid",
        });
        return;
      }
      const rendered = renderDisplayInput(input, this.now());
      // Old working layout renders everything inside the key image; a text
      // title would overlay it, so no title is set.
      await action.setImage(rendered.image);
      if (options?.quiet !== true) {
        await this.log("info", "streamdeck-key-render-succeeded", "Key render completed.", {
          actionFamilyId: settings.familyId,
          providerId: settings.providerId,
          reasonCode: output.displayState,
        });
      }
    } catch {
      await this.log("warn", "streamdeck-key-render-failed", "Key render failed.", {
        actionFamilyId: settings.familyId,
        providerId: settings.providerId,
        reasonCode: "render-failed",
      });
    }
  }

  /**
   * The push-model render tick: re-renders every active key from the
   * scheduler's CURRENT output (`getOutput`) with a fresh clock. This both SURFACES the results of the
   * per-key poll fibers' background fetches — the role the retired 1s `runDue` scan used to play — and
   * keeps countdowns / stale-age badges moving between polls. No fetch happens here; `getOutput` only
   * reads the fiber-maintained state. Driven by the render fiber's fixed cadence (see `startRenderLoop`).
   */
  async renderActiveFromScheduler(): Promise<void> {
    await Promise.all(
      [...this.activeActions.values()].map(async (active) => {
        const output = this.scheduler.getOutput(active.settings.schedulerKey);
        await this.renderSchedulerOutput(active.action, active.settings, output, { quiet: true });
      }),
    );
  }

  /**
   * Scheduler output-change notification handler. Fired from the scheduler's poll fiber the
   * instant a background poll or a manual-refresh poll settles a key. It is fire-and-forget: it kicks off a
   * deferred single-key re-render and returns immediately, so the poll fiber never blocks on render I/O.
   * The actual render is deferred (see {@link renderKeyOnOutputChanged}) so it runs OFF the poll fiber's
   * synchronous step — no re-entrancy into the scheduler runtime on the fiber's stack.
   */
  private handleSchedulerOutputChanged(schedulerKey: SchedulerKey): void {
    void this.renderKeyOnOutputChanged(schedulerKey);
  }

  /**
   * Re-renders every active key matching `schedulerKey` from the scheduler's CURRENT `getOutput`.
   * This is what makes a manual refresh feel instant (~one poll round-trip) and lets a
   * background poll surface the moment it completes, rather than on the ≤30s render tick. It first yields a
   * microtask (`await Promise.resolve()`) so that reading `getOutput` (which runs the scheduler runtime)
   * and the render happen AFTER the poll fiber's notification step returns — never nested inside it.
   * Renders quietly (like the periodic tick) so poll-driven re-renders do not spam the render log.
   */
  private async renderKeyOnOutputChanged(schedulerKey: SchedulerKey): Promise<void> {
    await Promise.resolve();
    const matching = [...this.activeActions.values()].filter((active) => active.settings.schedulerKey === schedulerKey);
    if (matching.length === 0) {
      return;
    }
    const output = this.scheduler.getOutput(schedulerKey);
    await Promise.all(matching.map((active) => this.renderSchedulerOutput(active.action, active.settings, output, { quiet: true })));
  }

  /** Resolves the referenced user severity profile (old floors) from global settings, if any. */
  private async severityThresholdsForSettings(
    settings: NormalizedActionSettingsView,
  ): Promise<SeverityThresholdSet | undefined> {
    const profileRef = settings.severityProfileRef;
    if (profileRef === undefined) {
      return undefined;
    }

    try {
      const parsed = parseGlobalSettings(await this.globalSettings.read());
      if (!parsed.ok) {
        return undefined;
      }
      return parsed.value.severityProfiles.find((profile) => profile.profileId === profileRef.profileId)?.thresholds;
    } catch {
      return undefined;
    }
  }

  private async renderFailure(action: StreamDeckActionPort, failure: SanitizedFailure): Promise<void> {
    const rendered = renderDisplayInput(displayInputFromFailure(failure), this.now());
    await action.setImage(rendered.image);
    await action.showAlert();
    await writeShellLog(this.logSink, {
      context: {
        reasonCode: failure.diagnostics.reasonCode,
        retryClass: failure.retryClass,
      },
      eventName: "streamdeck-action-failure",
      level: "warn",
      message: failure.safePublicMessage,
    });
  }
}

function credentialProfileIdentityKey(
  profile: Pick<GlobalSettingsAffectedCredentialProfile, "actionFamilyId" | "credentialClass" | "profileId" | "providerId">,
): string {
  return JSON.stringify([profile.actionFamilyId, profile.providerId, profile.credentialClass, profile.profileId]);
}

function severityProfileAlreadyPresent(previous: unknown, profile: WritableSeverityProfile): boolean {
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) {
    return false;
  }
  const profiles = (previous as { severityProfiles?: unknown }).severityProfiles;
  if (!Array.isArray(profiles)) {
    return false;
  }
  return profiles.some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { profileId?: unknown }).profileId === profile.profileId &&
      JSON.stringify((candidate as { thresholds?: unknown }).thresholds) === JSON.stringify(profile.thresholds),
  );
}

function failClosedGlobalSettingsChange(): GlobalSettingsChangeClassification {
  return {
    affectedCredentialProfiles: [],
    bypassBackoffAllowed: true,
    displayOnly: false,
    kind: "provider-source-affecting",
    providerRefetchRequired: true,
    reasons: ["global-settings-classification-failed"],
  };
}

function keyFeedbackForDisplayState(state: DisplayState): KeyFeedback {
  switch (state) {
    case "fresh":
      return "ok";
    case "stale":
      return "none";
    case "missing-credentials":
    case "invalid-credentials":
    case "unauthorized-expired":
    case "rate-limited":
    case "timeout":
    case "network-failure":
    case "provider-unavailable":
    case "validation-drift":
    case "unsupported-capability":
    case "no-data-yet":
    case "not-implemented":
    case "settings-invalid":
    case "unknown-sanitized-failure":
      return "alert";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * The periodic render cadence: on this fixed interval the render tick advances
 * time-derived elements (countdowns, stale-age badges, last-checked clock) and re-reads
 * `scheduler.getOutput` for every active key as a backstop — without a fetch. Poll-driven results do NOT
 * wait for this interval; they surface promptly through the scheduler's output-change notification.
 * Replaces the old 30s render `setInterval`.
 */
const RENDER_TICK_INTERVAL: Duration.DurationInput = "30 seconds";

/**
 * Starts the PERIODIC render fiber. Converts the old 30s render `setInterval` into an
 * `Effect.repeat(render, Schedule.fixed(...))` fiber forked onto the shared ManagedRuntime, so the tick
 * runs on the Effect `Clock` (no `setInterval`/`Date.now`/`setTimeout`) and shares the runtime's
 * sanitizing Logger. The old 1s scheduler `runDue` `setInterval` is REMOVED: the per-key fibers
 * self-schedule. This fiber owns only the poll-INDEPENDENT refresh — advancing time-derived elements
 * (countdowns, stale-age badges, last-checked clock) and re-reading `scheduler.getOutput` for every
 * active key as a backstop. Poll-DRIVEN output no longer waits for this tick: the scheduler's
 * output-change notification re-renders the affected key the instant a background poll or a
 * manual-refresh poll settles. A manual refresh / settings change also draws an immediate render through
 * the SDK callback, but that render ACKNOWLEDGES the current (pre-poll) state it receives synchronously —
 * the freshly-fetched value surfaces a poll round-trip later via the notification, not from that
 * acknowledgement render. A stray render defect is swallowed so the loop never dies; interruption still
 * propagates so the returned stop halts the fiber.
 */
export function startRenderLoop(input: {
  readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
  readonly render: () => Promise<void>;
  readonly interval?: Duration.DurationInput;
}): () => void {
  const interval = input.interval ?? RENDER_TICK_INTERVAL;
  const tick = Effect.promise(() => input.render()).pipe(Effect.catchAllDefect(() => Effect.void));
  const fiber = input.runtime.runFork(Effect.repeat(tick, Schedule.fixed(interval)));
  return () => {
    void input.runtime.runFork(Fiber.interrupt(fiber));
  };
}
