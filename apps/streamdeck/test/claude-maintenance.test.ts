import { Clock, Duration, Effect, Layer, ManagedRuntime, TestClock, TestContext } from "effect";
import { describe, expect, it, vi } from "vitest";

import { AdapterSourceFlightRuntimeCapability, AdapterSourceFlightRuntimeLive, shutdownAdapterSourceFlightRuntime } from "@ai-workbench/provider-adapters";
import { ProviderRequestGovernor, ProviderRequestGovernorLive, createScheduler } from "@ai-workbench/scheduler";
import { parseActionSettings } from "@ai-workbench/settings";
import type { SanitizedLogEvent } from "@ai-workbench/logging";
import { createSchedulerFetchForActionSettings, createSchedulerMaintenanceForActionSettings } from "../src/scheduler-fetch.js";

const minute = 60_000;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function harness(status = 200, failRenewal = false) {
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provideMerge(AdapterSourceFlightRuntimeLive, ProviderRequestGovernorLive),
    TestContext.TestContext,
  ));
  const capability = runtime.runSync(AdapterSourceFlightRuntimeCapability);
  const governor = runtime.runSync(ProviderRequestGovernor);
  const scheduler = createScheduler({ runtime });
  const logs: SanitizedLogEvent[] = [];
  let expiry = 10 * minute;
  let httpCalls = 0;
  let renewals = 0;
  vi.stubGlobal("fetch", async () => {
    httpCalls++;
    return new Response(JSON.stringify({ five_hour: { utilization: 25 }, seven_day: { utilization: 35 } }), {
      status, headers: { "content-type": "application/json", "retry-after": "1200" },
    });
  });
  const options = {
    sourceFlightRuntime: capability,
    readGlobalSettings: async () => { throw new Error("Claude must not read plugin credentials"); },
    logSink: { write: (event: SanitizedLogEvent) => { logs.push(event); } },
    localSources: { claudeCode: {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-access-never-log", expiresAt: expiry }),
      refreshCredential: async () => {
        renewals++;
        if (failRenewal) throw new Error("fixture-refresh-error-never-log");
        expiry += 60 * minute;
      },
    } },
  };
  const activate = async (windowOrPeriod = "five-hour", id = windowOrPeriod) => {
    const parsed = parseActionSettings({ familyId: "usage", providerId: "claude-code", windowOrPeriod, refreshIntervalSeconds: 900 });
    if (!parsed.ok) throw new Error("invalid test action");
    const maintenance = createSchedulerMaintenanceForActionSettings(parsed.value, options);
    if (maintenance === undefined) throw new Error("Claude maintenance missing");
    scheduler.activate({ instanceId: id, keyParts: parsed.value.schedulerKeyParts, refreshIntervalSeconds: 900,
      fetch: createSchedulerFetchForActionSettings(parsed.value, options), maintenance });
    await settle();
    return parsed.value;
  };
  return {
    runtime, scheduler, governor, logs, activate, options,
    counts: () => ({ httpCalls, renewals }),
    peerRenew: () => { expiry += 60 * minute; },
    advance: async (ms: number) => { await runtime.runPromise(TestClock.adjust(Duration.millis(ms))); await settle(); },
    close: async () => {
      await scheduler.shutdown();
      await runtime.runPromise(shutdownAdapterSourceFlightRuntime(capability));
      await runtime.runPromise(governor.shutdown());
      await runtime.dispose();
      vi.unstubAllGlobals();
    },
  };
}

describe("Claude maintenance app composition", () => {
  it("renews once across four staggered categories without fetching usage or changing governor generation", async () => {
    const h = await harness();
    try {
      for (const category of ["five-hour", "seven-day", "fable", "credit-spend"]) {
        await h.activate(category);
        await h.advance(30_000);
      }
      const before = h.counts().httpCalls;
      expect(before).toBe(4);
      await h.advance(4 * minute);
      expect(h.counts()).toEqual({ httpCalls: before, renewals: 1 });
      expect(h.logs.filter((event) => event.eventName === "streamdeck-claude-credential-maintenance").map((event) => event.context.reasonCode)).toEqual(["armed", "renewed"]);
      expect(await h.runtime.runPromise(h.governor.diagnostics())).toMatchObject({ activeSourceCount: 0, activeAttemptCount: 0 });
      expect(JSON.stringify(h.logs)).not.toContain("fixture-access-never-log");
    } finally { await h.close(); }
  });

  it("maintains credentials during rate-limit backoff without bypassing it or sending another usage request", async () => {
    const h = await harness(429);
    try {
      const settings = await h.activate();
      const before = h.scheduler.getOutput(settings.schedulerKey);
      const generation = await h.runtime.runPromise(h.governor.credentialGenerationFor({ credentialProfileId: settings.schedulerKeyParts.credentialProfileId }));
      expect(before.nextAllowedRetryAtEpochMs).toBe(20 * minute);
      await h.advance(6 * minute);
      expect(h.counts()).toEqual({ httpCalls: 1, renewals: 1 });
      expect(h.scheduler.getOutput(settings.schedulerKey).backoff).toEqual(before.backoff);
      expect(await h.runtime.runPromise(h.governor.credentialGenerationFor({ credentialProfileId: settings.schedulerKeyParts.credentialProfileId }))).toBe(generation);
    } finally { await h.close(); }
  });

  it("keeps successful usage and still-valid access usable after early renewal fails", async () => {
    const h = await harness(200, true);
    try {
      const settings = await h.activate();
      await h.advance(6 * minute);
      expect(h.counts()).toEqual({ httpCalls: 1, renewals: 1 });
      expect(h.scheduler.getOutput(settings.schedulerKey)).toMatchObject({ displayState: "fresh", snapshot: { value: 25 } });
      await h.scheduler.refresh(settings.schedulerKey);
      await settle();
      expect(h.counts()).toEqual({ httpCalls: 2, renewals: 1 });
      expect(h.scheduler.getOutput(settings.schedulerKey).failure).toBeUndefined();
      expect(h.logs.some((event) => event.context.reasonCode === "refresh-failed")).toBe(true);
      expect(JSON.stringify(h.logs)).not.toContain("fixture-refresh-error-never-log");
    } finally { await h.close(); }
  });

  it("manual refresh adopts a peer credential and replaces the obsolete deadline", async () => {
    const h = await harness();
    try {
      const settings = await h.activate();
      await h.advance(5 * minute);
      h.peerRenew();
      await h.scheduler.refresh(settings.schedulerKey);
      await settle();
      await h.advance(minute);
      expect(h.counts()).toEqual({ httpCalls: 2, renewals: 0 });
      expect(await h.runtime.runPromise(Clock.currentTimeMillis)).toBe(6 * minute);
    } finally { await h.close(); }
  });

  it("does not install maintenance for another usage provider", async () => {
    const h = await harness();
    try {
      const parsed = parseActionSettings({ familyId: "usage", providerId: "codex", windowOrPeriod: "five-hour", refreshIntervalSeconds: 900 });
      if (!parsed.ok) throw new Error("invalid test action");
      expect(createSchedulerMaintenanceForActionSettings(parsed.value, h.options)).toBeUndefined();
      await h.advance(10 * minute);
      expect(h.counts()).toEqual({ httpCalls: 0, renewals: 0 });
    } finally { await h.close(); }
  });
});
