/**
 * L2 HMAC-SHA256 request signing.
 *
 * Mirrors the server's `computeHMAC` (and predict-rs `auth.rs::compute_l2_hmac`):
 * 1. Decode the secret with STANDARD base64 (not URL-safe); fall back to the raw bytes
 *    when decoding fails.
 * 2. Concatenate `timestamp + method + path + body` (no separators). `path` is the URL
 *    path only — no query string.
 * 3. HMAC-SHA256, output as STANDARD base64.
 */

import { createHmac } from "node:crypto";

function decodeSecret(secret: string): Buffer {
  // Node's base64 decoder is lenient; validate strictly so malformed secrets take the
  // raw-bytes fallback exactly like Go's base64.StdEncoding.DecodeString failure path.
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(secret) && secret.length % 4 === 0) {
    return Buffer.from(secret, "base64");
  }
  return Buffer.from(secret, "utf8");
}

export function computeL2Hmac(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  const mac = createHmac("sha256", decodeSecret(secret));
  mac.update(timestamp);
  mac.update(method);
  mac.update(path);
  mac.update(body);
  return mac.digest("base64");
}
