import { createHash, randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import type { PlanProjection } from "../execution-plans/plan-service.js";

export interface ApprovalEvidence {
  challengeId: string;
  evidenceHash: string;
  requestId: string;
  requestVersion: number;
  planId: string;
  planVersion: number;
  planFingerprint: string;
  decidedBy: string;
  decidedAt: string;
}

export class ApprovalServiceError extends Error {
  constructor(
    readonly code:
      | "APPROVAL_EVIDENCE_INVALID"
      | "SEPARATION_OF_DUTY_VIOLATION"
      | "PLAN_VERSION_MISMATCH"
      | "APPROVAL_NOT_FOUND",
  ) {
    super(code);
    this.name = "ApprovalServiceError";
  }
}

export class ApprovalService {
  private readonly approvals = new Map<string, ApprovalEvidence>();

  approve(input: {
    requestId: string;
    requestVersion: number;
    plan: PlanProjection;
    requesterActorId: string;
    approverActorId: string;
    challengeId?: string;
    now?: Date;
  }): ApprovalEvidence {
    if (input.requesterActorId === input.approverActorId) {
      throw new ApprovalServiceError("SEPARATION_OF_DUTY_VIOLATION");
    }
    if (input.plan.status === "expired") {
      throw new ApprovalServiceError("PLAN_VERSION_MISMATCH");
    }
    const decidedAt = (input.now ?? new Date()).toISOString();
    const challengeId = input.challengeId ?? randomBytes(16).toString("hex");
    const evidence = {
      challengeId,
      requestId: input.requestId,
      requestVersion: input.requestVersion,
      planId: input.plan.id,
      planVersion: input.plan.version,
      planFingerprint: input.plan.fingerprint,
      decidedBy: input.approverActorId,
      decidedAt,
    };
    const serialized = canonicalize(evidence);
    if (serialized === undefined) {
      throw new ApprovalServiceError("APPROVAL_EVIDENCE_INVALID");
    }
    const approval: ApprovalEvidence = Object.freeze({
      ...evidence,
      evidenceHash: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    });
    this.approvals.set(input.requestId, approval);
    return approval;
  }

  get(requestId: string): ApprovalEvidence {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new ApprovalServiceError("APPROVAL_NOT_FOUND");
    return approval;
  }

  assertCurrent(
    requestId: string,
    requestVersion: number,
    plan: PlanProjection,
  ): ApprovalEvidence {
    const approval = this.get(requestId);
    if (
      approval.requestVersion !== requestVersion ||
      approval.planId !== plan.id ||
      approval.planVersion !== plan.version ||
      approval.planFingerprint !== plan.fingerprint
    ) {
      throw new ApprovalServiceError("APPROVAL_EVIDENCE_INVALID");
    }
    return approval;
  }

  clear(requestId: string): void {
    this.approvals.delete(requestId);
  }
}
