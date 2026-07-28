import canonicalize from "canonicalize";
import { z } from "zod";
import { AgentIdSchema, EnvironmentIdSchema, MessageIdSchema } from "./ids.js";

const MAX_U64 = 18_446_744_073_709_551_615n;
const signingContext = new TextEncoder().encode("forgetops.agent-message.v1");
export const AgentSequenceSchema = z.string().refine((value) => {
  if (!/^[1-9]\d{0,19}$/.test(value)) return false;
  return BigInt(value) <= MAX_U64;
}, "Agent sequence must be an unsigned 64-bit integer greater than zero");

export const UnsignedAgentMessageSchema = z
  .object({
    type: z.literal("forgetops.agent-message"),
    protocolVersion: z.literal("1.0"),
    messageType: z.string().min(1),
    messageId: MessageIdSchema,
    keyId: z.string().min(1),
    environmentId: EnvironmentIdSchema,
    agentId: AgentIdSchema,
    direction: z.enum(["control_to_agent", "agent_to_control"]),
    sequence: AgentSequenceSchema,
    sentAt: z.string().datetime(),
    payload: z.unknown(),
  })
  .strict();

export const AgentMessageSchema = UnsignedAgentMessageSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

export type UnsignedAgentMessage = z.infer<typeof UnsignedAgentMessageSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export function canonicalUnsignedBytes(
  message: UnsignedAgentMessage | AgentMessage,
): Uint8Array {
  const { signature: _signature, ...unsigned } = message as AgentMessage;
  const parsed = UnsignedAgentMessageSchema.parse(unsigned);
  const serialized = canonicalize(parsed);
  if (serialized === undefined) {
    throw new TypeError("Agent message payload must be a JSON value");
  }
  return new TextEncoder().encode(serialized);
}

export function agentMessageSigningBytes(
  message: UnsignedAgentMessage | AgentMessage,
): Uint8Array {
  const canonical = canonicalUnsignedBytes(message);
  const bytes = new Uint8Array(signingContext.length + 1 + canonical.length);
  bytes.set(signingContext);
  bytes.set(canonical, signingContext.length + 1);
  return bytes;
}
