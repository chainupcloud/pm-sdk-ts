/**
 * Request / response types for the relayer-service REST API (Safe meta-tx submission).
 *
 * Wire shapes mirror predict-rs `clob-client/src/relayer/types.rs` exactly (serde
 * camelCase + explicit renames), which in turn mirrors the platform repo's
 * `services/relayer-service/pkg/types/types.go` 1:1.
 *
 * Notable renames carried over verbatim:
 * - `SubmitRequest.type` (Rust `r#type`)
 * - `transactionID` (capital ID, not `transactionId`)
 * - `SafeTxParams.safeTxnGas` — the server-side Go struct's spelling; NOT the Safe v1.3
 *   standard `safeTxGas`. The relayer rejects the standard spelling.
 * - `SubmitType` values `"SAFE"` / `"SAFE-CREATE"` (dash, not underscore).
 */

import { ValidationError } from "../errors.js";

/** `SubmitRequest.type` values supported by the relayer. */
export const SubmitType = {
  /** Execute arbitrary calls through an existing Safe via `Safe.execTransaction`. */
  SAFE: "SAFE",
  /** Create a fresh user Safe via `SafeProxyFactory.createProxy`. */
  SAFE_CREATE: "SAFE-CREATE",
} as const;
export type SubmitType = (typeof SubmitType)[keyof typeof SubmitType];

/**
 * `signatureParams` for a `type = SAFE` request — the leftover SafeTx fields the relayer
 * needs to reconstruct the on-chain payload (everything other than
 * `to / value / data / operation-implied-by-params / nonce`, which are top-level).
 */
export interface SafeTxParams {
  gasPrice: string;
  /** "0" = CALL, "1" = DELEGATECALL. */
  operation: string;
  /** NOTE: `safeTxnGas` — server-side Go spelling (a typo of Safe v1.3 `safeTxGas`). */
  safeTxnGas: string;
  baseGas: string;
  gasToken: string;
  refundReceiver: string;
}

const ZERO_ADDRESS_STRING = "0x0000000000000000000000000000000000000000";

/**
 * Zero-gas defaults (relayer-pays mode). The relayer ignores these fields in practice —
 * they exist to match `Safe.execTransaction`'s signature, and the relayer's gas key pool
 * pays the actual on-chain gas. Mirrors predict-rs `SafeTxParams::relayer_pays`.
 */
export function relayerPaysParams(operationDelegateCall = false): SafeTxParams {
  return {
    gasPrice: "0",
    operation: operationDelegateCall ? "1" : "0",
    safeTxnGas: "0",
    baseGas: "0",
    gasToken: ZERO_ADDRESS_STRING,
    refundReceiver: ZERO_ADDRESS_STRING,
  };
}

/**
 * `signatureParams` for a `type = SAFE-CREATE` request. `scopeId` MUST be the full
 * 32-byte 0x-hex form — the relayer's verifier right-aligns while the submitter
 * left-aligns, so only full-width values round-trip.
 */
export interface SafeCreateParams {
  paymentToken: string;
  payment: string;
  paymentReceiver: string;
  scopeId: string;
}

/** `POST /submit` request envelope. */
export interface SubmitRequest {
  /** EOA address — must match the authenticated identity. 0x-prefixed hex. */
  from: string;
  /**
   * Target contract. For `SAFE`, must be relayer-whitelisted; for MultiSend batches, the
   * configured MultiSend contract. For `SAFE-CREATE`, the SafeProxyFactory.
   */
  to: string;
  /** Safe address (the proxy wallet) — for SAFE-CREATE, the predicted CREATE2 address. */
  proxyWallet: string;
  /** Inner calldata. `"0x"` for SAFE-CREATE (the relayer rebuilds calldata itself). */
  data: string;
  /** Safe.nonce() at sign time (decimal string). Omitted for SAFE-CREATE. */
  nonce?: string;
  /** 65-byte EIP-712 signature, 0x-prefixed hex, v ∈ {27, 28}. */
  signature: string;
  /** `SafeTxParams` for SAFE, `SafeCreateParams` for SAFE-CREATE. */
  signatureParams: SafeTxParams | SafeCreateParams;
  type: SubmitType;
  /**
   * Tenant scope id — 0x-prefixed bytes32 hex (full 32 bytes). Required for JWT-auth
   * requests (must match the JWT's scope claim). Omitted when zero.
   */
  scopeId?: string;
  /** Free-form tag carried into audit logs (`approval` / `ctf-redeem` / ...). */
  metadata?: string;
}

/**
 * Lifecycle state for a relayer-tracked transaction. Values mirror relayer-service's
 * internal `tx.State` enum (predict-rs `TransactionState`).
 */
export const TransactionState = {
  NEW: "STATE_NEW",
  QUEUED: "STATE_QUEUED",
  SENT: "STATE_SENT",
  MINED: "STATE_MINED",
  CONFIRMED: "STATE_CONFIRMED",
  FAILED: "STATE_FAILED",
  EXECUTED: "STATE_EXECUTED",
  DROPPED: "STATE_DROPPED",
} as const;
export type TransactionState = (typeof TransactionState)[keyof typeof TransactionState];

