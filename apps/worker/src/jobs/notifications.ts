import type { OutboxEvent } from "./outbox.js";

export interface NotificationSink {
  send(input: {
    tenantId: string;
    kind: string;
    requestId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> | void;
}

export class NotificationJob {
  constructor(private readonly sink: NotificationSink) {}

  async handle(event: OutboxEvent): Promise<void> {
    if (
      ![
        "PrivacyRequestCreated",
        "ExecutionPlanCreated",
        "ExecutionStarted",
        "PrivacyRequestCompleted",
        "PrivacyRequestFailed",
        "PrivacyRequestNeedsReview",
      ].includes(event.type)
    ) {
      return;
    }
    const requestId =
      typeof event.payload.requestId === "string"
        ? event.payload.requestId
        : null;
    await this.sink.send({
      tenantId: event.tenantId,
      kind: event.type,
      requestId,
      payload: sanitizeNotificationPayload(event.payload),
    });
  }
}

function sanitizeNotificationPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "requestId",
    "attemptId",
    "planId",
    "planVersion",
    "status",
    "affectedCount",
    "failedCount",
  ]);
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) => allowed.has(key) && isSafe(value),
    ),
  );
}

function isSafe(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}
