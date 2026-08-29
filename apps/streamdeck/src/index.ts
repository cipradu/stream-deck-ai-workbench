import streamDeck, {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { pathToFileURL } from "node:url";

import type { ActionFamilyId } from "@ai-workbench/contracts";

import { BALANCE_ACTION_UUID, STATUS_ACTION_UUID, USAGE_ACTION_UUID, packageName } from "./constants.js";
import { createSdkLogSink, writeShellLog } from "./logging.js";
import { createManagedRuntimeRunner, createRuntimeServices, type RuntimeRunner } from "./runtime.js";
import { withLegacyCredentialProfiles } from "./settings.js";
import { startRenderLoop, StreamDeckShell, type StreamDeckActionPort } from "./shell.js";

export { packageName };
export { BALANCE_ACTION_UUID, PLUGIN_UUID, STATUS_ACTION_UUID, USAGE_ACTION_UUID } from "./constants.js";
export { listProviderOptionsForFamily } from "./property-inspector.js";
export { renderDisplayInput } from "./renderer.js";
export { StreamDeckShell } from "./shell.js";

type SdkAction = WillAppearEvent["action"] & KeyDownEvent["action"] & DidReceiveSettingsEvent["action"];

type SdkJsonValue = SdkJsonObject | boolean | number | string | null | undefined | SdkJsonValue[];
type SdkJsonObject = {
  readonly [key: string]: SdkJsonValue;
};

export interface StartedStreamDeckPlugin {
  readonly shell: StreamDeckShell;
  readonly stop: () => Promise<void>;
}

export async function connectAndPrepareStreamDeckShell(input: {
  readonly connect: () => Promise<void>;
  readonly prepare: () => Promise<void>;
}): Promise<void> {
  await input.connect();
  await input.prepare();
}

interface WorkbenchActionOptions {
  readonly familyId: ActionFamilyId;
  readonly manifestId: string;
  readonly taskNamePrefix: string;
  readonly shell: StreamDeckShell;
  readonly run: RuntimeRunner;
}

export const WORKBENCH_ACTION_DEFINITIONS = [
  {
    familyId: "usage",
    manifestId: USAGE_ACTION_UUID,
    taskNamePrefix: "usage",
  },
  {
    familyId: "balance",
    manifestId: BALANCE_ACTION_UUID,
    taskNamePrefix: "balance",
  },
  {
    familyId: "status",
    manifestId: STATUS_ACTION_UUID,
    taskNamePrefix: "status",
  },
] as const satisfies readonly Omit<WorkbenchActionOptions, "run" | "shell">[];

class WorkbenchAction extends SingletonAction {
  override readonly manifestId: string;
  private readonly familyId: ActionFamilyId;
  private readonly taskNamePrefix: string;
  private readonly shell: StreamDeckShell;
  private readonly run: RuntimeRunner;

  constructor(options: WorkbenchActionOptions) {
    super();
    this.familyId = options.familyId;
    this.manifestId = options.manifestId;
    this.run = options.run;
    this.shell = options.shell;
    this.taskNamePrefix = options.taskNamePrefix;
  }

  override onWillAppear(ev: WillAppearEvent): Promise<void> {
    return this.run(`${this.taskNamePrefix}-will-appear`, () =>
      this.shell.handleWillAppear(this.familyId, actionPort(ev.action as SdkAction), ev.payload.settings),
    );
  }

  override onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    return this.run(`${this.taskNamePrefix}-will-disappear`, () => this.shell.handleWillDisappear({ id: ev.action.id }));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): Promise<void> {
    return this.run(`${this.taskNamePrefix}-did-receive-settings`, () =>
      this.shell.handleDidReceiveSettings(this.familyId, actionPort(ev.action as SdkAction), ev.payload.settings),
    );
  }

  override onKeyDown(ev: KeyDownEvent): Promise<void> {
    return this.run(`${this.taskNamePrefix}-key-down`, () => this.shell.handleKeyDown(this.familyId, actionPort(ev.action as SdkAction)));
  }

  override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    void ev;
    return this.run(`${this.taskNamePrefix}-property-inspector-did-appear`, () =>
      this.shell.handlePropertyInspectorDidAppear(this.familyId),
    );
  }
}

