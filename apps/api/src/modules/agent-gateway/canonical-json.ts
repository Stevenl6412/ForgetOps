import canonicalize from "canonicalize";

/** Serialize a JSON value with RFC 8785 JSON Canonicalization Scheme rules. */
export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new TypeError("Agent message payload must be a JSON value");
  }
  return serialized;
}
