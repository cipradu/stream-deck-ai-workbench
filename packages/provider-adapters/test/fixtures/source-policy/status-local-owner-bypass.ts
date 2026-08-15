import { Data, Effect, Fiber, Logger, ManagedRuntime, Redacted, Runtime, Schedule } from "effect";

import { requestJsonSchema } from "@ai-workbench/http";

class StatusSourceError extends Error {}

export async function fetchStatus(endpointUrl: string): Promise<unknown> {
  const completedResultCache = new Map<string, unknown>();
  const client = requestJsonSchema;
  const response = await fetch(endpointUrl);
  const payload = await response.json();
  const runtime = ManagedRuntime;
  const lowLevelRuntime = Runtime;
  const fiber = Fiber;
  const promiseBridge = Promise.resolve(payload);
  const retry = Schedule;
  const logger = Logger;
  const taggedError = Data;
  const redacted = Redacted;
  const settings = readGlobalSettings();
  const sink = { write: eventSerializer };
  const headers = { authorization: "fixture-only" };
  const fallback = Effect.fail("fixture").pipe(
    Effect.catchAll(() =>
      Effect.succeed({ ok: true, activeIncidentCount: 0, tone: "operational" as const }),
    ),
  );
  setTimeout(() => completedResultCache.set("result", payload), 1);
  console.info("fixture-only");

  try {
    return {
      title: "raw incident prose",
      body: "raw incident update",
      client,
      runtime,
      lowLevelRuntime,
      fiber,
      promiseBridge,
      retry,
      logger,
      taggedError,
      redacted,
      settings,
      sink,
      headers,
      fallback,
    };
  } catch (cause) {
    throw new StatusSourceError(String(cause));
  }
}

function eventSerializer(value: unknown): string {
  return String(value);
}

function readGlobalSettings(): Readonly<Record<string, unknown>> {
  return {};
}
