import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { serializeSchedulerKey } from "../../../packages/contracts/src/index.js";
import type { StreamDeckLogSink } from "../../../packages/logging/src/index.js";
import type { AdapterSourceFlightRuntimeCapability } from "@ai-workbench/provider-adapters";
import type {
  Scheduler,
  SchedulerActivateInput,
  SchedulerDeactivateInput,
  SchedulerEffectFetch,
  SchedulerFetchRequest,
  SchedulerGlobalSettingsChangeInput,
  SchedulerOutput,
  SchedulerSettingsChangeInput,
} from "../../../packages/scheduler/src/index.js";
import { Effect, Fiber } from "effect";

import { createRuntimeServices, type ProviderRequestRuntime } from "../src/runtime.js";
import { StreamDeckShell, type GlobalSettingsPort, type StreamDeckActionPort } from "../src/shell.js";

vi.mock("../src/local-usage-sources.js", () => ({
  createLocalUsageSourceReaders: () => ({
    claudeCode: {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-local-credential" }),
    },
  }),
}));

class RecordingScheduler implements Scheduler {
  activation: SchedulerActivateInput | undefined;
  readonly activations: SchedulerActivateInput[] = [];
  readonly events: string[];
  private stopActiveFetch: (() => Promise<void>) | undefined;

  constructor(events: string[]) {
    this.events = events;
  }

  activate(input: SchedulerActivateInput): SchedulerOutput {
    this.activation = input;
    this.activations.push(input);
    return noDataOutput(serializeSchedulerKey(input.keyParts));
  }

  deactivate(input: SchedulerDeactivateInput): SchedulerOutput {
    return noDataOutput(input.schedulerKey);
  }

  async refresh(schedulerKey: string): Promise<SchedulerOutput> {
    return noDataOutput(schedulerKey);
  }

  async runDue(): Promise<readonly SchedulerOutput[]> {
    return [];
  }

  getOutput(schedulerKey: string): SchedulerOutput {
    return noDataOutput(schedulerKey);
  }

  async handleActionSettingsChange(input: SchedulerSettingsChangeInput): Promise<SchedulerOutput> {
    return noDataOutput(input.schedulerKey);
  }

  async handleGlobalSettingsChange(input: SchedulerGlobalSettingsChangeInput): Promise<readonly SchedulerOutput[]> {
    return input.schedulerKeys.map(noDataOutput);
  }

  onOutputChanged(): () => void {
    return () => undefined;
  }

  setActiveFetchStop(stop: () => Promise<void>): void {
    this.stopActiveFetch = stop;
  }

  async shutdown(): Promise<void> {
    this.events.push("scheduler");
    await this.stopActiveFetch?.();
  }

  activationFor(instanceId: string): SchedulerActivateInput | undefined {
    return this.activations.find((activation) => activation.instanceId === instanceId);
  }

}

class RecordingAction implements StreamDeckActionPort {
  constructor(readonly id = "action-fal") {}

  async getSettings(): Promise<unknown> {
    return actionSettings;
  }

  async setSettings(): Promise<void> {
    return undefined;
  }

  async setImage(): Promise<void> {
    return undefined;
  }

  async setTitle(): Promise<void> {
    return undefined;
  }

  async showAlert(): Promise<void> {
    return undefined;
  }

  async showOk(): Promise<void> {
    return undefined;
  }
}

const actionSettings = {
  familyId: "balance",
  providerId: "fal",
  refreshIntervalSeconds: 600,
} as const;

const claudeCategoryWindows = ["five-hour", "seven-day", "fable", "credit-spend"] as const;

function claudeActionSettings(
  windowOrPeriod: (typeof claudeCategoryWindows)[number],
  credentialProfileId = "profile-claude",
) {
  return {
    familyId: "usage",
    providerId: "claude-code",
    refreshIntervalSeconds: 600,
    displayPreferences: {
      usageDisplayMode: "used",
    },
    windowOrPeriod,
    credentialProfileRef: {
      kind: "credential-profile",
      credentialClass: "local-read-only-source",
      profileId: credentialProfileId,
    },
  } as const;
}

