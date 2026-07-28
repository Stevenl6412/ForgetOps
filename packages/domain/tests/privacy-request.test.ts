import { describe, expect, it } from "vitest";
import {
  PlanVersionMismatchError,
  PrivacyRequestAggregate,
  StateConflictError,
  type PrivacyRequestStatus,
} from "../src/privacy-request/index.js";

const plan = {
  planId: "plan_1",
  planVersion: 4,
  planFingerprint: "sha256:new",
};
const initialAuthorization = {
  ...plan,
  agentId: "agt_1",
  attemptId: "att_1",
  allowedStepIds: ["step_1", "step_failed"],
};

function throwOnSecondRead<T extends Record<string, unknown>>(values: T) {
  const reads: Record<string, number> = {};
  const input = {};

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        if (reads[key] > 1) throw new Error(`${key} read more than once`);
        return value;
      },
    });
  }

  return { input: input as T, reads };
}

function created() {
  return PrivacyRequestAggregate.create({
    id: "req_1",
    environmentId: "env_1",
    type: "delete",
    source: "admin",
    policyVersion: 1,
    createdByActorId: "usr_1",
    deadlineAt: "2026-08-20T00:00:00.000Z",
  });
}

function inStatus(status: PrivacyRequestStatus) {
  const request = created();
  if (status === "created") return request;

  if (status === "identity_verification_pending") {
    request.beginIdentityVerification({ actorId: "usr_1" });
    return request;
  }

  request.markIdentityVerified({ actorId: "usr_1" });
  if (status === "identity_verified") return request;

  request.beginPlanning({ agentId: "agt_1" });
  if (status === "planning") return request;

  request.attachPlan({ ...plan, requiresApproval: true });
  if (status === "awaiting_approval") return request;

  request.approvePlan({ ...plan, decidedBy: "usr_2" });
  request.authorizeExecution(initialAuthorization);
  if (status === "execution_authorized") return request;

  request.markExecuting({ agentId: "agt_1" });
  if (status === "executing") return request;

  if (status === "completed") request.complete({ affectedCount: 3 });
  if (status === "partially_completed")
    request.markPartial({ affectedCount: 2, failedCount: 1 });
  if (status === "failed") request.fail({ category: "connector_error" });
  if (status === "needs_review")
    request.markNeedsReview({ category: "uncertain_remote_effect" });
  if (status === "cancelled") {
    const cancelled = created();
    cancelled.cancel({ actorId: "usr_1", reason: "duplicate" });
    return cancelled;
  }

  return request;
}

