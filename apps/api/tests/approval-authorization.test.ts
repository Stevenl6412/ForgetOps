import { describe, expect, it } from "vitest";
import {
  ApprovalService,
  ApprovalServiceError,
} from "../src/modules/approvals/approval-service.js";
import {
  ExecutionPlanService,
  PlanServiceError,
} from "../src/modules/execution-plans/plan-service.js";

function planService() {
  const service = new ExecutionPlanService();
  const plan = service.create({
    id: "plan_1",
    requestId: "req_1",
    version: 1,
    connectorConfigurationFingerprint: "sha256:connector",
    steps: [
      {
        id: "step_1",
        connector: "custom",
        resource: "profile",
        action: "erase",
        estimatedCount: 1,
        risk: "high",
        dependencies: [],
      },
    ],
    now: new Date("2026-07-24T00:00:00.000Z"),
  });
  return { service, plan };
}

describe("planning and approval projections", () => {
  it("fingerprints the exact plan and rejects stale versions", () => {
    const { service } = planService();
    expect(() =>
      service.create({
        id: "plan_old",
        requestId: "req_1",
        version: 1,
        connectorConfigurationFingerprint: "sha256:new",
        steps: [
          {
            id: "step_1",
            connector: "custom",
            resource: "profile",
            action: "erase",
            estimatedCount: 1,
            risk: "high",
            dependencies: [],
          },
        ],
      }),
    ).toThrowError(new PlanServiceError("PLAN_VERSION_MISMATCH"));
  });

  it("requires a different actor to approve and detects changed plans", () => {
    const { service, plan } = planService();
    const approvals = new ApprovalService();
    expect(() =>
      approvals.approve({
        requestId: "req_1",
        requestVersion: 7,
        plan,
        requesterActorId: "user_1",
        approverActorId: "user_1",
      }),
    ).toThrowError(new ApprovalServiceError("SEPARATION_OF_DUTY_VIOLATION"));

    const evidence = approvals.approve({
      requestId: "req_1",
      requestVersion: 7,
      plan,
      requesterActorId: "user_1",
      approverActorId: "reviewer_1",
    });
    expect(evidence.evidenceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => approvals.assertCurrent("req_1", 8, plan)).toThrowError(
      new ApprovalServiceError("APPROVAL_EVIDENCE_INVALID"),
    );
  });
});
