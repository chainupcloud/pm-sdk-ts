/**
 * Common domain types: scope id, side, signature type, order type.
 *
 * Wire-format notes (parity with predict-rs `clob-client/src/types.rs`):
 * - `Side` serializes as `"BUY"` / `"SELL"`.
 * - `SignatureType` serializes as `"EOA"` / `"POLY_PROXY"` / `"POLY_GNOSIS_SAFE"`.
 * - `scopeId` serializes as a 0x-prefixed 64-hex-char string, or the empty string when zero.
 */

export type Hex = `0x${string}`;
export type Address = Hex;

/** bytes32 multi-tenant scope identifier, always normalized to 0x + 64 hex chars. */
export type ScopeId = Hex;

export const ZERO_SCOPE_ID: ScopeId = `0x${"00".repeat(32)}`;
export const ZERO_ADDRESS: Address = `0x${"00".repeat(20)}`;

/**
 * Parse a scope id from hex ("0x..." or bare hex or ""). Empty string -> zero.
 * Short input is left-padded with zeros (mirrors pm-sdk-go `ScopeIDFromHex` /
 * predict-rs `ScopeId::from_hex`).
 */
export function scopeIdFromHex(s: string): ScopeId {
  if (s === "") return ZERO_SCOPE_ID;
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length === 0) return ZERO_SCOPE_ID;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new Error(`invalid scope id hex: ${s}`);
  }
  if (stripped.length > 64) {
    throw new Error(`scope id exceeds 32 bytes: ${s}`);
  }
  // Pad to an even number of chars first (a nibble like "0x4" means 0x04), then left-pad.
  const evened = stripped.length % 2 === 1 ? `0${stripped}` : stripped;
  return `0x${evened.padStart(64, "0").toLowerCase()}` as ScopeId;
}

export function isZeroScopeId(id: ScopeId): boolean {
  return id === ZERO_SCOPE_ID;
}

/**
 * Wire form: "0x..." hex, or the empty string for zero (matches pm-sdk-go `ScopeIDToHex`).
 */
export function scopeIdToWire(id: ScopeId): string {
  return isZeroScopeId(id) ? "" : id;
}

/** Order side. Numeric value is the EIP-712 `uint8 side` field. */
export const Side = {
  BUY: "BUY",
  SELL: "SELL",
} as const;
export type Side = (typeof Side)[keyof typeof Side];

export function sideToUint8(side: Side): number {
  return side === Side.BUY ? 0 : 1;
}

/**
 * Signature type — same numeric values as the platform contracts.
 * - EOA (0): direct EOA signature; maker must equal signer.
 * - POLY_PROXY (1): upstream V1 proxy wallet.
 * - POLY_GNOSIS_SAFE (2): Gnosis Safe (1-of-1) — the platform default; maker is the
 *   Safe address, signer is the owning EOA.
 */
export const SignatureType = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2,
} as const;
export type SignatureType = (typeof SignatureType)[keyof typeof SignatureType];

const SIGNATURE_TYPE_WIRE: Record<SignatureType, string> = {
  [SignatureType.EOA]: "EOA",
  [SignatureType.POLY_PROXY]: "POLY_PROXY",
  [SignatureType.POLY_GNOSIS_SAFE]: "POLY_GNOSIS_SAFE",
};

export function signatureTypeToWire(t: SignatureType): string {
  return SIGNATURE_TYPE_WIRE[t];
}

/** Time-in-force. GTC default for limit orders, FAK default for market orders. */
export const OrderType = {
  GTC: "GTC",
  GTD: "GTD",
  FOK: "FOK",
  FAK: "FAK",
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export function isMarketOrderType(t: OrderType): boolean {
  return t === OrderType.FOK || t === OrderType.FAK;
}

/** L2 API credentials returned by `POST /auth/api-key` / `GET /auth/derive-api-key`. */
export interface ApiCredentials {
  /** UUID API key identifier. */
  key: string;
  /** Standard-base64-encoded HMAC secret. */
  secret: string;
  passphrase: string;
}

/** Normalize an address to lowercase 0x form (server compares case-insensitively). */
export function normalizeAddress(addr: string): Address {
  const a = addr.startsWith("0x") || addr.startsWith("0X") ? addr.slice(2) : addr;
  if (!/^[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error(`invalid address: ${addr}`);
  }
  return `0x${a.toLowerCase()}` as Address;
}
