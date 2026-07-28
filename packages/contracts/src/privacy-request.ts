import { privacyRequestStatuses } from "@forgetops/domain";
import { z } from "zod";
import {
  AgentIdSchema,
  EnvironmentIdSchema,
  PlanIdSchema,
  RequestIdSchema,
} from "./ids.js";

export const PrivacyRequestStatusSchema = z.enum(privacyRequestStatuses);

export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatusSchema>;

const FingerprintSchema = z.string().regex(/^sha256:/);
const StepIdsSchema = z.array(z.string().min(1)).min(1);

export const ExecutionAuthorizationClaimsSchema = z
  .object({
    type: z.literal("forgetops.execution-authorization"),
    version: z.literal(1),
    keyId: z.string().min(1),
    issuer: z.literal("forgetops-control-plane"),
    audience: z.literal("forgetops-agent"),
    environmentId: EnvironmentIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    attemptId: z.string().min(1),
    authorizationKind: z.enum(["initial", "retry"]),
    planId: PlanIdSchema,
    planVersion: z.number().int().positive(),
    planFingerprint: FingerprintSchema,
    policyVersion: z.number().int().positive(),
    connectorConfigurationFingerprint: FingerprintSchema,
    allowedStepIds: StepIdsSchema,
    approvalEvidenceHash: FingerprintSchema,
    issuedAt: z.string().datetime(),
    notBefore: z.string().datetime(),
    expiresAt: z.string().datetime(),
    nonce: z.string().min(16),
  })
  .strict();

export type ExecutionAuthorizationClaims = z.infer<
  typeof ExecutionAuthorizationClaimsSchema
>;

export const ExecutionLeaseClaimsSchema = z
  .object({
    type: z.literal("forgetops.execution-lease"),
    version: z.literal(1),
    keyId: z.string().min(1),
    environmentId: EnvironmentIdSchema,
    agentId: AgentIdSchema,
    requestId: RequestIdSchema,
    attemptId: z.string().min(1),
    allowedStepIds: StepIdsSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    leaseId: z.string().min(16),
  })
  .strict()
  .superRefine((value, context) => {
    const ttlMs = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (ttlMs <= 0 || ttlMs > 90_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "EXECUTION_LEASE_TTL_INVALID",
      });
    }
  });

export type ExecutionLeaseClaims = z.infer<typeof ExecutionLeaseClaimsSchema>;
