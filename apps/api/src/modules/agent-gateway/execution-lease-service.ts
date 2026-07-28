import type {
  ExecutionAuthorizationClaims,
  ExecutionLeaseClaims,
} from "@forgetops/contracts";
import {
  ExecutionLeaseSigner,
  type SignedExecutionLease,
} from "@forgetops/signer";
import type { AuthorizationPolicyState } from "@forgetops/signer";

export interface ExecutionLeaseContextStore {
  getExecutionContext(attemptId: string):
    | Promise<{
        authorization: ExecutionAuthorizationClaims;
        state: AuthorizationPolicyState;
      } | null>
    | {
        authorization: ExecutionAuthorizationClaims;
        state: AuthorizationPolicyState;
      }
    | null;
}

export interface AcquireExecutionLeaseInput {
  attemptId: string;
  requestedStepIds: readonly string[];
  ttlMs?: number;
}

export class ExecutionLeaseService {
  constructor(
    private readonly store: ExecutionLeaseContextStore,
    private readonly signer: ExecutionLeaseSigner,
  ) {}

  async acquire(
    input: AcquireExecutionLeaseInput,
  ): Promise<SignedExecutionLease> {
    const context = await this.store.getExecutionContext(input.attemptId);
    if (!context) throw new Error("EXECUTION_ATTEMPT_NOT_FOUND");
    return this.signer.issue({
      authorization: context.authorization,
      state: context.state,
      requestedStepIds: input.requestedStepIds,
      ttlMs: input.ttlMs,
    });
  }

  static isActive(claims: ExecutionLeaseClaims, now = new Date()): boolean {
    return (
      Date.parse(claims.issuedAt) <= now.getTime() &&
      Date.parse(claims.expiresAt) > now.getTime()
    );
  }
}
