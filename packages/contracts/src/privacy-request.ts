import { z } from "zod";
import {
  AgentIdSchema,
  EnvironmentIdSchema,
  PlanIdSchema,
  RequestIdSchema,
} from "./ids.js";

export const PrivacyRequestStatusSchema = z.enum([
  "created",
  "identity_verification_pending",
  "identity_verified",
  "planning",
  "awaiting_approval",
  "execution_authorized",
  "executing",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

export type PrivacyRequestStatus = z.infer<typeof PrivacyRequestStatusSchema>;

export const ExecutionAuthorizationClaimsSchema = z.object({
  issuer: z.literal("forgetops-control-plane"),
  environmentId: EnvironmentIdSchema,
  agentId: AgentIdSchema,
  requestId: RequestIdSchema,
  planId: PlanIdSchema,
  planVersion: z.number().int().positive(),
  planFingerprint: z.string().regex(/^sha256:/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16),
});

export type ExecutionAuthorizationClaims = z.infer<
  typeof ExecutionAuthorizationClaimsSchema
>;
