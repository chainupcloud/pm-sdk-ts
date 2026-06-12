/**
 * L1 / L2 auth header builders. Parity with predict-rs `auth.rs`.
 */

import { computeL2Hmac } from "./crypto/hmac.js";
import type { PredictSigner } from "./crypto/signer.js";
import type { Address, ApiCredentials } from "./types.js";
import { isZeroScopeId } from "./types.js";

export const HEADER = {
  PRED_ADDRESS: "PRED_ADDRESS",
  PRED_NONCE: "PRED_NONCE",
  PRED_SIGNATURE: "PRED_SIGNATURE",
  PRED_TIMESTAMP: "PRED_TIMESTAMP",
  PRED_SCOPE_ID: "PRED_SCOPE_ID",
  PRED_API_KEY: "PRED_API_KEY",
  PRED_PASSPHRASE: "PRED_PASSPHRASE",
} as const;

/** Current Unix timestamp (seconds) as a string. */
export function currentTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Build the L1 (EIP-712 ClobAuth) auth headers. `PRED_SCOPE_ID` is emitted only when the
 * signer's scope id is non-zero. The signature keeps v ∈ {0, 1} (server convention for L1).
 */
export async function buildL1Headers(
  signer: PredictSigner,
  options: { timestamp?: string; nonce?: bigint | number } = {},
): Promise<Record<string, string>> {
  const timestamp = options.timestamp ?? currentTimestamp();
  const nonce = options.nonce ?? 0;
  const signature = await signer.signClobAuth(timestamp, nonce);
  const headers: Record<string, string> = {
    [HEADER.PRED_ADDRESS]: signer.address,
    [HEADER.PRED_NONCE]: nonce.toString(),
    [HEADER.PRED_SIGNATURE]: signature,
    [HEADER.PRED_TIMESTAMP]: timestamp,
  };
  if (!isZeroScopeId(signer.scopeId)) {
    headers[HEADER.PRED_SCOPE_ID] = signer.scopeId;
  }
  return headers;
}

/**
 * Build the L2 (HMAC) auth headers for one request.
 *
 * `path` must be the URL path only (no query string) — the server signs
 * `c.Request.URL.Path`. `body` must be the exact wire bytes (empty string for GET/DELETE
 * without a body).
 */
export function buildL2Headers(
  creds: ApiCredentials,
  address: Address,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  return {
    [HEADER.PRED_API_KEY]: creds.key,
    [HEADER.PRED_PASSPHRASE]: creds.passphrase,
    [HEADER.PRED_SIGNATURE]: computeL2Hmac(creds.secret, timestamp, method, path, body),
    [HEADER.PRED_TIMESTAMP]: timestamp,
    [HEADER.PRED_ADDRESS]: address,
  };
}
