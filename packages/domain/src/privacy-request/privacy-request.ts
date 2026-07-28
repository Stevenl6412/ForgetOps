import { PlanVersionMismatchError, StateConflictError } from "./errors.js";
import type { PrivacyRequestStatus } from "./status.js";

export type PrivacyRequestType = "delete" | "export";
export type PrivacyRequestSource = "admin" | "privacy_portal" | "api";

const transitions: Record<
  PrivacyRequestStatus,
  readonly PrivacyRequestStatus[]
> = {
  created: ["identity_verification_pending", "identity_verified", "cancelled"],
  identity_verification_pending: ["identity_verified", "failed", "cancelled"],
  identity_verified: ["planning", "cancelled"],
  planning: [
    "awaiting_approval",
    "execution_authorized",
    "failed",
    "cancelled",
  ],
  awaiting_approval: ["execution_authorized", "planning", "cancelled"],
  execution_authorized: ["executing", "awaiting_approval", "cancelled"],
  executing: ["completed", "partially_completed", "failed", "needs_review"],
  completed: [],
  partially_completed: [
    "planning",
    "execution_authorized",
    "needs_review",
    "completed",
  ],
  failed: ["planning", "execution_authorized", "needs_review", "cancelled"],
  needs_review: [
    "planning",
    "execution_authorized",
    "partially_completed",
    "completed",
    "cancelled",
  ],
  cancelled: [],
};

type EventValue = string | number | boolean | null | readonly string[];

export interface DomainEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, EventValue>>;
}

export interface PlanBinding {
  planId: string;
  planVersion: number;
  planFingerprint: string;
}

export interface AttachedPlan extends PlanBinding {
  requiresApproval: boolean;
}

export interface PlanApproval extends PlanBinding {
  decidedBy: string;
}

export interface ExecutionAuthorization extends PlanBinding {
  agentId: string;
  attemptId: string;
  allowedStepIds: readonly string[];
}

export type ExecutionAttemptStatus =
  | "planned"
  | "awaiting_approval"
  | "authorized"
  | "running"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "needs_review"
  | "cancelled";

export interface ExecutionAttempt {
  readonly id: string;
  readonly requestId: string;
  readonly attemptNumber: number;
  readonly kind: "initial" | "retry";
  readonly planId: string;
  readonly planVersion: number;
  readonly planFingerprint: string;
  readonly allowedStepIds: readonly string[];
  readonly status: ExecutionAttemptStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface PrivacyRequestSnapshot {
  id: string;
  environmentId: string;
  type: PrivacyRequestType;
  source: PrivacyRequestSource;
  status: PrivacyRequestStatus;
  policyVersion: number;
  createdByActorId: string;
  deadlineAt: string;
  version: number;
  currentAttemptId: string | null;
  plan: AttachedPlan | null;
  approval: PlanApproval | null;
}

export interface CreatePrivacyRequest {
  id: string;
  environmentId: string;
  type: PrivacyRequestType;
  source: PrivacyRequestSource;
  policyVersion: number;
  createdByActorId: string;
  deadlineAt: string;
}

function event(type: string, payload: Record<string, EventValue>): DomainEvent {
  const immutablePayload = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      Array.isArray(value) ? Object.freeze([...value]) : value,
    ]),
  );
  return Object.freeze({
    type,
    payload: Object.freeze(immutablePayload),
  });
}

function normalizePlan(input: AttachedPlan): Readonly<AttachedPlan> {
  return Object.freeze({
    planId: input.planId,
    planVersion: input.planVersion,
    planFingerprint: input.planFingerprint,
    requiresApproval: input.requiresApproval,
  });
}

function normalizeApproval(input: PlanApproval): Readonly<PlanApproval> {
  return Object.freeze({
    planId: input.planId,
    planVersion: input.planVersion,
    planFingerprint: input.planFingerprint,
    decidedBy: input.decidedBy,
  });
}

function normalizeAuthorization(
  input: ExecutionAuthorization,
): Readonly<ExecutionAuthorization> {
  return Object.freeze({
    planId: input.planId,
    planVersion: input.planVersion,
    planFingerprint: input.planFingerprint,
    agentId: input.agentId,
    attemptId: input.attemptId,
    allowedStepIds: normalizeAllowedStepIds(input.allowedStepIds),
  });
}