export async function startAiWorkbenchStreamDeckPlugin(deck: typeof streamDeck = streamDeck): Promise<StartedStreamDeckPlugin> {
  const logSink = createSdkLogSink(deck.logger);
  const services = createRuntimeServices(logSink);
  // Stream Deck 7.1+ message identifiers: stops our own getGlobalSettings()
  // responses from being delivered as Property Inspector change events (the
  // old working plugin relied on the same flag).
  deck.settings.useExperimentalMessageIdentifiers = true;
  const shell = new StreamDeckShell({
    globalSettings: {
      // Read-side legacy mapping: old-plugin `zaiApiKey`/`balanceApiKeys.<vendor>`
      // keys surface as canonical credential profiles so saved keys keep working.
      read: async () => withLegacyCredentialProfiles(await deck.settings.getGlobalSettings()),
      readRaw: () => deck.settings.getGlobalSettings(),
      write: (settings) => deck.settings.setGlobalSettings(asJsonObject(settings)),
    },
    logSink,
    providerRequestRuntime: services.providerRequestRuntime,
    scheduler: services.scheduler,
    startupReady: false,
  });
  const run = createManagedRuntimeRunner(services.managedRuntime, logSink);
  // The render fiber (Effect.repeat(Schedule.fixed)) runs on the shared ManagedRuntime and
  // reads scheduler.getOutput; the old 1s scheduler runDue setInterval is gone (fibers self-schedule).
  const stopRenderLoop = startRenderLoop({
    render: () => shell.renderActiveFromScheduler(),
    runtime: services.managedRuntime,
  });
  await writeShellLog(logSink, {
    context: {
      reasonCode: "plugin-startup",
    },
    eventName: "streamdeck-plugin-startup",
    level: "info",
    message: "AI Workbench plugin starting.",
  });

  for (const definition of WORKBENCH_ACTION_DEFINITIONS) {
    deck.actions.registerAction(new WorkbenchAction({ ...definition, run, shell }));
  }
  // Property Inspector `global`-bound fields (API keys) save through Stream
  // Deck global settings; classify each change centrally and refetch exactly
  // the affected provider keys.
  deck.settings.onDidReceiveGlobalSettings((ev) => {
    void run("streamdeck-global-settings-changed", () => shell.handleGlobalSettingsChanged(ev.settings));
  });
  await connectAndPrepareStreamDeckShell({
    connect: () => deck.connect(),
    prepare: () => run("streamdeck-global-settings-startup", () => shell.prepareGlobalSettingsStartup()),
  });

  return {
    shell,
    stop: async () => {
      stopRenderLoop();
      await shell.shutdown();
      // Dispose the ManagedRuntime composition root: this releases the app Layer / composition scope (the
      // sanitizing Logger) — it is NOT what stops the fibers. The render fiber was already
      // interrupted above by stopRenderLoop(), and the scheduler's per-key fibers by shell.shutdown() ->
      // scheduler.shutdown() (the scheduler shares this runtime, so its shutdown() interrupts its own
      // fibers without disposing the shared runtime). Keep those explicit stops: disposing the runtime is
      // not a substitute for them, so removing stopRenderLoop() would leak the render fiber.
      await services.shutdown();
    },
  };
}

function actionPort(action: SdkAction): StreamDeckActionPort {
  return {
    getSettings: () => action.getSettings(),
    id: action.id,
    setImage: (image) => action.setImage(image),
    setSettings: (settings) => action.setSettings(asJsonObject(settings)),
    setTitle: (title) => action.setTitle(title),
    showAlert: () => action.showAlert(),
    showOk: () => action.showOk(),
  };
}

function asJsonObject(value: unknown): SdkJsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is SdkJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntrypoint(metaUrl: string): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === metaUrl;
}

if (isEntrypoint(import.meta.url)) {
  void startAiWorkbenchStreamDeckPlugin();
}
