import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export type PlanRisk = "low" | "medium" | "high";

export interface PlanStep {
  id: string;
  connector: string;
  resource: string;
  action: "discover" | "export" | "erase" | "verify";
  estimatedCount: number;
  risk: PlanRisk;
  dependencies: readonly string[];
}

export interface PlanProjection {
  id: string;
  requestId: string;
  version: number;
  fingerprint: string;
  connectorConfigurationFingerprint: string;
  steps: readonly PlanStep[];
  requiresApproval: boolean;
  status: "draft" | "awaiting_approval" | "approved" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface CreatePlanInput {
  id: string;
  requestId: string;
  version: number;
  connectorConfigurationFingerprint: string;
  steps: readonly PlanStep[];
  requiresApproval?: boolean;
  now?: Date;
  ttlMs?: number;
}

export class PlanServiceError extends Error {
  constructor(
    readonly code:
      | "PLAN_INVALID"
      | "PLAN_VERSION_MISMATCH"
      | "PLAN_NOT_FOUND"
      | "PLAN_EXPIRED",
  ) {
    super(code);
    this.name = "PlanServiceError";
  }
}

export class ExecutionPlanService {
  private readonly plans = new Map<string, PlanProjection>();

  create(input: CreatePlanInput): PlanProjection {
    const existing = this.plans.get(input.requestId);
    if (existing && input.version <= existing.version) {
      throw new PlanServiceError("PLAN_VERSION_MISMATCH");
    }
    validateSteps(input.steps);
    if (!Number.isInteger(input.version) || input.version <= 0) {
      throw new PlanServiceError("PLAN_INVALID");
    }
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? 30 * 60 * 1000;
    if (ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new PlanServiceError("PLAN_INVALID");
    }
    const normalized = {
      connectorConfigurationFingerprint:
        input.connectorConfigurationFingerprint,
      steps: input.steps.map((step) => ({
        ...step,
        dependencies: [...step.dependencies],
      })),
    };
    const plan: PlanProjection = Object.freeze({
      id: input.id,
      requestId: input.requestId,
      version: input.version,
      fingerprint: planFingerprint(normalized),
      connectorConfigurationFingerprint:
        input.connectorConfigurationFingerprint,
      steps: Object.freeze(
        normalized.steps.map((step) =>
          Object.freeze({
            ...step,
            dependencies: Object.freeze([...step.dependencies]),
          }),
        ),
      ),
      requiresApproval: input.requiresApproval ?? true,
      status: input.requiresApproval === false ? "draft" : "awaiting_approval",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    this.plans.set(input.requestId, plan);
    return plan;
  }

  get(requestId: string, now = new Date()): PlanProjection {
    const plan = this.plans.get(requestId);
    if (!plan) throw new PlanServiceError("PLAN_NOT_FOUND");
    if (Date.parse(plan.expiresAt) <= now.getTime()) {
      if (plan.status !== "expired") {
        this.plans.set(
          requestId,
          Object.freeze({ ...plan, status: "expired" }),
        );
      }
      throw new PlanServiceError("PLAN_EXPIRED");
    }
    return plan;
  }

  markApproved(requestId: string, expectedVersion: number): PlanProjection {
    const plan = this.get(requestId);
    if (plan.version !== expectedVersion) {
      throw new PlanServiceError("PLAN_VERSION_MISMATCH");
    }
    const approved = Object.freeze({ ...plan, status: "approved" as const });
    this.plans.set(requestId, approved);
    return approved;
  }

  selectSteps(requestId: string, stepIds: readonly string[]): PlanStep[] {
    const plan = this.get(requestId);
    const selected = new Set(stepIds);
    if (
      selected.size !== stepIds.length ||
      stepIds.length === 0 ||
      stepIds.some((id) => !plan.steps.some((step) => step.id === id))
    ) {
      throw new PlanServiceError("PLAN_INVALID");
    }
    return plan.steps
      .filter((step) => selected.has(step.id))
      .map((step) => ({ ...step, dependencies: [...step.dependencies] }));
  }
}

export function planFingerprint(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new PlanServiceError("PLAN_INVALID");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function validateSteps(steps: readonly PlanStep[]): void {
  if (steps.length === 0) throw new PlanServiceError("PLAN_INVALID");
  const ids = new Set<string>();
  for (const step of steps) {
    if (
      !step.id ||
      ids.has(step.id) ||
      !step.connector ||
      !step.resource ||
      !Number.isInteger(step.estimatedCount) ||
      step.estimatedCount < 0 ||
      step.dependencies.includes(step.id)
    ) {
      throw new PlanServiceError("PLAN_INVALID");
    }
    ids.add(step.id);
  }
  for (const step of steps) {
    if (step.dependencies.some((dependency) => !ids.has(dependency))) {
      throw new PlanServiceError("PLAN_INVALID");
    }
  }
}
