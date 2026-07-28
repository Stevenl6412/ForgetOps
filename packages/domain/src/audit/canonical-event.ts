import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export const AUDIT_HASH_CONTEXT = "forgetops.audit-event.v1";

export interface CanonicalAuditEvent {
  id: string;
  tenantId: string;
  environmentId: string;
  sequence: string;
  requestId: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  previousEventHash: string | null;
  eventHash: string;
}

export type AuditEventWithoutHashes = Omit<
  CanonicalAuditEvent,
  "previousEventHash" | "eventHash"
>;

export function canonicalAuditEventBytes(
  event: AuditEventWithoutHashes,
): Uint8Array {
  const serialized = canonicalize(event);
  if (serialized === undefined) {
    throw new TypeError("AUDIT_EVENT_NOT_CANONICAL");
  }
  return new TextEncoder().encode(serialized);
}

export function auditEventHash(
  previousEventHash: string | null,
  event: AuditEventWithoutHashes,
): string {
  const previous = previousEventHash
    ? Buffer.from(previousEventHash, "hex")
    : Buffer.alloc(0);
  if (previous.length !== (previousEventHash ? 32 : 0)) {
    throw new TypeError("AUDIT_PREVIOUS_HASH_INVALID");
  }
  return createHash("sha256")
    .update(AUDIT_HASH_CONTEXT, "utf8")
    .update(Buffer.from([0]))
    .update(previous)
    .update(canonicalAuditEventBytes(event))
    .digest("hex");
}