describe("PrivacyRequestAggregate transitions", () => {
  it("exposes status and version as read-only state", () => {
    const request = created();

    expect(Reflect.set(request, "status", "completed")).toBe(false);
    expect(Reflect.set(request, "version", 99)).toBe(false);
    expect(request.status).toBe("created");
    expect(request.version).toBe(1);

    if (false) {
      // @ts-expect-error aggregate state changes only through commands
      request.status = "completed";
      // @ts-expect-error aggregate version changes only through commands
      request.version = 99;
    }
  });

  it.each([
    [
      "created",
      "identity_verification_pending",
      (request) => request.beginIdentityVerification({ actorId: "usr_1" }),
    ],
    [
      "created",
      "identity_verified",
      (request) => request.markIdentityVerified({ actorId: "usr_1" }),
    ],
    [
      "created",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "duplicate" }),
    ],
    [
      "identity_verification_pending",
      "identity_verified",
      (request) => request.markIdentityVerified({ actorId: "usr_1" }),
    ],
    [
      "identity_verification_pending",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "duplicate" }),
    ],
    [
      "identity_verification_pending",
      "failed",
      (request) => request.fail({ category: "identity_provider_error" }),
    ],
    [
      "identity_verified",
      "planning",
      (request) => request.beginPlanning({ agentId: "agt_1" }),
    ],
    [
      "identity_verified",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
    [
      "planning",
      "awaiting_approval",
      (request) => request.attachPlan({ ...plan, requiresApproval: true }),
    ],
    [
      "planning",
      "execution_authorized",
      (request) => {
        request.attachPlan({ ...plan, requiresApproval: false });
        request.authorizeExecution(initialAuthorization);
      },
    ],
    [
      "planning",
      "failed",
      (request) => request.fail({ category: "planning_error" }),
    ],
    [
      "planning",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
    [
      "awaiting_approval",
      "execution_authorized",
      (request) => {
        request.approvePlan({ ...plan, decidedBy: "usr_2" });
        request.authorizeExecution(initialAuthorization);
      },
    ],
    [
      "awaiting_approval",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
    [
      "awaiting_approval",
      "planning",
      (request) =>
        request.rejectPlan({
          decidedBy: "usr_2",
          disposition: "changes_requested",
        }),
    ],
    [
      "execution_authorized",
      "executing",
      (request) => request.markExecuting({ agentId: "agt_1" }),
    ],
    [
      "execution_authorized",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
    [
      "execution_authorized",
      "awaiting_approval",
      (request) =>
        request.invalidateAuthorization({
          actorId: "usr_1",
          reason: "authorization_expired",
        }),
    ],
    [
      "executing",
      "completed",
      (request) => request.complete({ affectedCount: 3 }),
    ],
    [
      "executing",
      "partially_completed",
      (request) => request.markPartial({ affectedCount: 2, failedCount: 1 }),
    ],
    [
      "executing",
      "failed",
      (request) => request.fail({ category: "connector_error" }),
    ],
    [
      "executing",
      "needs_review",
      (request) =>
        request.markNeedsReview({ category: "uncertain_remote_effect" }),
    ],
    [
      "partially_completed",
      "planning",
      (request) =>
        request.requestReplan({
          actorId: "usr_1",
          reason: "connector_configuration_changed",
        }),
    ],
    [
      "partially_completed",
      "execution_authorized",
      (request) =>
        request.beginRetry({
          attemptId: "att_2",
          allowedStepIds: ["step_failed"],
          expectedVersion: request.version,
        }),
    ],
    [
      "partially_completed",
      "needs_review",
      (request) =>
        request.markNeedsReview({ category: "uncertain_remote_effect" }),
    ],
    [
      "partially_completed",
      "completed",
      (request) =>
        request.acceptRetainedOutcome({
          actorId: "usr_2",
          reason: "retained_outcome_accepted",
        }),
    ],
    [
      "failed",
      "planning",
      (request) =>
        request.requestReplan({
          actorId: "usr_1",
          reason: "connector_configuration_changed",
        }),
    ],
    [
      "failed",
      "execution_authorized",
      (request) =>
        request.beginRetry({
          attemptId: "att_2",
          allowedStepIds: ["step_failed"],
          expectedVersion: request.version,
        }),
    ],
    [
      "failed",
      "needs_review",
      (request) =>
        request.markNeedsReview({ category: "uncertain_remote_effect" }),
    ],
    [
      "failed",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
    [
      "needs_review",
      "planning",
      (request) =>
        request.requestReplan({
          actorId: "usr_1",
          reason: "connector_configuration_changed",
        }),
    ],
    [
      "needs_review",
      "execution_authorized",
      (request) =>
        request.beginRetry({
          attemptId: "att_2",
          allowedStepIds: ["step_failed"],
          expectedVersion: request.version,
        }),
    ],
    [
      "needs_review",
      "partially_completed",
      (request) => request.markPartial({ affectedCount: 2, failedCount: 1 }),
    ],
    [
      "needs_review",
      "completed",
      (request) =>
        request.acceptRetainedOutcome({
          actorId: "usr_2",
          reason: "retained_outcome_accepted",
        }),
    ],
    [
      "needs_review",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
    ],
  ] satisfies readonly (readonly [
    PrivacyRequestStatus,
    PrivacyRequestStatus,
    (request: PrivacyRequestAggregate) => void,
  ])[])("allows %s -> %s", (from, to, command) => {
    const request = inStatus(from);
    const before = request.version;

    command(request);

    expect(request.status).toBe(to);
    expect(request.version).toBeGreaterThan(before);
  });

  it("rejects every command from states where its transition is illegal", () => {
    const commands = {
      beginIdentityVerification: (request: PrivacyRequestAggregate) =>
        request.beginIdentityVerification({ actorId: "usr_1" }),
      markIdentityVerified: (request: PrivacyRequestAggregate) =>
        request.markIdentityVerified({ actorId: "usr_1" }),
      beginPlanning: (request: PrivacyRequestAggregate) =>
        request.beginPlanning({ agentId: "agt_1" }),
      attachPlan: (request: PrivacyRequestAggregate) =>
        request.attachPlan({ ...plan, requiresApproval: true }),
      approvePlan: (request: PrivacyRequestAggregate) =>
        request.approvePlan({ ...plan, decidedBy: "usr_2" }),
      rejectPlan: (request: PrivacyRequestAggregate) =>
        request.rejectPlan({
          decidedBy: "usr_2",
          disposition: "changes_requested",
        }),
      authorizeExecution: (request: PrivacyRequestAggregate) =>
        request.authorizeExecution(initialAuthorization),
      markExecuting: (request: PrivacyRequestAggregate) =>
        request.markExecuting({ agentId: "agt_1" }),
      complete: (request: PrivacyRequestAggregate) =>
        request.complete({ affectedCount: 3 }),
      markPartial: (request: PrivacyRequestAggregate) =>
        request.markPartial({ affectedCount: 2, failedCount: 1 }),
      fail: (request: PrivacyRequestAggregate) =>
        request.fail({ category: "connector_error" }),
      markNeedsReview: (request: PrivacyRequestAggregate) =>
        request.markNeedsReview({ category: "uncertain_remote_effect" }),
      requestReplan: (request: PrivacyRequestAggregate) =>
        request.requestReplan({
          actorId: "usr_1",
          reason: "connector_configuration_changed",
        }),
      beginRetry: (request: PrivacyRequestAggregate) =>
        request.beginRetry({
          attemptId: "att_2",
          allowedStepIds: ["step_failed"],
          expectedVersion: request.version,
        }),
      invalidateAuthorization: (request: PrivacyRequestAggregate) =>
        request.invalidateAuthorization({
          actorId: "usr_1",
          reason: "authorization_expired",
        }),
      acceptRetainedOutcome: (request: PrivacyRequestAggregate) =>
        request.acceptRetainedOutcome({
          actorId: "usr_2",
          reason: "retained_outcome_accepted",
        }),
      cancel: (request: PrivacyRequestAggregate) =>
        request.cancel({ actorId: "usr_1", reason: "duplicate" }),
    };
    const allowed: Record<
      PrivacyRequestStatus,
      readonly (keyof typeof commands)[]
    > = {
      created: ["beginIdentityVerification", "markIdentityVerified", "cancel"],
      identity_verification_pending: ["markIdentityVerified", "fail", "cancel"],
      identity_verified: ["beginPlanning", "cancel"],
      planning: ["attachPlan", "authorizeExecution", "fail", "cancel"],
      awaiting_approval: [
        "approvePlan",
        "rejectPlan",
        "authorizeExecution",
        "cancel",
      ],
      execution_authorized: [
        "markExecuting",
        "invalidateAuthorization",
        "cancel",
      ],
      executing: ["complete", "markPartial", "fail", "markNeedsReview"],
      completed: [],
      partially_completed: [
        "markNeedsReview",
        "requestReplan",
        "beginRetry",
        "acceptRetainedOutcome",
      ],
      failed: ["markNeedsReview", "requestReplan", "beginRetry", "cancel"],
      needs_review: [
        "markPartial",
        "requestReplan",
        "beginRetry",
        "acceptRetainedOutcome",
        "cancel",
      ],
      cancelled: [],
    };

    for (const status of Object.keys(allowed) as PrivacyRequestStatus[]) {
      for (const [name, command] of Object.entries(commands)) {
        if (allowed[status].includes(name as keyof typeof commands)) continue;

        const request = inStatus(status);
        const version = request.version;
        const eventsBefore = request.pullEvents();

        expect(() => command(request), `${status}: ${name}`).toThrow(
          StateConflictError,
        );
        expect(request.version).toBe(version);
        expect(request.pullEvents()).toEqual([]);
        expect(eventsBefore.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(["completed", "cancelled"] as const)(
    "keeps %s terminal",
    (status) => {
      const request = inStatus(status);
      expect(() => request.markIdentityVerified({ actorId: "usr_1" })).toThrow(
        expect.objectContaining({
          code: "REQUEST_STATE_CONFLICT",
          fromState: status,
          toState: "identity_verified",
        }),
      );
    },
  );
});

describe("plan binding and authorization", () => {
  it("reads an attached plan input exactly once before committing it", () => {
    const request = inStatus("planning");
    const { input, reads } = throwOnSecondRead({
      ...plan,
      requiresApproval: false,
    });

    request.attachPlan(input);

    expect(Object.values(reads)).toEqual([1, 1, 1, 1]);
    expect(request.snapshot().plan).toEqual({
      ...plan,
      requiresApproval: false,
    });
    expect(request.pullEvents().at(-1)?.payload).toMatchObject(plan);
  });

  it("reads an approval input exactly once before committing it", () => {
    const request = inStatus("awaiting_approval");
    const { input, reads } = throwOnSecondRead({
      ...plan,
      decidedBy: "usr_2",
    });

    request.approvePlan(input);

    expect(Object.values(reads)).toEqual([1, 1, 1, 1]);
    expect(request.snapshot().approval).toEqual({
      ...plan,
      decidedBy: "usr_2",
    });
    expect(request.pullEvents().at(-1)?.payload).toMatchObject(plan);
  });

  it("reads an authorization input exactly once before committing it", () => {
    const request = inStatus("awaiting_approval");
    request.approvePlan({ ...plan, decidedBy: "usr_2" });
    const { input, reads } = throwOnSecondRead({
      ...initialAuthorization,
    });

    request.authorizeExecution(input);

    expect(Object.values(reads)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(request.status).toBe("execution_authorized");
    expect(request.pullEvents().at(-1)?.payload).toMatchObject(plan);
  });

  it("preserves snapshot and queued events when plan normalization throws", () => {
    const request = inStatus("planning");
    const before = request.snapshot();
    const input = Object.defineProperties(
      {},
      {
        planId: { enumerable: true, get: () => "plan_1" },
        planVersion: {
          enumerable: true,
          get() {
            throw new Error("accessor failed");
          },
        },
        planFingerprint: { enumerable: true, get: () => "sha256:new" },
        requiresApproval: { enumerable: true, get: () => true },
      },
    );

    expect(() =>
      request.attachPlan(input as typeof plan & { requiresApproval: boolean }),
    ).toThrow("accessor failed");
    expect(request.snapshot()).toEqual(before);
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
    ]);
  });

  it("preserves snapshot and queued events when approval is stale", () => {
    const request = inStatus("awaiting_approval");
    const before = request.snapshot();

    expect(() =>
      request.approvePlan({
        ...plan,
        planFingerprint: "sha256:stale",
        decidedBy: "usr_2",
      }),
    ).toThrow("PLAN_VERSION_MISMATCH");
    expect(request.snapshot()).toEqual(before);
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
      "ExecutionPlanCreated",
    ]);
  });

  it("preserves snapshot and queued events when approval normalization throws", () => {
    const request = inStatus("awaiting_approval");
    const before = request.snapshot();
    const input = {
      ...plan,
      get decidedBy(): string {
        throw new Error("approval accessor failed");
      },
    };

    expect(() => request.approvePlan(input)).toThrow(
      "approval accessor failed",
    );
    expect(request.snapshot()).toEqual(before);
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
      "ExecutionPlanCreated",
    ]);
  });

  it("preserves snapshot and queued events when authorization is stale", () => {
    const request = inStatus("awaiting_approval");
    request.approvePlan({ ...plan, decidedBy: "usr_2" });
    const before = request.snapshot();

    expect(() =>
      request.authorizeExecution({
        ...initialAuthorization,
        planVersion: 3,
      }),
    ).toThrow("PLAN_VERSION_MISMATCH");
    expect(request.snapshot()).toEqual(before);
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
      "ExecutionPlanCreated",
      "ExecutionPlanApproved",
    ]);
  });

  it("preserves snapshot and queued events when authorization normalization throws", () => {
    const request = inStatus("awaiting_approval");
    request.approvePlan({ ...plan, decidedBy: "usr_2" });
    const before = request.snapshot();
    const input = {
      ...initialAuthorization,
      get agentId(): string {
        throw new Error("authorization accessor failed");
      },
    };

    expect(() => request.authorizeExecution(input)).toThrow(
      "authorization accessor failed",
    );
    expect(request.snapshot()).toEqual(before);
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
      "ExecutionPlanCreated",
      "ExecutionPlanApproved",
    ]);
  });

  it("records an auto-execution plan without authorizing execution", () => {
    const request = inStatus("planning");
    request.pullEvents();
    const before = request.version;

    request.attachPlan({ ...plan, requiresApproval: false });

    expect(request.status).toBe("planning");
    expect(request.version).toBe(before + 1);
    expect(request.snapshot().plan).toEqual({
      ...plan,
      requiresApproval: false,
    });
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "ExecutionPlanCreated",
    ]);
  });

  it("approves only the exact current plan and remains awaiting approval", () => {
    const request = inStatus("awaiting_approval");
    request.pullEvents();
    const before = request.version;

    request.approvePlan({ ...plan, decidedBy: "usr_2" });

    expect(request.status).toBe("awaiting_approval");
    expect(request.version).toBe(before + 1);
    expect(request.snapshot().approval).toEqual({
      ...plan,
      decidedBy: "usr_2",
    });
    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "ExecutionPlanApproved",
    ]);
  });

  it.each([
    ["planId", { planId: "plan_stale" }],
    ["planVersion", { planVersion: 3 }],
    ["planFingerprint", { planFingerprint: "sha256:old" }],
  ] as const)("rejects stale approval %s", (_field, stale) => {
    const request = inStatus("awaiting_approval");

    expect(() =>
      request.approvePlan({ ...plan, ...stale, decidedBy: "usr_2" }),
    ).toThrow(PlanVersionMismatchError);
    expect(() =>
      request.approvePlan({ ...plan, ...stale, decidedBy: "usr_2" }),
    ).toThrow("PLAN_VERSION_MISMATCH");
  });

  it.each([
    ["planId", { planId: "plan_stale" }],
    ["planVersion", { planVersion: 3 }],
    ["planFingerprint", { planFingerprint: "sha256:old" }],
  ] as const)("rejects stale authorization %s", (_field, stale) => {
    const request = inStatus("awaiting_approval");
    request.approvePlan({ ...plan, decidedBy: "usr_2" });

    expect(() =>
      request.authorizeExecution({
        ...initialAuthorization,
        ...stale,
      }),
    ).toThrow("PLAN_VERSION_MISMATCH");
  });

  it("requires approval before authorizing a plan that requires it", () => {
    const request = inStatus("awaiting_approval");

    expect(() => request.authorizeExecution(initialAuthorization)).toThrow(
      expect.objectContaining({
        code: "REQUEST_STATE_CONFLICT",
        fromState: "awaiting_approval",
        toState: "execution_authorized",
      }),
    );
  });

  it("requires an attached auto-execution plan before authorization", () => {
    const request = inStatus("planning");

    expect(() => request.authorizeExecution(initialAuthorization)).toThrow(
      StateConflictError,
    );
  });

  it("creates a new immutable attempt for a selected-step retry", () => {
    const request = inStatus("partially_completed");
    const firstAttempt = request.executionAttempts()[0];

    request.beginRetry({
      attemptId: "att_2",
      allowedStepIds: ["step_failed"],
      expectedVersion: request.version,
    });

    expect(request.currentAttemptId).toBe("att_2");
    expect(request.status).toBe("execution_authorized");
    expect(request.executionAttempts()).toEqual([
      firstAttempt,
      expect.objectContaining({
        id: "att_2",
        attemptNumber: 2,
        kind: "retry",
        allowedStepIds: ["step_failed"],
        status: "authorized",
      }),
    ]);
    expect(Object.isFrozen(firstAttempt)).toBe(true);
    expect(Object.isFrozen(firstAttempt?.allowedStepIds)).toBe(true);
  });

  it("leaves state, attempts, and events unchanged for a stale retry", () => {
    const request = inStatus("failed");
    request.pullEvents();
    const snapshot = request.snapshot();
    const attempts = request.executionAttempts();

    expect(() =>
      request.beginRetry({
        attemptId: "att_2",
        allowedStepIds: ["step_failed"],
        expectedVersion: request.version - 1,
      }),
    ).toThrow("REQUEST_VERSION_MISMATCH");

    expect(request.snapshot()).toEqual(snapshot);
    expect(request.executionAttempts()).toEqual(attempts);
    expect(request.pullEvents()).toEqual([]);
  });

  it.each([
    { allowedStepIds: [] as string[] },
    { allowedStepIds: [""] },
    { allowedStepIds: ["step_failed", "step_failed"] },
  ])(
    "rejects an invalid retry step scope without mutation",
    ({ allowedStepIds }) => {
      const request = inStatus("failed");
      request.pullEvents();
      const snapshot = request.snapshot();
      const attempts = request.executionAttempts();

      expect(() =>
        request.beginRetry({
          attemptId: "att_2",
          allowedStepIds,
          expectedVersion: request.version,
        }),
      ).toThrow("EXECUTION_ATTEMPT_STEP_SCOPE_INVALID");

      expect(request.snapshot()).toEqual(snapshot);
      expect(request.executionAttempts()).toEqual(attempts);
      expect(request.pullEvents()).toEqual([]);
    },
  );

  it("does not reuse an earlier attempt id", () => {
    const request = inStatus("failed");

    expect(() =>
      request.beginRetry({
        attemptId: "att_1",
        allowedStepIds: ["step_failed"],
        expectedVersion: request.version,
      }),
    ).toThrow("EXECUTION_ATTEMPT_ID_INVALID");
    expect(request.executionAttempts()).toHaveLength(1);
  });

  it("returns a rejected plan to planning when changes are requested", () => {
    const request = inStatus("awaiting_approval");

    request.rejectPlan({
      decidedBy: "usr_2",
      disposition: "changes_requested",
    });

    expect(request.status).toBe("planning");
    expect(request.snapshot().plan).toBeNull();
    expect(request.snapshot().approval).toBeNull();
  });

  it("requires a newer plan version after changes are requested", () => {
    const request = inStatus("awaiting_approval");
    request.rejectPlan({
      decidedBy: "usr_2",
      disposition: "changes_requested",
    });

    expect(() =>
      request.attachPlan({ ...plan, requiresApproval: true }),
    ).toThrow(PlanVersionMismatchError);

    request.attachPlan({
      ...plan,
      planVersion: 5,
      requiresApproval: true,
    });
    expect(request.status).toBe("awaiting_approval");
  });

  it("cancels a rejected plan with the audited disposition", () => {
    const request = inStatus("awaiting_approval");
    request.pullEvents();

    request.rejectPlan({
      decidedBy: "usr_2",
      disposition: "plan_rejected",
    });

    expect(request.status).toBe("cancelled");
    expect(request.pullEvents()).toEqual([
      expect.objectContaining({
        type: "ExecutionPlanRejected",
        payload: expect.objectContaining({
          decidedBy: "usr_2",
          disposition: "plan_rejected",
        }),
      }),
    ]);
  });

  it("invalidates an unused authorization and cancels only that attempt", () => {
    const request = inStatus("execution_authorized");

    request.invalidateAuthorization({
      actorId: "usr_1",
      reason: "authorization_expired",
    });

    expect(request.status).toBe("awaiting_approval");
    expect(request.snapshot().approval).toBeNull();
    expect(request.executionAttempts()).toEqual([
      expect.objectContaining({
        id: "att_1",
        status: "cancelled",
        completedAt: expect.any(String),
      }),
    ]);
  });

  it("audits acceptance of a retained partial outcome", () => {
    const request = inStatus("partially_completed");
    request.pullEvents();

    request.acceptRetainedOutcome({
      actorId: "usr_2",
      reason: "retained_outcome_accepted",
    });

    expect(request.status).toBe("completed");
    expect(request.pullEvents()).toEqual([
      expect.objectContaining({
        type: "RetainedOutcomeAccepted",
        payload: expect.objectContaining({
          actorId: "usr_2",
          reason: "retained_outcome_accepted",
          attemptId: "att_1",
        }),
      }),
    ]);
  });

  it("keeps failed requests retryable through an explicit replan", () => {
    const request = inStatus("failed");

    request.requestReplan({
      actorId: "usr_1",
      reason: "connector_configuration_changed",
    });

    expect(request.status).toBe("planning");
  });
});

