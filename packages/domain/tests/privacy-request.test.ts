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
  request.authorizeExecution({ ...plan, agentId: "agt_1" });
  if (status === "execution_authorized") return request;

  request.markExecuting({ agentId: "agt_1" });
  if (status === "executing") return request;

  if (status === "completed") request.complete({ affectedCount: 3 });
  if (status === "partially_completed")
    request.markPartial({ affectedCount: 2, failedCount: 1 });
  if (status === "failed") request.fail({ category: "connector_error" });
  if (status === "cancelled") {
    const cancelled = created();
    cancelled.cancel({ actorId: "usr_1", reason: "duplicate" });
    return cancelled;
  }

  return request;
}

describe("PrivacyRequestAggregate transitions", () => {
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
      "identity_verified",
      "planning",
      (request) => request.beginPlanning({ agentId: "agt_1" }),
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
        request.authorizeExecution({ ...plan, agentId: "agt_1" });
      },
    ],
    [
      "planning",
      "failed",
      (request) => request.fail({ category: "planning_error" }),
    ],
    [
      "awaiting_approval",
      "execution_authorized",
      (request) => {
        request.approvePlan({ ...plan, decidedBy: "usr_2" });
        request.authorizeExecution({ ...plan, agentId: "agt_1" });
      },
    ],
    [
      "awaiting_approval",
      "cancelled",
      (request) => request.cancel({ actorId: "usr_1", reason: "withdrawn" }),
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
      authorizeExecution: (request: PrivacyRequestAggregate) =>
        request.authorizeExecution({ ...plan, agentId: "agt_1" }),
      markExecuting: (request: PrivacyRequestAggregate) =>
        request.markExecuting({ agentId: "agt_1" }),
      complete: (request: PrivacyRequestAggregate) =>
        request.complete({ affectedCount: 3 }),
      markPartial: (request: PrivacyRequestAggregate) =>
        request.markPartial({ affectedCount: 2, failedCount: 1 }),
      fail: (request: PrivacyRequestAggregate) =>
        request.fail({ category: "connector_error" }),
      cancel: (request: PrivacyRequestAggregate) =>
        request.cancel({ actorId: "usr_1", reason: "duplicate" }),
    };
    const allowed: Record<
      PrivacyRequestStatus,
      readonly (keyof typeof commands)[]
    > = {
      created: ["beginIdentityVerification", "markIdentityVerified", "cancel"],
      identity_verification_pending: ["markIdentityVerified", "cancel"],
      identity_verified: ["beginPlanning"],
      planning: ["attachPlan", "authorizeExecution", "fail"],
      awaiting_approval: ["approvePlan", "authorizeExecution", "cancel"],
      execution_authorized: ["markExecuting", "cancel"],
      executing: ["complete", "markPartial", "fail"],
      completed: [],
      partially_completed: [],
      failed: [],
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

  it.each(["completed", "partially_completed", "failed", "cancelled"] as const)(
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
        ...plan,
        ...stale,
        agentId: "agt_1",
      }),
    ).toThrow("PLAN_VERSION_MISMATCH");
  });

  it("requires approval before authorizing a plan that requires it", () => {
    const request = inStatus("awaiting_approval");

    expect(() =>
      request.authorizeExecution({ ...plan, agentId: "agt_1" }),
    ).toThrow(
      expect.objectContaining({
        code: "REQUEST_STATE_CONFLICT",
        fromState: "awaiting_approval",
        toState: "execution_authorized",
      }),
    );
  });

  it("requires an attached auto-execution plan before authorization", () => {
    const request = inStatus("planning");

    expect(() =>
      request.authorizeExecution({ ...plan, agentId: "agt_1" }),
    ).toThrow(StateConflictError);
  });
});

describe("events and snapshots", () => {
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
    request.authorizeExecution({ ...plan, agentId: "agt_1" });
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
      plan: null,
      approval: null,
    });
  });
});
