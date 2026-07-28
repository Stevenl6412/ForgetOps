import { randomBytes } from "node:crypto";
import type { ZodType } from "zod";
import {
  DiscoverRequestSchema,
  EraseRequestSchema,
  ExportRequestSchema,
  HealthRequestSchema,
  VerifyRequestSchema,
  type ExportWriter,
  type ResourceDefinition,
} from "./contracts.js";
import {
  createRedactingLogger,
  type AdapterLogger,
} from "./redacting-logger.js";
import {
  ADAPTER_ACCEPTANCE_WINDOW_MS,
  FileNonceStore,
  type NonceStore,
  verifyAdapterSignature,
} from "./signature.js";

const CONTENT_TYPE = "application/json";
const ROUTES = new Set([
  "/forgetops/v1/health",
  "/forgetops/v1/discover",
  "/forgetops/v1/export",
  "/forgetops/v1/erase",
  "/forgetops/v1/verify",
]);
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_MAX_EXPORT_BYTES = 100 * 1024 * 1024;

export interface AdapterOptions<Db> {
  resources: readonly ResourceDefinition<Db>[];
  db?: Db;
  secret?: Uint8Array | string;
  nonceStore?: NonceStore;
  logger?: AdapterLogger;
  now?: () => Date;
  maxPayloadBytes?: number;
  maxFrameBytes?: number;
  maxExportBytes?: number;
}

export interface AdapterInjectInput {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

export interface AdapterInjectResponse {
  statusCode: number;
  body: string;
  json<T = unknown>(): T;
}

export interface ForgetOpsAdapter {
  fetch(request: Request): Promise<Response>;
  inject(input: AdapterInjectInput): Promise<AdapterInjectResponse>;
}

export function createForgetOpsAdapter<Db = unknown>(
  options: AdapterOptions<Db>,
): ForgetOpsAdapter {
  const resources = validateResources(options.resources);
  const secret = resolveSecret(options.secret);
  const nonceStore =
    options.nonceStore ??
    new FileNonceStore(
      process.env.FORGETOPS_ADAPTER_NONCE_FILE ??
        ".forgetops/adapter-nonces.jsonl",
    );
  const logger = options.logger ?? createRedactingLogger();
  const now = options.now ?? (() => new Date());
  const maxPayloadBytes = positiveLimit(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_BYTES,
  );
  const maxFrameBytes = positiveLimit(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
  );
  const maxExportBytes = positiveLimit(
    options.maxExportBytes,
    DEFAULT_MAX_EXPORT_BYTES,
  );

  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (!ROUTES.has(path)) return jsonResponse(404, "ADAPTER_ROUTE_NOT_FOUND");
    if (request.method !== "POST") {
      return jsonResponse(405, "ADAPTER_METHOD_NOT_ALLOWED");
    }

    const contentType = request.headers.get("content-type") ?? "";
    const contentLength = Number(request.headers.get("content-length"));
    if (
      contentType !== CONTENT_TYPE ||
      (Number.isFinite(contentLength) && contentLength > maxPayloadBytes)
    ) {
      return jsonResponse(413, "ADAPTER_PAYLOAD_INVALID");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > maxPayloadBytes) {
      return jsonResponse(413, "ADAPTER_PAYLOAD_TOO_LARGE");
    }

    const timestamp = request.headers.get("x-forgetops-timestamp") ?? "";
    const nonce = request.headers.get("x-forgetops-nonce") ?? "";
    const signature = request.headers.get("x-forgetops-signature") ?? "";
    const nowMs = now().getTime();
    if (
      !verifyAdapterSignature({
        secret,
        method: request.method,
        normalizedPath: path,
        timestamp,
        nonce,
        contentType,
        body,
        signature,
        nowMs,
      })
    ) {
      return jsonResponse(401, "ADAPTER_SIGNATURE_INVALID");
    }
    try {
      const consumed = await nonceStore.consume(
        nonce,
        nowMs + ADAPTER_ACCEPTANCE_WINDOW_MS,
        nowMs,
      );
      if (!consumed) return jsonResponse(401, "ADAPTER_NONCE_REPLAYED");
    } catch {
      logger.error("adapter_nonce_store_failed", { route: path });
      return jsonResponse(503, "ADAPTER_NONCE_STORE_UNAVAILABLE");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      return jsonResponse(400, "ADAPTER_JSON_INVALID");
    }

    try {
      switch (path) {
        case "/forgetops/v1/health":
          return await health(payload);
        case "/forgetops/v1/discover":
          return await discover(payload);
        case "/forgetops/v1/export":
          return exportData(payload);
        case "/forgetops/v1/erase":
          return await erase(payload);
        case "/forgetops/v1/verify":
          return await verify(payload);
        default:
          return jsonResponse(404, "ADAPTER_ROUTE_NOT_FOUND");
      }
    } catch {
      logger.error("adapter_request_failed", { route: path });
      return jsonResponse(500, "ADAPTER_HANDLER_FAILED");
    }
  };

