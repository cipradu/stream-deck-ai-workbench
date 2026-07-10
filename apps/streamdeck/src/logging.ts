import {
  createSanitizedLogEvent,
  writeSanitizedLogEvent,
  type CreateSanitizedLogEventInput,
  type LogLevel,
  type SanitizedLogEvent,
  type StreamDeckLogSink,
} from "@ai-workbench/logging";

export interface SdkLoggerPort {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
}

export function createSdkLogSink(logger: SdkLoggerPort): StreamDeckLogSink {
  return {
    write: (event) => {
      writeToSdkLogger(logger, event);
    },
  };
}

export async function writeShellLog(sink: StreamDeckLogSink, input: CreateSanitizedLogEventInput): Promise<void> {
  await writeSanitizedLogEvent(sink, createSanitizedLogEvent(input));
}

function writeToSdkLogger(logger: SdkLoggerPort, event: SanitizedLogEvent): void {
  const line = `${event.eventName}: ${event.message}`;
  const method = methodForLevel(event.level);
  logger[method](line, event.context);
}

function methodForLevel(level: LogLevel): keyof SdkLoggerPort {
  switch (level) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
  }
}
