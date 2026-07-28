import type { Sql } from "postgres";
import { inTenantTransaction } from "@forgetops/database";
import { keyIdForPublicKey } from "../agents/signature-verifier.js";

export const JOB_LEASE_MS = 60_000;

export type AgentJobKind =
  | "bind_subject"
  | "plan"
  | "execute"
  | "lease_execution"
  | "wrap_export_key"
  | "cancel"
  | "health_check";

export interface AgentJobRecord {
  id: string;
  tenantId: string;
  requestId: string;
  environmentId: string;
  kind: AgentJobKind;
  planVersion: number | null;
  payloadCiphertext: string | null;
  authorization: string | null;
  availableAt: string;
  expiresAt: string;
  leasedByAgentId: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  completedAt: string | null;
  createdAt: string;
}

export interface EnqueueAgentJobInput {
  id: string;
  tenantId: string;
  requestId: string;
  environmentId: string;
  kind: AgentJobKind;
  planVersion: number | null;
  payloadCiphertext: string | null;
  authorization: string | null;
  availableAt: string;
  expiresAt: string;
}

export interface AgentJobLookup {
  tenantId: string;
  agentId: string;
  environmentId: string;
  now: string;
}

export interface AgentJobMutation extends AgentJobLookup {
  jobId: string;
}

export type GatewayAgentStatus =
  "pairing" | "online" | "offline" | "outdated" | "revoked";

export type AgentTransport = "websocket" | "polling";

export interface AgentTransportInput {
  tenantId: string;
  agentId: string;
  environmentId: string;
  transport: AgentTransport;
  sessionId: string;
  now: string;
}

export interface GatewayAgentIdentity {
  agentId: string;
  tenantId: string;
  environmentId: string;
  publicSigningKey: string;
  signingKeyId: string;
  protocolVersion: string;
  status: GatewayAgentStatus;
}

export type AgentMessageClaimResult =
  "accepted" | "not_found" | "environment_mismatch" | "revoked" | "replay";

export interface ClaimAgentMessageInput {
  tenantId: string;
  agentId: string;
  environmentId: string;
  messageId: string;
  sequence: string;
  receivedAt: string;
}

export interface AgentAuthenticationStore {
  findAgentIdentity(agentId: string): Promise<GatewayAgentIdentity | null>;
  claimAgentMessage(
    input: ClaimAgentMessageInput,
  ): Promise<AgentMessageClaimResult>;
  claimTransport(input: AgentTransportInput): Promise<string | null>;
  isTransportActive(input: AgentTransportInput): Promise<boolean>;
  releaseTransport(input: AgentTransportInput): Promise<void>;
}

export interface JobRepository extends AgentAuthenticationStore {
  enqueue(input: EnqueueAgentJobInput): Promise<AgentJobRecord>;
  poll(input: AgentJobLookup): Promise<AgentJobRecord | null>;
  lease(input: AgentJobMutation): Promise<AgentJobRecord | null>;
  heartbeat(input: AgentJobMutation): Promise<AgentJobRecord | null>;
  nextControlSequence(tenantId: string, agentId: string): Promise<string>;
}

type DateLike = Date | string;

interface AgentIdentityRow {
  agentId: string;
  tenantId: string;
  environmentId: string;
  publicSigningKey: string;
  signingKeyId: string | null;
  protocolVersion: string;
  status: GatewayAgentStatus;
  lastSequence: string;
}

interface AgentTransportRow {
  sessionId: string;
}