  const health = async (payload: unknown): Promise<Response> => {
    parse(HealthRequestSchema, payload);
    const checks = await Promise.all(
      [...resources.values()].map(async (resource) => ({
        name: resource.name,
        ...((await resource.healthCheck?.({ db: options.db as Db })) ?? {
          healthy: true,
        }),
      })),
    );
    return Response.json({
      healthy: checks.every((check) => check.healthy),
      checks,
    });
  };

  const discover = async (payload: unknown): Promise<Response> => {
    const input = parse(DiscoverRequestSchema, payload);
    const items = await Promise.all(
      [...resources.values()].map(async (resource) => {
        const discovered = await resource.discover({
          subject: input.subject,
          request: input.request,
          db: options.db as Db,
        });
        return {
          resourceType: resource.name,
          ...discovered,
          localReference: discovered.localReference ?? resource.name,
        };
      }),
    );
    return Response.json({ items });
  };

  const exportData = (payload: unknown): Response => {
    const input = parse(ExportRequestSchema, payload);
    const selected = [...new Set(input.selection.resources)].map((name) => {
      const resource = resources.get(name);
      if (!resource?.export || !resource.capabilities.includes("export")) {
        throw new Error("ADAPTER_RESOURCE_EXPORT_UNAVAILABLE");
      }
      return resource;
    });
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const streamWriter = stream.writable.getWriter();
    void (async () => {
      let totalBytes = 0;
      let exportedCount = 0;
      const writeFrame = async (frame: unknown, rawBytes = 0) => {
        totalBytes += rawBytes;
        if (totalBytes > maxExportBytes) {
          throw new Error("ADAPTER_EXPORT_TOO_LARGE");
        }
        const encoded = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
        if (encoded.byteLength > Math.ceil(maxFrameBytes * 1.4) + 1024) {
          throw new Error("ADAPTER_EXPORT_FRAME_TOO_LARGE");
        }
        await streamWriter.ready;
        await streamWriter.write(encoded);
      };
      const writer: ExportWriter = {
        bytes: async (path, frameContentType, bytes) => {
          validateExportPath(path);
          if (
            !frameContentType ||
            frameContentType.length > 128 ||
            bytes.byteLength > maxFrameBytes
          ) {
            throw new Error("ADAPTER_EXPORT_FRAME_INVALID");
          }
          await writeFrame(
            {
              type: "data",
              path,
              contentType: frameContentType,
              data: Buffer.from(bytes).toString("base64url"),
            },
            bytes.byteLength,
          );
        },
        json: async (path, value) => {
          const bytes = new TextEncoder().encode(JSON.stringify(value));
          await writer.bytes(path, CONTENT_TYPE, bytes);
        },
      };
      try {
        for (const resource of selected) {
          const result = await resource.export!({
            subject: input.subject,
            db: options.db as Db,
            writer,
          });
          exportedCount += nonNegativeInteger(
            result.exportedCount,
            "ADAPTER_EXPORT_COUNT_INVALID",
          );
        }
        await writeFrame({ type: "complete", exportedCount });
        await streamWriter.close();
      } catch {
        logger.error("adapter_export_failed", {
          route: "/forgetops/v1/export",
        });
        await writeFrame({
          type: "error",
          code: "ADAPTER_EXPORT_FAILED",
        }).catch(() => undefined);
        await streamWriter.close().catch(() => undefined);
      }
    })();
    return new Response(stream.readable, {
      headers: { "content-type": "application/x-ndjson" },
    });
  };