const claudeResponseWithMalformedOptionalCategories = {
  five_hour: { utilization: 42, resets_at: "2026-07-15T12:00:00Z" },
  seven_day: { utilization: 73, resets_at: "2026-07-20T12:00:00Z" },
  limits: "malformed-optional-limits",
  spend: "malformed-optional-spend",
};

interface ResponseGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function responseGate(): ResponseGate {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return {
    promise,
    release: () => resolve?.(),
  };
}

interface SourceStartSignal {
  readonly count: () => number;
  readonly record: () => void;
  readonly waitFor: (expected: number) => Promise<void>;
}

function sourceStartSignal(): SourceStartSignal {
  let count = 0;
  const waiters: Array<{ readonly expected: number; readonly resolve: () => void }> = [];
  return {
    count: () => count,
    record: () => {
      count += 1;
      for (const waiter of waiters.splice(0)) {
        if (count >= waiter.expected) {
          waiter.resolve();
        } else {
          waiters.push(waiter);
        }
      }
    },
    waitFor: (expected) =>
      count >= expected
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ expected, resolve });
          }),
  };
}

function schedulerRequest(input: SchedulerActivateInput): SchedulerFetchRequest {
  const schedulerKey = serializeSchedulerKey(input.keyParts);
  return {
    schedulerKey,
    key: schedulerKey,
    keyParts: input.keyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: Date.UTC(2026, 6, 15),
    signal: new AbortController().signal,
  };
}

const globalSettings = {
  credentialProfiles: [
    {
      profileId: "profile:balance:fal:plugin-api-key",
      actionFamilyId: "balance",
      providerId: "fal",
      credentialClass: "plugin-api-key",
      credentialMaterial: {
        kind: "inline-secret",
        value: "fixture-credential",
      },
    },
  ],
} as const;

const logSink: StreamDeckLogSink = { write: () => undefined };

function noDataOutput(schedulerKey: string): SchedulerOutput {
  return {
    activeRefCount: 1,
    displayState: "no-data-yet",
    failure: {
      category: "no-data-yet",
      displayState: "no-data-yet",
      retryClass: "no-retry",
      safePublicMessage: "No data yet.",
      diagnostics: { reasonCode: "composition-test", boundary: "composition-test" },
      sanitized: true,
    },
    inFlight: false,
    refreshIntervalSeconds: 600,
    schedulerKey,
  };
}