function normalizeAllowedStepIds(
  allowedStepIds: readonly string[],
): readonly string[] {
  const normalized = [...allowedStepIds];
  if (
    normalized.length === 0 ||
    normalized.some((stepId) => !stepId) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new RangeError("EXECUTION_ATTEMPT_STEP_SCOPE_INVALID");
  }
  return Object.freeze(normalized);
}

function normalizeAuditReason(reason: string): string {
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(reason)) {
    throw new RangeError("AUDIT_REASON_INVALID");
  }
  return reason;
}

function freezeAttempt(attempt: ExecutionAttempt): Readonly<ExecutionAttempt> {
  return Object.freeze({
    ...attempt,
    allowedStepIds: Object.freeze([...attempt.allowedStepIds]),
  });
}

export class PrivacyRequestAggregate {
  readonly id: string;
  readonly environmentId: string;
  readonly type: PrivacyRequestType;
  readonly source: PrivacyRequestSource;
  readonly policyVersion: number;
  readonly createdByActorId: string;
  readonly deadlineAt: string;
  private _status: PrivacyRequestStatus;
  private _version: number;
  private _currentAttemptId: string | null = null;

  private plan: Readonly<AttachedPlan> | null = null;
  private approval: Readonly<PlanApproval> | null = null;
  private latestPlanVersion = 0;
  private attempts: readonly Readonly<ExecutionAttempt>[] = [];
  private readonly events: DomainEvent[] = [];
  private readonly now: () => string;

  private constructor(input: CreatePrivacyRequest, now: () => string) {
    this.id = input.id;
    this.environmentId = input.environmentId;
    this.type = input.type;
    this.source = input.source;
    this.policyVersion = input.policyVersion;
    this.createdByActorId = input.createdByActorId;
    this.deadlineAt = input.deadlineAt;
    this._status = "created";
    this._version = 1;
    this.now = now;
  }

  get status(): PrivacyRequestStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  get currentAttemptId(): string | null {
    return this._currentAttemptId;
  }

  static create(
    input: CreatePrivacyRequest,
    options: { now?: () => string } = {},
  ): PrivacyRequestAggregate {
    const request = new PrivacyRequestAggregate(
      input,
      options.now ?? (() => new Date().toISOString()),
    );
    request.events.push(
      event("PrivacyRequestCreated", {
        requestId: request.id,
        environmentId: request.environmentId,
        type: request.type,
        source: request.source,
        policyVersion: request.policyVersion,
      }),
    );
    return request;
  }

  beginIdentityVerification(input: { actorId: string }): void {
    this.transition(
      "identity_verification_pending",
      event("IdentityVerificationRequested", {
        requestId: this.id,
        actorId: input.actorId,
      }),
    );
  }

  markIdentityVerified(input: { actorId: string }): void {
    this.transition(
      "identity_verified",
      event("IdentityVerified", {
        requestId: this.id,
        actorId: input.actorId,
      }),
    );
  }

  beginPlanning(input: { agentId: string }): void {
    this.assertStatus("identity_verified", "planning");
    this.transition(
      "planning",
      event("PlanningRequested", {
        requestId: this.id,
        agentId: input.agentId,
      }),
    );
  }

  attachPlan(input: AttachedPlan): void {
    this.assertStatus("planning", "awaiting_approval");
    const attachedPlan = normalizePlan(input);
    if (attachedPlan.planVersion <= this.latestPlanVersion) {
      throw new PlanVersionMismatchError();
    }
    const planCreated = event("ExecutionPlanCreated", {
      requestId: this.id,
      planId: attachedPlan.planId,
      planVersion: attachedPlan.planVersion,
      planFingerprint: attachedPlan.planFingerprint,
      requiresApproval: attachedPlan.requiresApproval,
    });

    this.plan = attachedPlan;
    this.approval = null;
    this.latestPlanVersion = attachedPlan.planVersion;
    if (attachedPlan.requiresApproval) {
      this._status = "awaiting_approval";
      this.record(planCreated);
    } else {
      this.record(planCreated);
    }
  }

