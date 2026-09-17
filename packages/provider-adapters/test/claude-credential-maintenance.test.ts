import { Deferred, Duration, Effect, Exit, ManagedRuntime, Scope, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { makeClaudeCredentialMaintenance, type ClaudeCredentialMaintenanceOutcome } from "../src/providers/usage/claude-code/credential-maintenance.js";
import type { UsageProviderLocalSourceReaders } from "../src/types.js";

const minute = 60_000;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function harness() {
  const runtime = ManagedRuntime.make(TestContext.TestContext);
  const lifetime = runtime.runSync(Scope.make());
  const subscribe = await runtime.runPromise(makeClaudeCredentialMaintenance(lifetime));
  const outcomes: ClaudeCredentialMaintenanceOutcome[] = [];
  const scopes: Scope.CloseableScope[] = [];
  const connect = async (source: NonNullable<UsageProviderLocalSourceReaders["claudeCode"]>, nextCheckAtEpochMs: number) => {
    const scope = runtime.runSync(Scope.make());
    scopes.push(scope);
    await runtime.runPromise(Scope.extend(subscribe({ source, nextCheckAtEpochMs, onOutcome: (outcome) => Effect.sync(() => outcomes.push(outcome)) }), scope));
    await settle();
    return () => runtime.runPromise(Scope.close(scope, Exit.void));
  };
  return {
    runtime, lifetime, outcomes, connect,
    advance: async (ms: number) => { await runtime.runPromise(TestClock.adjust(Duration.millis(ms))); await settle(); },
    close: async () => {
      for (const scope of scopes) await runtime.runPromise(Scope.close(scope, Exit.void));
      await runtime.runPromise(Scope.close(lifetime, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("shared Claude credential maintenance", () => {
  it("shares a four-minute deadline across staggered category subscriptions and never calls ten or five minutes early", async () => {
    const h = await harness();
    let expiry = 10 * minute;
    let calls = 0;
    const source = {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: expiry }),
      refreshCredential: async () => { calls++; expiry += 60 * minute; },
    };
    try {
      for (let category = 0; category < 4; category++) {
        await h.connect(source, 20 * minute);
        await h.advance(30_000);
      }
      await h.advance(3 * minute);
      expect(calls).toBe(0);
      await h.advance(minute - 1);
      expect(calls).toBe(0);
      await h.advance(1);
      expect(calls).toBe(1);
      expect(h.outcomes).toEqual(["armed", "renewed"]);
      await h.advance(minute);
      expect(calls).toBe(1);
      expect(JSON.stringify(h.outcomes)).not.toContain("fixture-access");
    } finally { await h.close(); }
  });

  it("defers to an earlier actual poll and reacts to a replacement wait instead of a captured interval", async () => {
    const h = await harness();
    let calls = 0;
    const source = {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: 10 * minute }),
      refreshCredential: async () => { calls++; },
    };
    try {
      const disconnect = await h.connect(source, 5 * minute);
      await h.advance(5 * minute);
      expect(h.outcomes).toEqual([]);
      expect(calls).toBe(0);
      await disconnect();
      await h.connect(source, 15 * minute);
      await h.advance(minute);
      expect(calls).toBe(1);
      expect(h.outcomes).toEqual(["armed", "not-advanced"]);
    } finally { await h.close(); }
  });

  it("rereads at the wake and adopts a peer renewal without invoking the obsolete exchange", async () => {
    const h = await harness();
    let expiry = 10 * minute;
    let calls = 0;
    const source = {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: expiry }),
      refreshCredential: async () => { calls++; },
    };
    try {
      await h.connect(source, 20 * minute);
      await h.advance(5 * minute);
      expiry = 60 * minute;
      await h.advance(minute);
      expect(calls).toBe(0);
      expect(h.outcomes).toEqual(["armed"]);
    } finally { await h.close(); }
  });

  it.each(["no-op", "failure"] as const)("attempts once per expiry after %s even across new waits, leaving a still-valid credential usable", async (mode) => {
    const h = await harness();
    let expiry = 10 * minute;
    let calls = 0;
    const source = {
      readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: expiry }),
      refreshCredential: async () => { calls++; if (mode === "failure") throw new Error("fixture-secret-error"); },
    };
    try {
      const disconnect = await h.connect(source, 20 * minute);
      await h.advance(6 * minute);
      expect(calls).toBe(1);
      expect(h.outcomes).toContain(mode === "failure" ? "refresh-failed" : "not-advanced");
      expect(await source.readCredential()).toMatchObject({ ok: true, expiresAt: 10 * minute });
      await disconnect();
      await h.connect(source, 20 * minute);
      await h.advance(minute);
      expect(calls).toBe(1);
      expiry = 15 * minute;
      const next = await h.connect(source, 20 * minute);
      await h.advance(4 * minute);
      expect(calls).toBe(2);
      await next();
      expect(JSON.stringify(h.outcomes)).not.toContain("fixture-secret-error");
    } finally { await h.close(); }
  });

  it("cancels a pending deadline when the final subscription leaves", async () => {
    const h = await harness();
    let calls = 0;
    try {
      const disconnect = await h.connect({
        readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: 10 * minute }),
        refreshCredential: async () => { calls++; },
      }, 20 * minute);
      await disconnect();
      await h.advance(12 * minute);
      expect(calls).toBe(0);
    } finally { await h.close(); }
  });

  it.each(["blank-token", "rejected-read"] as const)("does not record renewed after an unusable %s readback", async (mode) => {
    const h = await harness();
    let attempted = false;
    try {
      await h.connect({
        readCredential: async () => {
          if (attempted && mode === "rejected-read") throw new Error("fixture-private-read-error");
          return { ok: true as const, accessToken: attempted ? "" : "fixture-access", expiresAt: attempted ? 60 * minute : 10 * minute };
        },
        refreshCredential: async () => { attempted = true; },
      }, 20 * minute);
      await h.advance(6 * minute);
      expect(h.outcomes).toEqual(["armed", "read-failed"]);
      await h.advance(minute);
      expect(h.outcomes).toEqual(["armed", "read-failed"]);
    } finally { await h.close(); }
  });

  it("accepts authoritative expiry advancement even if the later model invocation fails", async () => {
    const h = await harness();
    let expiry = 10 * minute;
    try {
      await h.connect({
        readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: expiry }),
        refreshCredential: async () => { expiry = 60 * minute; throw new Error("fixture-model-failed-after-persistence"); },
      }, 20 * minute);
      await h.advance(6 * minute);
      expect(h.outcomes).toEqual(["armed", "renewed"]);
    } finally { await h.close(); }
  });

  it("waits for a scheduler change after the immediate prelaunch reread fails", async () => {
    const h = await harness();
    let reads = 0;
    let calls = 0;
    try {
      await h.connect({
        readCredential: async () => {
          reads++;
          if (reads === 3) throw new Error("fixture-private-read-error");
          return { ok: true as const, accessToken: "fixture-access", expiresAt: 10 * minute };
        },
        refreshCredential: async () => { calls++; },
      }, 20 * minute);
      await h.advance(6 * minute);
      expect(reads).toBe(3);
      expect(calls).toBe(0);
      expect(h.outcomes).toEqual(["armed", "read-failed"]);
      await h.advance(minute);
      expect(reads).toBe(3);
      expect(calls).toBe(0);
    } finally { await h.close(); }
  });

  it.each(["final-detach", "runtime-shutdown"] as const)("%s awaits an already launched exchange and its readback without interrupting persistence", async (mode) => {
    const h = await harness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let expiry = 10 * minute;
    let readsAfterWrite = 0;
    let started = false;
    let closed = false;
    try {
      const disconnect = await h.connect({
        readCredential: async () => { if (expiry > 10 * minute) readsAfterWrite++; return { ok: true as const, accessToken: "fixture-access", expiresAt: expiry }; },
        refreshCredential: async () => { started = true; await gate; expiry = 60 * minute; },
      }, 20 * minute);
      await h.advance(6 * minute);
      expect(started).toBe(true);
      const closing = (mode === "final-detach" ? disconnect() : h.runtime.runPromise(Scope.close(h.lifetime, Exit.void))).then(() => { closed = true; });
      await settle();
      expect(closed).toBe(false);
      release();
      await closing;
      expect(readsAfterWrite).toBeGreaterThan(0);
      expect(h.outcomes).toContain("renewed");
    } finally { release(); await h.close(); }
  });

  it("checks the post-renewal clock instead of declaring an already-expired advanced token renewed", async () => {
    const h = await harness();
    const gate = h.runtime.runSync(Deferred.make<void>());
    let expiry = 10 * minute;
    try {
      await h.connect({
        readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", expiresAt: expiry }),
        refreshCredential: async () => { await h.runtime.runPromise(Deferred.await(gate)); expiry = 11 * minute; },
      }, 20 * minute);
      await h.advance(6 * minute);
      await h.advance(6 * minute);
      h.runtime.runSync(Deferred.succeed(gate, undefined));
      await settle();
      expect(h.outcomes).toEqual(["armed", "not-advanced"]);
    } finally { h.runtime.runSync(Deferred.succeed(gate, undefined)); await h.close(); }
  });

  it.each([undefined, NaN, Infinity, -Infinity, 0])("does not arm invalid or expired metadata: %s", async (expiresAt) => {
    const h = await harness();
    let calls = 0;
    try {
      await h.connect({
        readCredential: async () => ({ ok: true as const, accessToken: "fixture-access", ...(expiresAt === undefined ? {} : { expiresAt }) }),
        refreshCredential: async () => { calls++; },
      }, 20 * minute);
      await h.advance(20 * minute);
      expect(calls).toBe(0);
      expect(h.outcomes).toEqual([]);
    } finally { await h.close(); }
  });
});
