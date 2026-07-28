import { safeEventName, sanitizeTelemetry } from "./pii-guard.js";

export interface LogSink {
  write(line: string): void;
}

export class SafeLogger {
  constructor(
    private readonly sink: LogSink = {
      write: (line) => console.log(line),
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  info(fields: Record<string, unknown>, event: string): void {
    this.write("info", fields, event);
  }

  warn(fields: Record<string, unknown>, event: string): void {
    this.write("warn", fields, event);
  }

  error(fields: Record<string, unknown>, event: string): void {
    this.write("error", fields, event);
  }

  private write(
    level: "info" | "warn" | "error",
    fields: Record<string, unknown>,
    event: string,
  ): void {
    this.sink.write(
      JSON.stringify({
        timestamp: this.now().toISOString(),
        level,
        event: safeEventName(event),
        ...sanitizeTelemetry(fields),
      }),
    );
  }
}

export const logger = new SafeLogger();
export * from "./pii-guard.js";
