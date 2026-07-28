import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class WebhookDestinationError extends Error {
  constructor(
    readonly code:
      | "WEBHOOK_HTTPS_REQUIRED"
      | "WEBHOOK_HOST_INVALID"
      | "WEBHOOK_PRIVATE_ADDRESS"
      | "WEBHOOK_REDIRECT_REJECTED"
      | "WEBHOOK_RESPONSE_TOO_LARGE",
  ) {
    super(code);
    this.name = "WebhookDestinationError";
  }
}

export async function assertSafeWebhookUrl(
  value: string,
  options: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDestinationError("WEBHOOK_HOST_INVALID");
  }
  if (url.protocol !== "https:") {
    throw new WebhookDestinationError("WEBHOOK_HTTPS_REQUIRED");
  }
  if (!url.hostname || url.username || url.password) {
    throw new WebhookDestinationError("WEBHOOK_HOST_INVALID");
  }
  if (!options.allowPrivate && isPrivateHost(url.hostname)) {
    throw new WebhookDestinationError("WEBHOOK_PRIVATE_ADDRESS");
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !options.allowPrivate &&
    records.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new WebhookDestinationError("WEBHOOK_PRIVATE_ADDRESS");
  }
  return url;
}

export async function postWebhook(
  destination: string,
  body: Uint8Array,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxResponseBytes?: number;
    allowPrivate?: boolean;
  } = {},
): Promise<Response> {
  let url = await assertSafeWebhookUrl(destination, options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const bytes = await response.clone().arrayBuffer();
      if (bytes.byteLength > maxResponseBytes) {
        throw new WebhookDestinationError("WEBHOOK_RESPONSE_TOO_LARGE");
      }
      return response;
    }
    const location = response.headers.get("location");
    if (!location || redirect === 3) {
      throw new WebhookDestinationError("WEBHOOK_REDIRECT_REJECTED");
    }
    url = await assertSafeWebhookUrl(
      new URL(location, url).toString(),
      options,
    );
  }
  throw new WebhookDestinationError("WEBHOOK_REDIRECT_REJECTED");
}

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" ||
    hostname === "host.docker.internal"
  );
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }
  return true;
}
