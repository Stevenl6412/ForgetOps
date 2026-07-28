import { auditEventHash, type CanonicalAuditEvent } from "./canonical-event.js";

export interface VerifiedAuditChain {
  valid: true;
}

export interface InvalidAuditChain {
  valid: false;
  brokenAt: string;
}

export function verifyChain(
  chain: readonly CanonicalAuditEvent[],
): VerifiedAuditChain | InvalidAuditChain {
  let previous: string | null = null;
  for (const event of chain) {
    const expected = auditEventHash(previous, {
      id: event.id,
      tenantId: event.tenantId,
      environmentId: event.environmentId,
      sequence: event.sequence,
      requestId: event.requestId,
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      metadata: event.metadata,
      createdAt: event.createdAt,
    });
    if (event.previousEventHash !== previous || event.eventHash !== expected) {
      return { valid: false, brokenAt: event.id };
    }
    previous = event.eventHash;
  }
  return { valid: true };
}

export function buildChain(
  events: readonly Omit<
    CanonicalAuditEvent,
    "previousEventHash" | "eventHash"
  >[],
): CanonicalAuditEvent[] {
  let previous: string | null = null;
  return events.map((event) => {
    const eventHash = auditEventHash(previous, event);
    const complete = { ...event, previousEventHash: previous, eventHash };
    previous = eventHash;
    return complete;
  });
}