  approvePlan(input: PlanApproval): void {
    this.assertStatus("awaiting_approval", "awaiting_approval");
    const approval = normalizeApproval(input);
    this.assertPlanBinding(approval);
    const planApproved = event("ExecutionPlanApproved", {
      requestId: this.id,
      planId: approval.planId,
      planVersion: approval.planVersion,
      planFingerprint: approval.planFingerprint,
      decidedBy: approval.decidedBy,
    });

    this.approval = approval;
    this.record(planApproved);
  }

  rejectPlan(input: {
    decidedBy: string;
    disposition: "changes_requested" | "plan_rejected";
  }): void {
    const disposition = input.disposition;
    const decidedBy = input.decidedBy;
    this.assertStatus(
      "awaiting_approval",
      disposition === "changes_requested" ? "planning" : "cancelled",
    );
    const planRejected = event("ExecutionPlanRejected", {
      requestId: this.id,
      decidedBy,
      disposition,
    });

    this.approval = null;
    if (disposition === "changes_requested") {
      this.plan = null;
      this.transition("planning", planRejected);
      return;
    }
    this.transition("cancelled", planRejected);
  }

  authorizeExecution(input: ExecutionAuthorization): void {
    this.assertCanTransition("execution_authorized");
    if (this._status !== "planning" && this._status !== "awaiting_approval") {
      throw new StateConflictError(this._status, "execution_authorized");
    }
    if (!this.plan) {
      throw new StateConflictError(this._status, "execution_authorized");
    }
    const authorization = normalizeAuthorization(input);
    this.assertPlanBinding(authorization);
    if (
      (this._status === "planning" && this.plan.requiresApproval) ||
      (this._status === "awaiting_approval" && !this.approval)
    ) {
      throw new StateConflictError(this._status, "execution_authorized");
    }

    const executionAuthorized = event("ExecutionAuthorized", {
      requestId: this.id,
      planId: authorization.planId,
      planVersion: authorization.planVersion,
      planFingerprint: authorization.planFingerprint,
      agentId: authorization.agentId,
      attemptId: authorization.attemptId,
      authorizationKind: "initial",
      allowedStepIds: authorization.allowedStepIds,
    });
    const attempt = this.buildAttempt({
      id: authorization.attemptId,
      kind: "initial",
      binding: authorization,
      allowedStepIds: authorization.allowedStepIds,
      status: "authorized",
    });

    this.appendAttempt(attempt);
    this.transition("execution_authorized", executionAuthorized);
  }

  markExecuting(input: { agentId: string }): void {
    this.assertStatus("execution_authorized", "executing");
    const attemptUpdate = this.updatedCurrentAttempt("running", null);
    const executionStarted = event("ExecutionStarted", {
      requestId: this.id,
      agentId: input.agentId,
      attemptId: attemptUpdate.id,
    });

    this.applyAttemptUpdate(attemptUpdate);
    this.transition("executing", executionStarted);
  }

  complete(input: { affectedCount: number }): void {
    this.assertStatus("executing", "completed");
    const attemptUpdate = this.updatedCurrentAttempt("succeeded", this.now());
    const completed = event("PrivacyRequestCompleted", {
      requestId: this.id,
      affectedCount: input.affectedCount,
      attemptId: attemptUpdate.id,
    });

    this.applyAttemptUpdate(attemptUpdate);
    this.transition("completed", completed);
  }

  markPartial(input: { affectedCount: number; failedCount: number }): void {
    this.assertCanTransition("partially_completed");
    const attemptUpdate =
      this._status === "executing"
        ? this.updatedCurrentAttempt("partially_succeeded", this.now())
        : null;
    const partiallyCompleted = event("PrivacyRequestPartiallyCompleted", {
      requestId: this.id,
      affectedCount: input.affectedCount,
      failedCount: input.failedCount,
      attemptId: this._currentAttemptId,
    });

    if (attemptUpdate) this.applyAttemptUpdate(attemptUpdate);
    this.transition("partially_completed", partiallyCompleted);
  }

