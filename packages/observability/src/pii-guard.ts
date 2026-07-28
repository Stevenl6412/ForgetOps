const ALLOWED_FIELDS = new Set([
  "requestId",
  "tenantId",
  "environmentId",
  "agentId",
  "attemptId",
  "jobId",
  "status",
  "action",
  "errorCode",
  "durationMs",
  "count",
]);

export type SafeTelemetry = Record<string, string | number | boolean | null>;

export function sanitizeTelemetry(
  fields: Record<string, unknown>,
): SafeTelemetry {
  const safe: SafeTelemetry = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key) || !isScalar(value)) continue;
    safe[key] = value;
  }
  return safe;
}

export function safeEventName(value: string): string {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value) ? value : "log_event";
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}
