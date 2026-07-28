import { createHmac } from "node:crypto";
import canonicalize from "canonicalize";
import { postWebhook } from "../security/webhook-destination.js";
import type { OutboxEvent } from "./outbox.js";

export interface WebhookDelivery {
  deliveryId: string;
  destination: string;
  secret: Uint8Array;
  event: OutboxEvent;
}

export async function deliverWebhook(
  delivery: WebhookDelivery,
  options: { timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const payload = {
    type: "forgetops.webhook-event",
    version: 1,
    deliveryId: delivery.deliveryId,
    event: {
      id: delivery.event.id,
      type: delivery.event.type,
      occurredAt: delivery.event.occurredAt,
      payload: delivery.event.payload,
    },
  };
  const serialized = canonicalize({
    timestamp,
    deliveryId: delivery.deliveryId,
    payload,
  });
  if (serialized === undefined)
    throw new TypeError("WEBHOOK_PAYLOAD_NOT_CANONICAL");
  const signature = createHmac("sha256", delivery.secret)
    .update("forgetops.webhook.v1")
    .update(Buffer.from([0]))
    .update(serialized)
    .digest("base64url");
  return postWebhook(
    delivery.destination,
    Buffer.from(JSON.stringify(payload)),
    {
      timeoutMs: options.timeoutMs,
      allowPrivate: options.allowPrivate,
      headers: {
        "x-forgetops-timestamp": timestamp,
        "x-forgetops-delivery-id": delivery.deliveryId,
        "x-forgetops-signature": `hmac-sha256:${signature}`,
      },
    },
  );
}