  fail(_input: { category: string }): void {
    this.assertCanTransition("failed");
    const attemptUpdate =
      this._status === "executing"
        ? this.updatedCurrentAttempt("failed", this.now())
        : null;
    const failed = event("PrivacyRequestFailed", {
      requestId: this.id,
      attemptId: this._currentAttemptId,
    });

    if (attemptUpdate) this.applyAttemptUpdate(attemptUpdate);
    this.transition("failed", failed);
  }

  markNeedsReview(_input: { category: string }): void {
    this.assertCanTransition("needs_review");
    const attemptUpdate =
      this._status === "executing"
        ? this.updatedCurrentAttempt("needs_review", this.now())
        : null;
    const needsReview = event("PrivacyRequestNeedsReview", {
      requestId: this.id,
      attemptId: this._currentAttemptId,
    });

    if (attemptUpdate) this.applyAttemptUpdate(attemptUpdate);
    this.transition("needs_review", needsReview);
  }

  requestReplan(input: { actorId: string; reason: string }): void {
    this.assertCanTransition("planning");
    if (
      this._status !== "partially_completed" &&
      this._status !== "failed" &&
      this._status !== "needs_review"
    ) {
      throw new StateConflictError(this._status, "planning");
    }
    const reason = normalizeAuditReason(input.reason);
    const replanRequested = event("ReplanRequested", {
      requestId: this.id,
      actorId: input.actorId,
      reason,
    });

    this.plan = null;
    this.approval = null;
    this.transition("planning", replanRequested);
  }

  beginRetry(input: {
    attemptId: string;
    allowedStepIds: readonly string[];
    expectedVersion: number;
  }): void {
    this.assertCanTransition("execution_authorized");
    if (
      this._status !== "partially_completed" &&
      this._status !== "failed" &&
      this._status !== "needs_review"
    ) {
      throw new StateConflictError(this._status, "execution_authorized");
    }
    if (input.expectedVersion !== this._version) {
      throw new RangeError("REQUEST_VERSION_MISMATCH");
    }
    if (!this.plan) {
      throw new StateConflictError(this._status, "execution_authorized");
    }

    const allowedStepIds = normalizeAllowedStepIds(input.allowedStepIds);
    const attempt = this.buildAttempt({
      id: input.attemptId,
      kind: "retry",
      binding: this.plan,
      allowedStepIds,
      status: "authorized",
    });
    const retryAuthorized = event("ExecutionAuthorized", {
      requestId: this.id,
      planId: attempt.planId,
      planVersion: attempt.planVersion,
      planFingerprint: attempt.planFingerprint,
      attemptId: attempt.id,
      authorizationKind: "retry",
      allowedStepIds: attempt.allowedStepIds,
    });

    this.appendAttempt(attempt);
    this.transition("execution_authorized", retryAuthorized);
  }

  invalidateAuthorization(input: { actorId: string; reason: string }): void {
    this.assertStatus("execution_authorized", "awaiting_approval");
    const reason = normalizeAuditReason(input.reason);
    const attemptUpdate = this.updatedCurrentAttempt("cancelled", this.now());
    const authorizationInvalidated = event(
      "ExecutionAuthorizationInvalidated",
      {
        requestId: this.id,
        actorId: input.actorId,
        reason,
        attemptId: this._currentAttemptId,
      },
    );

    this.applyAttemptUpdate(attemptUpdate);
    this.approval = null;
    this.transition("awaiting_approval", authorizationInvalidated);
  }

  acceptRetainedOutcome(input: { actorId: string; reason: string }): void {
    if (
      this._status !== "partially_completed" &&
      this._status !== "needs_review"
    ) {
      throw new StateConflictError(this._status, "completed");
    }
    const reason = normalizeAuditReason(input.reason);
    this.transition(
      "completed",
      event("RetainedOutcomeAccepted", {
        requestId: this.id,
        actorId: input.actorId,
        reason,
        attemptId: this._currentAttemptId,
      }),
    );
  }