  const erase = async (payload: unknown): Promise<Response> => {
    const input = parse(EraseRequestSchema, payload);
    if (input.context.dryRun) {
      return jsonResponse(400, "ADAPTER_ERASE_DRY_RUN_FORBIDDEN");
    }
    const resource = resources.get(input.resource);
    const requiredCapability =
      input.plan.action === "retain_by_policy"
        ? "retain"
        : input.plan.action === "delete" || input.plan.action === "anonymize"
          ? input.plan.action
          : null;
    if (
      !resource?.erase ||
      !requiredCapability ||
      !resource.capabilities.includes(requiredCapability) ||
      !resource.capabilities.includes("verify")
    ) {
      return jsonResponse(400, "ADAPTER_RESOURCE_ERASE_UNAVAILABLE");
    }
    const result = await resource.erase({
      subject: input.subject,
      db: options.db as Db,
      operationKey: input.plan.operationKey,
      action: input.plan.action,
      execution: input.context,
    });
    if (result.operationKey !== input.plan.operationKey) {
      throw new Error("ADAPTER_OPERATION_KEY_MISMATCH");
    }
    nonNegativeInteger(result.affectedCount, "ADAPTER_ERASE_COUNT_INVALID");
    return Response.json(result);
  };

  const verify = async (payload: unknown): Promise<Response> => {
    const input = parse(VerifyRequestSchema, payload);
    const resource = resources.get(input.resource);
    if (!resource?.verify || !resource.capabilities.includes("verify")) {
      return jsonResponse(400, "ADAPTER_RESOURCE_VERIFY_UNAVAILABLE");
    }
    const result = await resource.verify({
      subject: input.subject,
      db: options.db as Db,
      expectedState: input.expectation.state,
    });
    nonNegativeInteger(result.remainingCount, "ADAPTER_VERIFY_COUNT_INVALID");
    return Response.json(result);
  };

  return {
    fetch,
    async inject(input) {
      const body = JSON.stringify(input.payload ?? {});
      const response = await fetch(
        new Request(new URL(input.url, "http://adapter.local"), {
          method: input.method,
          headers: { "content-type": CONTENT_TYPE, ...input.headers },
          body,
        }),
      );
      const responseBody = await response.text();
      return {
        statusCode: response.status,
        body: responseBody,
        json: <T>() => JSON.parse(responseBody) as T,
      };
    },
  };
}

function validateResources<Db>(
  definitions: readonly ResourceDefinition<Db>[],
): Map<string, ResourceDefinition<Db>> {
  if (!definitions.length) throw new Error("ADAPTER_RESOURCES_REQUIRED");
  const resources = new Map<string, ResourceDefinition<Db>>();
  for (const resource of definitions) {
    const capabilities = new Set(resource.capabilities);
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(resource.name) ||
      resources.has(resource.name) ||
      !capabilities.has("discover") ||
      ((capabilities.has("delete") || capabilities.has("anonymize")) &&
        (!capabilities.has("verify") || !resource.erase || !resource.verify)) ||
      (capabilities.has("export") && !resource.export)
    ) {
      throw new Error("ADAPTER_RESOURCE_INVALID");
    }
    resources.set(resource.name, resource);
  }
  return resources;
}

function resolveSecret(value: Uint8Array | string | undefined): Uint8Array {
  const configured = value ?? process.env.FORGETOPS_ADAPTER_SECRET ?? "";
  const secret =
    typeof configured === "string"
      ? Buffer.from(configured, "utf8")
      : Buffer.from(configured);
  if (secret.byteLength < 32) throw new Error("ADAPTER_SECRET_INVALID");
  return secret;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("ADAPTER_PAYLOAD_INVALID");
  return parsed.data;
}

function jsonResponse(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status });
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ADAPTER_LIMIT_INVALID");
  }
  return value;
}

function nonNegativeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function validateExportPath(path: string): void {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("ADAPTER_EXPORT_PATH_INVALID");
  }
}

export function randomAdapterNonce(): string {
  return randomBytes(24).toString("base64url");
}
