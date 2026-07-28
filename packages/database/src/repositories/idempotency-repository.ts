import type {
  IdempotencyClaim,
  IdempotencyCommand,
  IdempotencyCompletion,
  IdempotencyStore,
} from "@forgetops/application";
import type { Sql } from "postgres";
import { inTenantTransaction } from "../unit-of-work.js";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("IDEMPOTENCY_KEY_REUSED");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyRecordNotFoundError extends Error {
  readonly code = "IDEMPOTENCY_RECORD_NOT_FOUND";

  constructor() {
    super("IDEMPOTENCY_RECORD_NOT_FOUND");
    this.name = "IdempotencyRecordNotFoundError";
  }
}

interface IdempotencyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

export class IdempotencyRepository implements IdempotencyStore {
  constructor(
    private readonly client: Sql,
    private readonly tenantId: string,
  ) {}

  async claim(command: IdempotencyCommand): Promise<IdempotencyClaim> {
    return inTenantTransaction(
      this.client,
      this.tenantId,
      async (transaction) => {
        const inserted = await transaction<{ claimed: boolean }[]>`
        insert into idempotency_records (
          tenant_id, scope, actor_id, idempotency_key, request_hash, expires_at
        ) values (
          ${this.tenantId}, ${command.scope}, ${command.actorId},
          ${command.idempotencyKey}, ${command.requestHash}, ${command.expiresAt}
        )
        on conflict (tenant_id, scope, actor_id, idempotency_key) do nothing
        returning true as claimed
      `;
        if (inserted[0]) return { state: "claimed" };

        const rows = await transaction<IdempotencyRow[]>`
        select request_hash, response_status, response_body
        from idempotency_records
        where tenant_id = ${this.tenantId}
          and scope = ${command.scope}
          and actor_id = ${command.actorId}
          and idempotency_key = ${command.idempotencyKey}
      `;
        const row = rows[0];
        if (!row || row.request_hash !== command.requestHash) {
          throw new IdempotencyConflictError();
        }
        if (row.response_status === null) return { state: "in_progress" };
        return {
          state: "replay",
          responseStatus: row.response_status,
          responseBody: row.response_body,
        };
      },
    );
  }

  async complete(command: IdempotencyCompletion): Promise<void> {
    const responseBody = JSON.stringify(command.responseBody);
    if (responseBody === undefined) {
      throw new TypeError("IDEMPOTENCY_RESPONSE_NOT_JSON");
    }
    await inTenantTransaction(
      this.client,
      this.tenantId,
      async (transaction) => {
        const rows = await transaction<{ completed: boolean }[]>`
        update idempotency_records
        set response_status = ${command.responseStatus},
          response_body = ${responseBody}
        where tenant_id = ${this.tenantId}
          and scope = ${command.scope}
          and actor_id = ${command.actorId}
          and idempotency_key = ${command.idempotencyKey}
          and request_hash = ${command.requestHash}
          and response_status is null
        returning true as completed
      `;
        if (!rows[0]) throw new IdempotencyRecordNotFoundError();
      },
    );
  }
}