/**
 * Extra failure state emitted by the Go relayer-service (pm-sdk-go `StateInvalid`); not
 * in the predict-rs enum but treated as a failure terminal by `waitForTransaction`.
 */
export const STATE_INVALID = "STATE_INVALID";

/**
 * True for the terminal states a caller should stop polling on. Mirrors predict-rs
 * `TransactionState::is_terminal` (CONFIRMED / FAILED / DROPPED) plus the Go relayer's
 * STATE_INVALID failure terminal.
 */
export function isTerminalState(state: string): boolean {
  return state === TransactionState.CONFIRMED || isFailureState(state);
}

/** Failure terminals: FAILED / DROPPED (Rust) + INVALID (Go relayer-service). */
export function isFailureState(state: string): boolean {
  return (
    state === TransactionState.FAILED ||
    state === TransactionState.DROPPED ||
    state === STATE_INVALID
  );
}

/**
 * `POST /submit` immediate response. `transactionHash` is empty until the relayer
 * actually broadcasts (and may change on gas bumps before the terminal state); poll
 * `GET /transaction?id=<transactionID>` until a terminal state.
 */
export interface SubmitResponse {
  transactionID: string;
  transactionHash: string;
  state: TransactionState;
}

/**
 * `GET /transaction?id=<txId>` response. Lean fields default-empty for forward
 * compatibility (predict-rs uses `#[serde(default)]` throughout).
 */
export interface RelayerTransaction {
  transactionID: string;
  transactionHash: string;
  state: TransactionState;
  from: string;
  to: string;
  proxyWallet: string;
  data: string;
  nonce: string;
  type: string;
  scopeId: string;
  blockNumber?: number;
  gasUsed?: number;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /nonce` response (internal decode shape). */
export interface NonceResponse {
  nonce: string;
}

/**
 * `GET /deployed` response. When `deployed` is false, `address` is the CREATE2-predicted
 * (not yet deployed) Safe address — the next step is a SAFE-CREATE deploy.
 */
export interface DeployedResponse {
  deployed: boolean;
  address: string;
}

/**
 * `GET /relay-payload` response. `address` = the gas-paying relayer address for the next
 * transaction; `nonce` = that address's pending nonce
 * (`eth_getTransactionCount("pending")`).
 */
export interface RelayPayload {
  address: string;
  nonce: number;
}

// ─── tolerant decoders (serde-default semantics) ──────────────────────────

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`decoding ${what}: expected a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function decodeSubmitResponse(raw: unknown): SubmitResponse {
  const o = asObject(raw, "SubmitResponse");
  const transactionID = str(o.transactionID);
  const state = str(o.state);
  if (transactionID === "" || state === "") {
    throw new ValidationError("decoding SubmitResponse: missing transactionID / state");
  }
  return {
    transactionID,
    transactionHash: str(o.transactionHash),
    state: state as TransactionState,
  };
}

export function decodeRelayerTransaction(raw: unknown): RelayerTransaction {
  const o = asObject(raw, "RelayerTransaction");
  const transactionID = str(o.transactionID);
  const state = str(o.state);
  if (transactionID === "" || state === "") {
    throw new ValidationError("decoding RelayerTransaction: missing transactionID / state");
  }
  const tx: RelayerTransaction = {
    transactionID,
    transactionHash: str(o.transactionHash),
    state: state as TransactionState,
    from: str(o.from),
    to: str(o.to),
    // predict-rs reads `proxyWallet`; the live Go relayer row uses `proxyAddress`
    // (pm-sdk-go `Transaction.ProxyAddress`). Accept either.
    proxyWallet: str(o.proxyWallet, str(o.proxyAddress)),
    data: str(o.data),
    nonce: str(o.nonce),
    type: str(o.type),
    scopeId: str(o.scopeId),
  };
  if (typeof o.blockNumber === "number") tx.blockNumber = o.blockNumber;
  if (typeof o.gasUsed === "number") tx.gasUsed = o.gasUsed;
  // predict-rs reads `error`; pm-sdk-go reads `errorMessage`. Accept either.
  const error = str(o.error, str(o.errorMessage));
  if (error !== "") tx.error = error;
  if (typeof o.createdAt === "string") tx.createdAt = o.createdAt;
  if (typeof o.updatedAt === "string") tx.updatedAt = o.updatedAt;
  return tx;
}

export function decodeDeployedResponse(raw: unknown): DeployedResponse {
  const o = asObject(raw, "DeployedResponse");
  return { deployed: o.deployed === true, address: str(o.address) };
}

export function decodeRelayPayload(raw: unknown): RelayPayload {
  const o = asObject(raw, "RelayPayload");
  return {
    address: str(o.address),
    nonce: typeof o.nonce === "number" ? o.nonce : 0,
  };
}
