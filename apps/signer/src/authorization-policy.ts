import type {
  ExecutionAuthorizationClaims,
  ExecutionLeaseClaims,
} from "@forgetops/contracts";

export interface AuthorizationPolicyState {
  request: {
    id: string;
    environmentId: string;
    version: number;
    policyVersion: number;
    status: string;
    cancelled?: boolean;
  };
  plan: {
    id: string;
    version: number;
    fingerprint: string;
    connectorConfigurationFingerprint: string;
    stepIds: readonly string[];
    requiresApproval: boolean;
  };
  approval: {
    evidenceHash: string;
    decidedBy: string;
    decidedAt: string;
    requestVersion: number;
    planVersion: number;
    planFingerprint: string;
  } | null;
  agent: {
    id: string;
    environmentId: string;
    status: "online" | "outdated" | "draining" | "revoked";
  };
  executionPaused: boolean;
}

export interface AuthorizationPolicyInput {
  state: AuthorizationPolicyState;
  actorId: string;
  expectedRequestVersion: number;
  requestedStepIds: readonly string[];
  authorizationKind: "initial" | "retry";
}

export class AuthorizationPolicyError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_GLOBALLY_PAUSED"
      | "REQUEST_VERSION_MISMATCH"
      | "PLAN_VERSION_MISMATCH"
      | "APPROVAL_EVIDENCE_INVALID"
      | "SEPARATION_OF_DUTY_VIOLATION"
      | "AGENT_NOT_ELIGIBLE"
      | "REQUEST_NOT_AUTHORIZABLE"
      | "STEP_SCOPE_INVALID",
  ) {
    super(code);
    this.name = "AuthorizationPolicyError";
  }
}

export function assertAuthorizationPolicy(
  input: AuthorizationPolicyInput,
): void {
  const { state, actorId, expectedRequestVersion, requestedStepIds } = input;
  if (state.executionPaused) {
    throw new AuthorizationPolicyError("EXECUTION_GLOBALLY_PAUSED");
  }
  if (state.request.cancelled || state.request.status === "cancelled") {
    throw new AuthorizationPolicyError("REQUEST_NOT_AUTHORIZABLE");
  }
  if (state.request.version !== expectedRequestVersion) {
    throw new AuthorizationPolicyError("REQUEST_VERSION_MISMATCH");
  }
  if (
    ![
      "planning",
      "awaiting_approval",
      "partially_completed",
      "failed",
      "needs_review",
    ].includes(state.request.status)
  ) {
    throw new AuthorizationPolicyError("REQUEST_NOT_AUTHORIZABLE");
  }
  if (
    state.agent.status === "revoked" ||
    state.agent.environmentId !== state.request.environmentId
  ) {
    throw new AuthorizationPolicyError("AGENT_NOT_ELIGIBLE");
  }
  if (
    state.plan.version <= 0 ||
    (state.plan.version !== state.approval?.planVersion &&
      state.plan.requiresApproval &&
      input.authorizationKind === "initial")
  ) {
    if (state.plan.requiresApproval && input.authorizationKind === "initial") {
      throw new AuthorizationPolicyError("APPROVAL_EVIDENCE_INVALID");
    }
  }
  if (state.plan.requiresApproval && input.authorizationKind === "initial") {
    const approval = state.approval;
    if (
      !approval ||
      approval.planVersion !== state.plan.version ||
      approval.planFingerprint !== state.plan.fingerprint ||
      approval.requestVersion > state.request.version
    ) {
      throw new AuthorizationPolicyError("APPROVAL_EVIDENCE_INVALID");
    }
    if (approval.decidedBy === actorId) {
      throw new AuthorizationPolicyError("SEPARATION_OF_DUTY_VIOLATION");
    }
  }
  const allowed = new Set(state.plan.stepIds);
  if (
    requestedStepIds.length === 0 ||
    requestedStepIds.some((stepId) => !allowed.has(stepId)) ||
    new Set(requestedStepIds).size !== requestedStepIds.length
  ) {
    throw new AuthorizationPolicyError("STEP_SCOPE_INVALID");
  }
}

export interface LeasePolicyInput {
  authorization: ExecutionAuthorizationClaims;
  state: AuthorizationPolicyState;
  requestedStepIds: readonly string[];
  now: Date;
}

export function assertExecutionLeasePolicy(input: LeasePolicyInput): void {
  const { authorization, state, requestedStepIds, now } = input;
  if (state.executionPaused) {
    throw new AuthorizationPolicyError("EXECUTION_GLOBALLY_PAUSED");
  }
  if (
    authorization.environmentId !== state.request.environmentId ||
    authorization.agentId !== state.agent.id ||
    authorization.requestId !== state.request.id ||
    authorization.planVersion !== state.plan.version ||
    authorization.planFingerprint !== state.plan.fingerprint ||
    state.agent.status === "revoked" ||
    state.agent.status === "draining"
  ) {
    throw new AuthorizationPolicyError("AGENT_NOT_ELIGIBLE");
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new AuthorizationPolicyError("REQUEST_NOT_AUTHORIZABLE");
  }
  const authorized = new Set(authorization.allowedStepIds);
  if (
    requestedStepIds.length === 0 ||
    requestedStepIds.some((stepId) => !authorized.has(stepId)) ||
    new Set(requestedStepIds).size !== requestedStepIds.length
  ) {
    throw new AuthorizationPolicyError("STEP_SCOPE_INVALID");
  }
}

export function assertLeaseClaimsBound(
  lease: ExecutionLeaseClaims,
  authorization: ExecutionAuthorizationClaims,
): void {
  if (
    lease.environmentId !== authorization.environmentId ||
    lease.agentId !== authorization.agentId ||
    lease.requestId !== authorization.requestId ||
    lease.attemptId !== authorization.attemptId ||
    lease.allowedStepIds.some(
      (stepId) => !authorization.allowedStepIds.includes(stepId),
    )
  ) {
    throw new AuthorizationPolicyError("STEP_SCOPE_INVALID");
  }
}