describe("events and snapshots", () => {
  it("retains pending events until persistence acknowledges them", () => {
    const request = created();
    const captured = request.pendingEvents();

    expect(captured.map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
    ]);
    expect(request.pendingEvents()).toEqual(captured);
  });

  it("acknowledges only the captured event prefix", () => {
    const request = created();
    const capturedCount = request.pendingEvents().length;
    request.markIdentityVerified({ actorId: "usr_1" });

    request.markEventsCommitted(capturedCount);

    expect(request.pendingEvents().map((event) => event.type)).toEqual([
      "IdentityVerified",
    ]);
  });

  it("rejects invalid event acknowledgement without draining events", () => {
    const request = created();

    expect(() => request.markEventsCommitted(2)).toThrow(RangeError);
    expect(request.pendingEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
    ]);
  });

  it("names identity-verification initiation as a request", () => {
    const request = created();

    request.beginIdentityVerification({ actorId: "usr_1" });

    expect(request.pullEvents().map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerificationRequested",
    ]);
  });

  it("does not emit unrestricted failure text", () => {
    const secret = "connector_error password=hunter2";
    const request = inStatus("planning");

    request.fail({ category: secret });

    expect(JSON.stringify(request.pullEvents())).not.toContain(secret);
  });

  it("emits immutable sanitized events in order and drains them on read", () => {
    const request = created();
    request.markIdentityVerified({ actorId: "usr_1" });
    request.beginPlanning({ agentId: "agt_1" });

    const events = request.pullEvents();

    expect(events.map((event) => event.type)).toEqual([
      "PrivacyRequestCreated",
      "IdentityVerified",
      "PlanningRequested",
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);
    expect(events.every((event) => Object.isFrozen(event.payload))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("deadlineAt");
    expect(request.pullEvents()).toEqual([]);
  });

  it("increments the version for every accepted mutation", () => {
    const request = created();
    expect(request.version).toBe(1);
    request.markIdentityVerified({ actorId: "usr_1" });
    request.beginPlanning({ agentId: "agt_1" });
    request.attachPlan({ ...plan, requiresApproval: true });
    request.approvePlan({ ...plan, decidedBy: "usr_2" });
    request.authorizeExecution(initialAuthorization);
    expect(request.version).toBe(6);
  });

  it("returns a serializable detached snapshot", () => {
    const request = created();
    const snapshot = request.snapshot();
    snapshot.plan = { ...plan, requiresApproval: false };

    expect(JSON.parse(JSON.stringify(request.snapshot()))).toEqual({
      id: "req_1",
      environmentId: "env_1",
      type: "delete",
      source: "admin",
      status: "created",
      policyVersion: 1,
      createdByActorId: "usr_1",
      deadlineAt: "2026-08-20T00:00:00.000Z",
      version: 1,
      currentAttemptId: null,
      plan: null,
      approval: null,
    });
  });
});
