import { createPublicKey, verify } from "node:crypto";

/**
 * Signed payloads carry an explicit purpose domain.
 *
 * Without it, a signature produced for one document type could be replayed as
 * another (for example an update manifest signature presented as a runtime
 * asset manifest). The domain is part of the signed bytes, so a key that signs
 * both kinds of documents still cannot be confused across purposes.
 */
export type SignaturePurpose = "desktop-update" | "runtime-assets";

export const SIGNATURE_DOMAINS: Record<SignaturePurpose, string> = {
  "desktop-update": "agent-in-box/desktop-update/v1",
  "runtime-assets": "agent-in-box/runtime-assets/v1",
};

/** Deterministic JSON used as the signed payload. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, normalize(record[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function signedPayload(purpose: SignaturePurpose, value: unknown): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAINS[purpose]}\n${canonicalJson(value)}`, "utf8");
}

export function publicKeyObject(value: string): ReturnType<typeof createPublicKey> {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(trimmed);
  }
  return createPublicKey({
    key: Buffer.from(trimmed, "base64"),
    format: "der",
    type: "spki",
  });
}

/** Verifies a base64 Ed25519 signature over a purpose-scoped payload. */
export function verifySignature(
  purpose: SignaturePurpose,
  value: unknown,
  publicKey: string,
  signature: string,
): boolean {
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length === 0) return false;
  return verify(null, signedPayload(purpose, value), publicKeyObject(publicKey), bytes);
}