  cancel(input: { actorId: string; reason: string }): void {
    this.assertCanTransition("cancelled");
    const reason = normalizeAuditReason(input.reason);
    const attemptUpdate =
      this._status === "execution_authorized"
        ? this.updatedCurrentAttempt("cancelled", this.now())
        : null;
    const cancelled = event("PrivacyRequestCancelled", {
      requestId: this.id,
      actorId: input.actorId,
      reason,
      attemptId: this._currentAttemptId,
    });

    if (attemptUpdate) this.applyAttemptUpdate(attemptUpdate);
    this.transition("cancelled", cancelled);
  }

  snapshot(): PrivacyRequestSnapshot {
    return {
      id: this.id,
      environmentId: this.environmentId,
      type: this.type,
      source: this.source,
      status: this._status,
      policyVersion: this.policyVersion,
      createdByActorId: this.createdByActorId,
      deadlineAt: this.deadlineAt,
      version: this._version,
      currentAttemptId: this._currentAttemptId,
      plan: this.plan && { ...this.plan },
      approval: this.approval && { ...this.approval },
    };
  }

  executionAttempts(): readonly Readonly<ExecutionAttempt>[] {
    return this.attempts.slice();
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0);
  }

  pendingEvents(): readonly DomainEvent[] {
    return this.events.slice();
  }

  markEventsCommitted(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.events.length) {
      throw new RangeError("INVALID_COMMITTED_EVENT_COUNT");
    }
    this.events.splice(0, count);
  }

  private assertStatus(
    expected: PrivacyRequestStatus,
    target: PrivacyRequestStatus,
  ): void {
    if (this._status !== expected) {
      throw new StateConflictError(this._status, target);
    }
  }

  private assertCanTransition(next: PrivacyRequestStatus): void {
    if (!transitions[this._status].includes(next)) {
      throw new StateConflictError(this._status, next);
    }
  }

  private assertPlanBinding(binding: PlanBinding): void {
    if (
      !this.plan ||
      this.plan.planId !== binding.planId ||
      this.plan.planVersion !== binding.planVersion ||
      this.plan.planFingerprint !== binding.planFingerprint
    ) {
      throw new PlanVersionMismatchError();
    }
  }

  private buildAttempt(input: {
    id: string;
    kind: "initial" | "retry";
    binding: PlanBinding;
    allowedStepIds: readonly string[];
    status: ExecutionAttemptStatus;
  }): Readonly<ExecutionAttempt> {
    if (!input.id || this.attempts.some((attempt) => attempt.id === input.id)) {
      throw new RangeError("EXECUTION_ATTEMPT_ID_INVALID");
    }
    return freezeAttempt({
      id: input.id,
      requestId: this.id,
      attemptNumber: this.attempts.length + 1,
      kind: input.kind,
      planId: input.binding.planId,
      planVersion: input.binding.planVersion,
      planFingerprint: input.binding.planFingerprint,
      allowedStepIds: input.allowedStepIds,
      status: input.status,
      createdAt: this.now(),
      completedAt: null,
    });
  }

  private appendAttempt(attempt: Readonly<ExecutionAttempt>): void {
    this.attempts = [...this.attempts, attempt];
    this._currentAttemptId = attempt.id;
  }

  private requiredCurrentAttempt(): Readonly<ExecutionAttempt> {
    const attempt = this.attempts.find(
      ({ id }) => id === this._currentAttemptId,
    );
    if (!attempt) throw new RangeError("EXECUTION_ATTEMPT_NOT_FOUND");
    return attempt;
  }

  private updatedCurrentAttempt(
    status: ExecutionAttemptStatus,
    completedAt: string | null,
  ): Readonly<ExecutionAttempt> {
    return freezeAttempt({
      ...this.requiredCurrentAttempt(),
      status,
      completedAt,
    });
  }

  private applyAttemptUpdate(updated: Readonly<ExecutionAttempt>): void {
    this.attempts = this.attempts.map((attempt) =>
      attempt.id === updated.id ? updated : attempt,
    );
  }

  private record(domainEvent: DomainEvent): void {
    this._version += 1;
    this.events.push(domainEvent);
  }

  private transition(
    next: PrivacyRequestStatus,
    domainEvent: DomainEvent,
  ): void {
    this.assertCanTransition(next);
    this._status = next;
    this.record(domainEvent);
  }
}
