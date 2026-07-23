import type { PrivacyRequestStatus } from "@forgetops/contracts/src/privacy-request.js";

export class StateConflictError extends Error {
  readonly code = "REQUEST_STATE_CONFLICT";

  constructor(
    readonly fromState: PrivacyRequestStatus,
    readonly toState: PrivacyRequestStatus,
  ) {
    super("REQUEST_STATE_CONFLICT");
    this.name = "StateConflictError";
  }
}

export class PlanVersionMismatchError extends Error {
  readonly code = "PLAN_VERSION_MISMATCH";

  constructor() {
    super("PLAN_VERSION_MISMATCH");
    this.name = "PlanVersionMismatchError";
  }
}
