import { z } from "zod";

export const SubjectIdentitySchema = z
  .object({
    userId: z.string().trim().min(1).max(512).optional(),
    email: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine((subject) => subject.userId || subject.email, {
    message: "SUBJECT_IDENTIFIER_REQUIRED",
  });

export type SubjectIdentity = z.infer<typeof SubjectIdentitySchema>;

export type ConnectorCapability =
  "discover" | "export" | "delete" | "anonymize" | "retain" | "verify";
export type ProposedAction =
  | "delete"
  | "anonymize"
  | "export"
  | "retain_by_policy"
  | "unsupported"
  | "needs_review";
export type RiskLevel = "low" | "medium" | "high";
export type LifecycleOutcome =
  | "deleted"
  | "anonymized"
  | "retained_by_policy"
  | "unsupported"
  | "needs_review";

export interface DiscoveryResult {
  estimatedCount: number;
  proposedAction: ProposedAction;
  risk: RiskLevel;
  dependencies?: string[];
  retentionReason?: string;
  localReference?: string;
}

export interface EraseResult {
  operationKey: string;
  affectedCount: number;
  outcome: LifecycleOutcome;
  reason?: string;
}

export interface VerificationResult {
  satisfied: boolean;
  remainingCount: number;
  reason?: string;
}

export interface ExportResult {
  exportedCount: number;
}

export interface ExportWriter {
  bytes(path: string, contentType: string, bytes: Uint8Array): Promise<void>;
  json(path: string, value: unknown): Promise<void>;
}

interface ResourceContext<Db> {
  subject: SubjectIdentity;
  db: Db;
}

export interface ResourceDefinition<Db = unknown> {
  name: string;
  capabilities: readonly ConnectorCapability[];
  healthCheck?(context: {
    db: Db;
  }): Promise<{ healthy: boolean; code?: string }>;
  discover(
    context: ResourceContext<Db> & {
      request: { requestId: string; requestType: string };
    },
  ): Promise<DiscoveryResult>;
  export?(
    context: ResourceContext<Db> & { writer: ExportWriter },
  ): Promise<ExportResult>;
  erase?(
    context: ResourceContext<Db> & {
      operationKey: string;
      action: ProposedAction;
      execution: {
        requestId: string;
        attemptId: string;
        stepId: string;
        idempotencyKey: string;
        dryRun: boolean;
      };
    },
  ): Promise<EraseResult>;
  verify?(
    context: ResourceContext<Db> & { expectedState: LifecycleOutcome },
  ): Promise<VerificationResult>;
}

const ResourceNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const RequestIdSchema = z.string().trim().min(1).max(256);

export const HealthRequestSchema = z.object({}).strict();
export const DiscoverRequestSchema = z
  .object({
    subject: SubjectIdentitySchema,
    request: z
      .object({
        requestId: RequestIdSchema,
        requestType: z.enum(["access", "delete"]),
      })
      .strict(),
  })
  .strict();
export const ExportRequestSchema = z
  .object({
    subject: SubjectIdentitySchema,
    selection: z
      .object({
        resources: z.array(ResourceNameSchema).min(1).max(128),
      })
      .strict(),
  })
  .strict();
export const EraseRequestSchema = z
  .object({
    subject: SubjectIdentitySchema,
    resource: ResourceNameSchema,
    plan: z
      .object({
        operationKey: z.string().trim().min(1).max(512),
        action: z.enum([
          "delete",
          "anonymize",
          "retain_by_policy",
          "unsupported",
          "needs_review",
        ]),
      })
      .strict(),
    context: z
      .object({
        requestId: RequestIdSchema,
        attemptId: RequestIdSchema,
        stepId: RequestIdSchema,
        idempotencyKey: z.string().trim().min(1).max(512),
        dryRun: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const VerifyRequestSchema = z
  .object({
    subject: SubjectIdentitySchema,
    resource: ResourceNameSchema,
    expectation: z
      .object({
        state: z.enum([
          "deleted",
          "anonymized",
          "retained_by_policy",
          "unsupported",
          "needs_review",
        ]),
      })
      .strict(),
  })
  .strict();
