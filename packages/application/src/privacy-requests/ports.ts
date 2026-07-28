import type { PrivacyRequestAggregate } from "@forgetops/domain";

export interface PrivacyRequestRecord {
  id: string;
  tenantId: string;
  environmentId: string;
  type: string;
  source: string;
  subjectHash: string | null;
  subjectHashKeyVersion: number | null;
  subjectCanonicalizationVersion: number | null;
  duplicateOverride: boolean;
  duplicateOfRequestId: string | null;
  status: string;
  policyVersion: number;
  deadlineAt: string;
  createdByActorId: string;
  createdAt: string;
  completedAt: string | null;
  currentAttemptId: string | null;
  version: number;
}

export interface PrivacyRequestStore {
  findById(id: string): Promise<PrivacyRequestRecord | null>;
  save(
    aggregate: PrivacyRequestAggregate,
    expectedVersion: number,
  ): Promise<void>;
}

export interface IdempotencyCommand {
  scope: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
}

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "in_progress" }
  | {
      state: "replay";
      responseStatus: number;
      responseBody: unknown;
    };

export interface IdempotencyCompletion extends IdempotencyCommand {
  responseStatus: number;
  responseBody: unknown;
}

export interface IdempotencyStore {
  claim(command: IdempotencyCommand): Promise<IdempotencyClaim>;
  complete(command: IdempotencyCompletion): Promise<void>;
}
