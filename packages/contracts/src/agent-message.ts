import { z } from "zod";
import { AgentIdSchema, EnvironmentIdSchema, MessageIdSchema } from "./ids.js";

export const AgentMessageSchema = z.object({
  protocolVersion: z.literal("1.0"),
  messageType: z.string().min(1),
  messageId: MessageIdSchema,
  environmentId: EnvironmentIdSchema,
  agentId: AgentIdSchema,
  sequence: z.string().regex(/^\d+$/),
  sentAt: z.string().datetime(),
  payload: z.unknown(),
  signature: z.string().min(32),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
