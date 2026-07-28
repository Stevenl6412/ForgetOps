export interface AdapterLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const SAFE_FIELDS = new Set(["code", "resource", "route", "statusCode"]);

export function createRedactingLogger(
  write: (record: Record<string, unknown>) => void = console.log,
): AdapterLogger {
  const log = (
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    const safeFields = Object.fromEntries(
      Object.entries(fields).filter(
        ([key, value]) =>
          SAFE_FIELDS.has(key) &&
          (typeof value === "string" || typeof value === "number"),
      ),
    );
    write({ level, event, ...safeFields });
  };
  return {
    info: (event, fields) => log("info", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}
