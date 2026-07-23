import type { PrivacyRequestStatus } from "@forgetops/contracts";
import { PlanVersionMismatchError, StateConflictError } from "./errors.js";

export type PrivacyRequestType = "delete" | "export";
export type PrivacyRequestSource = "admin" | "privacy_portal" | "api";

const transitions: Record<
  PrivacyRequestStatus,
  readonly PrivacyRequestStatus[]
> = {
  created: ["identity_verification_pending", "identity_verified", "cancelled"],
  identity_verification_pending: ["identity_verified", "cancelled"],
  identity_verified: ["planning"],
  planning: ["awaiting_approval", "execution_authorized", "failed"],
  awaiting_approval: ["execution_authorized", "cancelled"],
  execution_authorized: ["executing", "cancelled"],
  executing: ["completed", "partially_completed", "failed"],
  completed: [],
  partially_completed: [],
  failed: [],
  cancelled: [],
};

type EventValue = string | number | boolean | null;

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
  return Object.freeze({ type, payload: Object.freeze({ ...payload }) });
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

  private plan: Readonly<AttachedPlan> | null = null;
  private approval: Readonly<PlanApproval> | null = null;
  private readonly events: DomainEvent[] = [];

  private constructor(input: CreatePrivacyRequest) {
    this.id = input.id;
    this.environmentId = input.environmentId;
    this.type = input.type;
    this.source = input.source;
    this.policyVersion = input.policyVersion;
    this.createdByActorId = input.createdByActorId;
    this.deadlineAt = input.deadlineAt;
    this._status = "created";
    this._version = 1;
  }

  get status(): PrivacyRequestStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  static create(input: CreatePrivacyRequest): PrivacyRequestAggregate {
    const request = new PrivacyRequestAggregate(input);
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
    this.transition(
      "planning",
      event("PlanningRequested", {
        requestId: this.id,
        agentId: input.agentId,
      }),
    );
  }

  attachPlan(input: AttachedPlan): void {
    this.assertCanTransition("awaiting_approval");
    const attachedPlan = normalizePlan(input);
    const planCreated = event("ExecutionPlanCreated", {
      requestId: this.id,
      planId: attachedPlan.planId,
      planVersion: attachedPlan.planVersion,
      planFingerprint: attachedPlan.planFingerprint,
      requiresApproval: attachedPlan.requiresApproval,
    });

    this.plan = attachedPlan;
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

  authorizeExecution(input: ExecutionAuthorization): void {
    this.assertCanTransition("execution_authorized");
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
    });
    this.transition("execution_authorized", executionAuthorized);
  }

  markExecuting(input: { agentId: string }): void {
    this.transition(
      "executing",
      event("ExecutionStarted", {
        requestId: this.id,
        agentId: input.agentId,
      }),
    );
  }

  complete(input: { affectedCount: number }): void {
    this.transition(
      "completed",
      event("PrivacyRequestCompleted", {
        requestId: this.id,
        affectedCount: input.affectedCount,
      }),
    );
  }

  markPartial(input: { affectedCount: number; failedCount: number }): void {
    this.transition(
      "partially_completed",
      event("PrivacyRequestPartiallyCompleted", {
        requestId: this.id,
        affectedCount: input.affectedCount,
        failedCount: input.failedCount,
      }),
    );
  }

  fail(_input: { category: string }): void {
    this.transition(
      "failed",
      event("PrivacyRequestFailed", {
        requestId: this.id,
      }),
    );
  }

  cancel(input: { actorId: string; reason: string }): void {
    this.transition(
      "cancelled",
      event("PrivacyRequestCancelled", {
        requestId: this.id,
        actorId: input.actorId,
      }),
    );
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
      plan: this.plan && { ...this.plan },
      approval: this.approval && { ...this.approval },
    };
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