describe("provider request governor app composition", () => {
  it("injects one opaque runtime into shell-derived scheduler fetches and tears down in the required order", async () => {
    expectTypeOf<ProviderRequestRuntime["sourceFlightRuntime"]>().toEqualTypeOf<AdapterSourceFlightRuntimeCapability>();
    const lifecycle: string[] = [];
    const scheduler = new RecordingScheduler(lifecycle);
    const services = createRuntimeServices(logSink, {
      onShutdownPhase: (phase) => lifecycle.push(phase),
    });
    const globalSettingsPort: GlobalSettingsPort = {
      read: async () => globalSettings,
      write: async () => undefined,
    };
    const shell = new StreamDeckShell({
      scheduler,
      globalSettings: globalSettingsPort,
      logSink,
      providerRequestRuntime: services.providerRequestRuntime,
    });

    try {
      await shell.handleWillAppear("balance", new RecordingAction(), actionSettings);
      const activated = scheduler.activation;
      expect(activated).toBeDefined();
      const effectFetch: SchedulerEffectFetch = activated!.fetch;
      expect(typeof effectFetch).toBe("function");
    } finally {
      await shell.shutdown();
      await services.shutdown();
    }

    expect(lifecycle).toEqual(["scheduler", "adapter-source-flights", "governor", "managed-runtime"]);
  });

  it("shares one opaque Claude flight across four shell-activated actions while preserving projection and identity isolation", async () => {
    const lifecycle: string[] = [];
    const scheduler = new RecordingScheduler(lifecycle);
    const subscriberArrivals = sourceStartSignal();
    const services = createRuntimeServices(logSink, {
      onShutdownPhase: (phase) => lifecycle.push(phase),
      onClaudeCodeUsageSubscriberRegistered: () => subscriberArrivals.record(),
    });
    const shell = new StreamDeckShell({
      scheduler,
      globalSettings: { read: async () => globalSettings, write: async () => undefined },
      logSink,
      providerRequestRuntime: services.providerRequestRuntime,
    });
    const sourceStarts = sourceStartSignal();
    let gate = responseGate();
    vi.stubGlobal("fetch", () => {
      sourceStarts.record();
      return gate.promise.then(
        () =>
          new Response(JSON.stringify(claudeResponseWithMalformedOptionalCategories), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
    });

    try {
      const actions = claudeCategoryWindows.map((window) => new RecordingAction(`action-claude-${window}`));
      await Promise.all(
        actions.map((action, index) => shell.handleWillAppear("usage", action, claudeActionSettings(claudeCategoryWindows[index]!))),
      );
      const activated = actions.map((action) => scheduler.activationFor(action.id));
      expect(activated.every((activation) => activation !== undefined)).toBe(true);
      expect(activated.map((activation) => activation!.keyParts.credentialProfileId)).toEqual([
        "profile-claude",
        "profile-claude",
        "profile-claude",
        "profile-claude",
      ]);

      const outcomes = await services.managedRuntime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* Effect.fork(Effect.either(activated[0]!.fetch(schedulerRequest(activated[0]!))));
            yield* Effect.promise(() => sourceStarts.waitFor(1));
            const remaining = yield* Effect.forEach(
              activated.slice(1),
              (activation) => Effect.fork(Effect.either(activation!.fetch(schedulerRequest(activation!)))),
            );
            yield* Effect.promise(() => subscriberArrivals.waitFor(4));
            yield* Effect.sync(() => gate.release());
            return yield* Effect.all([Fiber.join(first), ...remaining.map(Fiber.join)]);
          }),
        ),
      );

      expect(sourceStarts.count()).toBe(1);
      expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Right", "Right", "Left", "Left"]);

      const otherProfileAction = new RecordingAction("action-claude-other-profile");
      await shell.handleWillAppear("usage", otherProfileAction, claudeActionSettings("five-hour", "profile-claude-other"));
      const firstGeneration = activated[0]!;
      const nextGeneration = activated[1]!;
      const otherProfile = scheduler.activationFor(otherProfileAction.id);
      expect(otherProfile).toBeDefined();

      gate = responseGate();
      const originalGenerationOutcome = services.managedRuntime.runPromise(
        Effect.either(firstGeneration.fetch(schedulerRequest(firstGeneration))),
      );
      await sourceStarts.waitFor(2);
      await services.providerRequestRuntime.advanceCredentialGeneration(firstGeneration.keyParts.credentialProfileId);
      const changedGenerationOutcome = services.managedRuntime.runPromise(
        Effect.either(nextGeneration.fetch(schedulerRequest(nextGeneration))),
      );
      const changedProfileOutcome = services.managedRuntime.runPromise(
        Effect.either(otherProfile!.fetch(schedulerRequest(otherProfile!))),
      );
      await sourceStarts.waitFor(4);
      gate.release();
      await Promise.all([originalGenerationOutcome, changedGenerationOutcome, changedProfileOutcome]);

      expect(sourceStarts.count()).toBe(4);
    } finally {
      gate.release();
      try {
        await shell.shutdown();
        await services.shutdown();
      } finally {
        vi.unstubAllGlobals();
      }
    }

    expect(lifecycle).toEqual(["scheduler", "adapter-source-flights", "governor", "managed-runtime"]);
  });

  it("stops active shell-derived governed work before adapter and governor teardown", async () => {
    const lifecycle: string[] = [];
    const scheduler = new RecordingScheduler(lifecycle);
    const services = createRuntimeServices(logSink, {
      onShutdownPhase: (phase) => lifecycle.push(phase),
    });
    let resolveCredentialRead: ((settings: unknown) => void) | undefined;
    let signalCredentialReadStarted: (() => void) | undefined;
    const credentialReadStarted = new Promise<void>((resolve) => {
      signalCredentialReadStarted = resolve;
    });
    const credentialRead = new Promise<unknown>((resolve) => {
      resolveCredentialRead = resolve;
    });
    const globalSettingsPort: GlobalSettingsPort = {
      read: async () => {
        lifecycle.push("governed-source-active");
        signalCredentialReadStarted?.();
        return credentialRead;
      },
      write: async () => undefined,
    };
    const shell = new StreamDeckShell({
      scheduler,
      globalSettings: globalSettingsPort,
      logSink,
      providerRequestRuntime: services.providerRequestRuntime,
    });
    let shellStopped = false;
    let servicesStopped = false;

    try {
      await shell.handleWillAppear("balance", new RecordingAction(), actionSettings);
      const effectFetch: SchedulerEffectFetch = scheduler.activation!.fetch;
      const activeFetch = services.managedRuntime.runFork(
        effectFetch({
          schedulerKey: serializeSchedulerKey(scheduler.activation!.keyParts),
          key: serializeSchedulerKey(scheduler.activation!.keyParts),
          keyParts: scheduler.activation!.keyParts,
          trigger: "healthy-poll",
          startedAtEpochMs: Date.UTC(2026, 6, 15),
          signal: new AbortController().signal,
        }),
      );
      scheduler.setActiveFetchStop(async () => {
        await services.managedRuntime.runPromise(Fiber.interrupt(activeFetch));
        lifecycle.push("scheduler-fetch-stopped");
      });

      await credentialReadStarted;
      await shell.shutdown();
      shellStopped = true;
      await services.shutdown();
      servicesStopped = true;
    } finally {
      resolveCredentialRead?.(globalSettings);
      if (!shellStopped) {
        await shell.shutdown();
      }
      if (!servicesStopped) {
        await services.shutdown();
      }
    }

    expect(lifecycle).toEqual([
      "governed-source-active",
      "scheduler",
      "scheduler-fetch-stopped",
      "adapter-source-flights",
      "governor",
      "managed-runtime",
    ]);
  });

  it("advances generation only for centrally classified provider-source-affecting credential profiles", async () => {
    const generationEvents: string[] = [];
    const scheduler = new RecordingScheduler([]);
    const services = createRuntimeServices(logSink, {
      onCredentialGenerationAdvanced: (credentialProfileId) => generationEvents.push(`generation:${credentialProfileId}`),
    });
    const shell = new StreamDeckShell({
      scheduler,
      globalSettings: { read: async () => globalSettings, write: async () => undefined },
      logSink,
      providerRequestRuntime: services.providerRequestRuntime,
    });
    const displayOnlySettings = {
      ...globalSettings,
      severityProfiles: [
        {
          profileId: "display-only-profile",
          thresholds: {
            direction: "lower-bound",
            basis: "absolute",
            warningAt: 5,
          },
        },
      ],
    } as const;

    try {
      shell.primeGlobalSettingsBaseline(globalSettings);
      await shell.handleGlobalSettingsChanged(displayOnlySettings);
      await shell.handleGlobalSettingsChanged(displayOnlySettings);
      expect(generationEvents).toEqual([]);

      await shell.handleGlobalSettingsChanged({
        ...displayOnlySettings,
        credentialProfiles: [
          {
            ...globalSettings.credentialProfiles[0],
            credentialMaterial: {
              kind: "inline-secret",
              value: "fixture-credential-rotated",
            },
          },
        ],
      });
    } finally {
      await shell.shutdown();
      await services.shutdown();
    }

    expect(generationEvents).toEqual(["generation:profile:balance:fal:plugin-api-key"]);
  });
});
