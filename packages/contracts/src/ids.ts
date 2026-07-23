import { z } from "zod";

const OpaqueIdSchema = z.string().min(1);

export const EnvironmentIdSchema = OpaqueIdSchema;
export type EnvironmentId = z.infer<typeof EnvironmentIdSchema>;

export const AgentIdSchema = OpaqueIdSchema;
export type AgentId = z.infer<typeof AgentIdSchema>;

export const RequestIdSchema = OpaqueIdSchema;
export type RequestId = z.infer<typeof RequestIdSchema>;

export const PlanIdSchema = OpaqueIdSchema;
export type PlanId = z.infer<typeof PlanIdSchema>;

export const MessageIdSchema = OpaqueIdSchema;
export type MessageId = z.infer<typeof MessageIdSchema>;