interface AgentJobRow {
  id: string;
  tenantId: string;
  requestId: string;
  environmentId: string;
  kind: AgentJobKind;
  planVersion: number | null;
  payloadCiphertext: string | null;
  authorization: string | null;
  availableAt: DateLike;
  expiresAt: DateLike;
  leasedByAgentId: string | null;
  leaseExpiresAt: DateLike | null;
  attempt: number;
  completedAt: DateLike | null;
  createdAt: DateLike;
}

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly client: Sql) {}

  async findAgentIdentity(
    agentId: string,
  ): Promise<GatewayAgentIdentity | null> {
    const rows = await this.client<AgentIdentityRow[]>`
      select agent_id as "agentId", tenant_id as "tenantId",
             environment_id as "environmentId",
             public_signing_key as "publicSigningKey",
             signing_key_id as "signingKeyId",
             protocol_version as "protocolVersion", status,
             last_sequence as "lastSequence"
      from lookup_agent_identity(${agentId})
    `;
    return rows[0] ? toIdentity(rows[0]) : null;
  }

  async claimAgentMessage(
    input: ClaimAgentMessageInput,
  ): Promise<AgentMessageClaimResult> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<AgentIdentityRow[]>`
        select a.id as "agentId", p.tenant_id as "tenantId",
               a.environment_id as "environmentId",
               a.public_signing_key as "publicSigningKey",
               a.signing_key_id as "signingKeyId",
               a.protocol_version as "protocolVersion", a.status,
               a.last_sequence as "lastSequence"
        from agents a
        inner join environments e on e.id = a.environment_id
        inner join projects p on p.id = e.project_id
        where a.id = ${input.agentId}
        for update of a
      `;
        const agent = rows[0];
        if (!agent) return "not_found";
        if (
          agent.tenantId !== input.tenantId ||
          agent.environmentId !== input.environmentId
        ) {
          return "environment_mismatch";
        }
        if (agent.status === "revoked") return "revoked";
        if (BigInt(input.sequence) <= BigInt(agent.lastSequence)) {
          return "replay";
        }
        const duplicate = await transaction<{ present: number }[]>`
        select 1 as present
        from agent_message_receipts
        where agent_id = ${input.agentId}
          and (message_id = ${input.messageId} or sequence = ${input.sequence})
      `;
        if (duplicate[0]) return "replay";

        await transaction`
        insert into agent_message_receipts (
          agent_id, message_id, sequence, received_at
        ) values (
          ${input.agentId}, ${input.messageId}, ${input.sequence},
          ${input.receivedAt}
        )
      `;
        await transaction`
        update agents
        set last_sequence = ${input.sequence}, last_seen_at = ${input.receivedAt}
        where id = ${input.agentId}
      `;
        return "accepted";
      },
    );
  }

  async claimTransport(input: AgentTransportInput): Promise<string | null> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const agents = await transaction<
          { environmentId: string; status: GatewayAgentStatus }[]
        >`
        select environment_id as "environmentId", status
        from agents
        where id = ${input.agentId}
        for update
      `;
        const agent = agents[0];
        if (
          !agent ||
          agent.environmentId !== input.environmentId ||
          agent.status === "revoked"
        ) {
          return null;
        }

        const current = await transaction<AgentTransportRow[]>`
        select session_id as "sessionId"
        from agent_transport_sessions
        where agent_id = ${input.agentId}
        for update
      `;
        await transaction`
        insert into agent_transport_sessions (
          agent_id, tenant_id, environment_id, transport, session_id,
          started_at, last_seen_at
        ) values (
          ${input.agentId}, ${input.tenantId}, ${input.environmentId},
          ${input.transport}, ${input.sessionId}, ${input.now}, ${input.now}
        )
        on conflict (agent_id) do update
        set tenant_id = excluded.tenant_id,
            environment_id = excluded.environment_id,
            transport = excluded.transport,
            session_id = excluded.session_id,
            last_seen_at = excluded.last_seen_at
      `;
        return current[0]?.sessionId ?? null;
      },
    );
  }

  async isTransportActive(input: AgentTransportInput): Promise<boolean> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<{ present: number }[]>`
        select 1 as present
        from agent_transport_sessions
        where agent_id = ${input.agentId}
          and environment_id = ${input.environmentId}
          and transport = ${input.transport}
          and session_id = ${input.sessionId}
      `;
        return rows.length > 0;
      },
    );
  }

  async releaseTransport(input: AgentTransportInput): Promise<void> {
    await inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        await transaction`
        delete from agent_transport_sessions
        where agent_id = ${input.agentId}
          and environment_id = ${input.environmentId}
          and transport = ${input.transport}
          and session_id = ${input.sessionId}
      `;
      },
    );
  }

  async enqueue(input: EnqueueAgentJobInput): Promise<AgentJobRecord> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<AgentJobRow[]>`
        insert into agent_jobs (
          id, tenant_id, request_id, environment_id, kind, plan_version,
          payload_ciphertext, authorization_payload, available_at, expires_at
        )
        select
          ${input.id}, ${input.tenantId}, ${input.requestId},
          ${input.environmentId}, ${input.kind}, ${input.planVersion},
          ${input.payloadCiphertext}, ${input.authorization},
          ${input.availableAt}, ${input.expiresAt}
        from privacy_requests r
        where r.id = ${input.requestId}
          and r.tenant_id = ${input.tenantId}
          and r.environment_id = ${input.environmentId}
        returning id, tenant_id as "tenantId", request_id as "requestId",
                  environment_id as "environmentId", kind,
                  plan_version as "planVersion",
                  payload_ciphertext as "payloadCiphertext",
                  authorization_payload as authorization,
                  available_at as "availableAt", expires_at as "expiresAt",
                  leased_by_agent_id as "leasedByAgentId",
                  lease_expires_at as "leaseExpiresAt", attempt,
                  completed_at as "completedAt", created_at as "createdAt"
      `;
        if (!rows[0]) throw new Error("Agent job scope does not exist");
        return normalizeJob(rows[0]);
      },
    );
  }

  async poll(input: AgentJobLookup): Promise<AgentJobRecord | null> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<AgentJobRow[]>`
        select j.id, j.tenant_id as "tenantId", j.request_id as "requestId",
               j.environment_id as "environmentId", j.kind,
               j.plan_version as "planVersion",
               j.payload_ciphertext as "payloadCiphertext",
               j.authorization_payload as authorization,
               j.available_at as "availableAt", j.expires_at as "expiresAt",
               j.leased_by_agent_id as "leasedByAgentId",
               j.lease_expires_at as "leaseExpiresAt", j.attempt,
               j.completed_at as "completedAt", j.created_at as "createdAt"
        from agent_jobs j
        where j.environment_id = ${input.environmentId}
          and j.available_at <= ${input.now}
          and j.expires_at > ${input.now}
          and j.completed_at is null
          and (j.lease_expires_at is null or j.lease_expires_at <= ${input.now})
          and exists (
            select 1 from agents a
            where a.id = ${input.agentId}
              and a.environment_id = j.environment_id
              and a.status in ('online', 'outdated')
          )
        order by j.available_at, j.id
        limit 1
      `;
        return rows[0] ? normalizeJob(rows[0]) : null;
      },
    );
  }

  async lease(input: AgentJobMutation): Promise<AgentJobRecord | null> {
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const agents = await transaction<{ id: string }[]>`
        select id from agents
        where id = ${input.agentId}
          and environment_id = ${input.environmentId}
          and status in ('online', 'outdated')
        for update
      `;
        if (!agents[0]) return null;

        const rows = await transaction<AgentJobRow[]>`
        select j.id, j.tenant_id as "tenantId", j.request_id as "requestId",
               j.environment_id as "environmentId", j.kind,
               j.plan_version as "planVersion",
               j.payload_ciphertext as "payloadCiphertext",
               j.authorization_payload as authorization,
               j.available_at as "availableAt", j.expires_at as "expiresAt",
               j.leased_by_agent_id as "leasedByAgentId",
               j.lease_expires_at as "leaseExpiresAt", j.attempt,
               j.completed_at as "completedAt", j.created_at as "createdAt"
        from agent_jobs j
        where j.id = ${input.jobId}
          and j.environment_id = ${input.environmentId}
        for update
      `;
        const row = rows[0];
        if (!row || !canLease(row, input.now)) return null;
        if (
          row.leasedByAgentId === input.agentId &&
          row.leaseExpiresAt !== null &&
          new Date(row.leaseExpiresAt).getTime() > new Date(input.now).getTime()
        ) {
          return normalizeJob(row);
        }
        if (
          row.leaseExpiresAt !== null &&
          new Date(row.leaseExpiresAt).getTime() > new Date(input.now).getTime()
        ) {
          return null;
        }

        const leaseExpiresAt = new Date(
          new Date(input.now).getTime() + JOB_LEASE_MS,
        ).toISOString();
        const leased = await transaction<AgentJobRow[]>`
        update agent_jobs
        set leased_by_agent_id = ${input.agentId},
            lease_expires_at = ${leaseExpiresAt},
            attempt = attempt + 1
        where id = ${input.jobId}
        returning id, tenant_id as "tenantId", request_id as "requestId",
                  environment_id as "environmentId", kind,
                  plan_version as "planVersion",
                  payload_ciphertext as "payloadCiphertext",
                  authorization_payload as authorization,
                  available_at as "availableAt", expires_at as "expiresAt",
                  leased_by_agent_id as "leasedByAgentId",
                  lease_expires_at as "leaseExpiresAt", attempt,
                  completed_at as "completedAt", created_at as "createdAt"
      `;
        return normalizeJob(leased[0]);
      },
    );
  }

  async heartbeat(input: AgentJobMutation): Promise<AgentJobRecord | null> {
    const leaseExpiresAt = new Date(
      new Date(input.now).getTime() + JOB_LEASE_MS,
    ).toISOString();
    return inTenantTransaction(
      this.client,
      input.tenantId,
      async (transaction) => {
        const rows = await transaction<AgentJobRow[]>`
        update agent_jobs j
        set lease_expires_at = ${leaseExpiresAt}
        where j.id = ${input.jobId}
          and j.environment_id = ${input.environmentId}
          and j.leased_by_agent_id = ${input.agentId}
          and j.lease_expires_at > ${input.now}
          and j.expires_at > ${input.now}
          and j.completed_at is null
          and exists (
            select 1 from agents a
            where a.id = ${input.agentId}
              and a.environment_id = j.environment_id
              and a.status in ('online', 'outdated')
          )
        returning j.id, j.tenant_id as "tenantId",
                  j.request_id as "requestId",
                  j.environment_id as "environmentId", j.kind,
                  j.plan_version as "planVersion",
                  j.payload_ciphertext as "payloadCiphertext",
                  j.authorization_payload as authorization,
                  j.available_at as "availableAt", j.expires_at as "expiresAt",
                  j.leased_by_agent_id as "leasedByAgentId",
                  j.lease_expires_at as "leaseExpiresAt", j.attempt,
                  j.completed_at as "completedAt", j.created_at as "createdAt"
      `;
        return rows[0] ? normalizeJob(rows[0]) : null;
      },
    );
  }

  async nextControlSequence(
    tenantId: string,
    agentId: string,
  ): Promise<string> {
    return inTenantTransaction(this.client, tenantId, async (transaction) => {
      const rows = await transaction<{ sequence: string }[]>`
        update agents
        set last_control_sequence =
          ((last_control_sequence::numeric + 1)::text)
        where id = ${agentId} and status in ('online', 'outdated')
        returning last_control_sequence as sequence
      `;
      if (!rows[0]) throw new Error("Agent is unavailable");
      return rows[0].sequence;
    });
  }
}

function canLease(row: AgentJobRow, now: string): boolean {
  const timestamp = new Date(now).getTime();
  return (
    row.completedAt === null &&
    new Date(row.availableAt).getTime() <= timestamp &&
    new Date(row.expiresAt).getTime() > timestamp
  );
}

function normalizeJob(row: AgentJobRow): AgentJobRecord {
  return {
    ...row,
    availableAt: toIso(row.availableAt),
    expiresAt: toIso(row.expiresAt),
    leaseExpiresAt:
      row.leaseExpiresAt === null ? null : toIso(row.leaseExpiresAt),
    completedAt: row.completedAt === null ? null : toIso(row.completedAt),
    createdAt: toIso(row.createdAt),
  };
}

function toIdentity(row: AgentIdentityRow): GatewayAgentIdentity {
  return {
    agentId: row.agentId,
    tenantId: row.tenantId,
    environmentId: row.environmentId,
    publicSigningKey: row.publicSigningKey,
    signingKeyId:
      row.signingKeyId ?? keyIdForPublicKey("ed25519", row.publicSigningKey),
    protocolVersion: row.protocolVersion,
    status: row.status,
  };
}

function toIso(value: DateLike): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
