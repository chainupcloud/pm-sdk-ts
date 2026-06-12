/**
 * HTTP client for relayer-service (Safe meta-tx submission).
 *
 * Paths, query params, and auth headers mirror predict-rs
 * `clob-client/src/relayer/client.rs` and pm-sdk-go `pkg/relayer/client.go`:
 *
 * - `POST /submit`, `GET /transaction?id=`, `GET /transactions?limit=&offset=`,
 *   `GET /nonce` / `GET /deployed` (`address` OR `signer`+`scopeId`),
 *   `GET /relay-payload?scopeId=`.
 * - Auth is either `Authorization: Bearer <jwt>` (gamma-service `/auth/login` token) or
 *   the API-key header pair `RELAYER_API_KEY` (+ optional `RELAYER_API_KEY_ADDRESS`).
 *   No L2 HMAC is involved on the relayer.
 */

import { RelayerTxError, ValidationError } from "../errors.js";
import { HttpClient } from "../http.js";
import type { Address, ScopeId } from "../types.js";
import {
  type DeployedResponse,
  decodeDeployedResponse,
  decodeRelayerTransaction,
  decodeRelayPayload,
  decodeSubmitResponse,
  isFailureState,
  type RelayerTransaction,
  type RelayPayload,
  type SubmitRequest,
  type SubmitResponse,
  TransactionState,
} from "./types.js";

/** Relayer auth credential — JWT bearer (user flow) or long-lived API key (server ops). */
export type RelayerAuth =
  | {
      /** Sent as the `RELAYER_API_KEY` header. */
      apiKey: string;
      /** Sent as `RELAYER_API_KEY_ADDRESS` when provided (predict-rs `with_api_key`). */
      apiKeyAddress?: string;
    }
  | {
      /** Sent as `Authorization: Bearer <jwt>`. */
      bearerJwt: string;
    };

function buildAuthHeaders(auth: RelayerAuth | undefined): Record<string, string> {
  if (auth === undefined) return {};
  if ("apiKey" in auth) {
    const headers: Record<string, string> = { RELAYER_API_KEY: auth.apiKey };
    if (auth.apiKeyAddress !== undefined) {
      headers.RELAYER_API_KEY_ADDRESS = auth.apiKeyAddress;
    }
    return headers;
  }
  return { Authorization: `Bearer ${auth.bearerJwt}` };
}

export interface RelayerClientOptions {
  /** Pre-configured HTTP client (takes precedence over `baseUrl`). */
  http?: HttpClient;
  /**
   * Relayer base URL. NOTE: production tenants may not follow the canonical
   * `relayer-api.<host>` subdomain (Monad uses `relayer.hermestrade.xyz`); prefer the
   * network registry's `endpoints.relayer`.
   */
  baseUrl?: string;
  /** Auth credential; the relayer rejects unauthenticated `/submit` requests. */
  auth?: RelayerAuth;
}

/**
 * Safe lookup selector for `GET /nonce` / `GET /deployed`. Either pass the Safe address
 * directly, or `signer` (owner EOA) + `scopeId` and let the server CREATE2-derive it.
 */
export interface SafeLookup {
  safe?: Address;
  signer?: Address;
  scopeId?: ScopeId;
}

export interface WaitForTransactionOptions {
  /** Poll interval in milliseconds. Default 2000 (Go/Rust default 2 s). */
  intervalMs?: number;
  /** Maximum polls before giving up. Default 120 (~4 min, pm-sdk-go default). */
  maxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayerClient {
  readonly http: HttpClient;
  private authHeaders: Record<string, string>;

  constructor(options: RelayerClientOptions) {
    if (options.http) {
      this.http = options.http;
    } else if (options.baseUrl) {
      this.http = new HttpClient(options.baseUrl);
    } else {
      throw new ValidationError("RelayerClient requires `http` or `baseUrl`");
    }
    this.authHeaders = buildAuthHeaders(options.auth);
  }

  /** Attach / replace the auth credential (e.g. a freshly fetched JWT). */
  setAuth(auth: RelayerAuth): void {
    this.authHeaders = buildAuthHeaders(auth);
  }

  /**
   * `POST /submit` — submit a Safe meta-tx (single op, MultiSend batch, or SAFE-CREATE).
   * Returns the `transactionID` for polling immediately; the relayer broadcasts
   * asynchronously.
   */
  async submit(request: SubmitRequest): Promise<SubmitResponse> {
    const res = await this.http.post<unknown>("/submit", {
      body: request,
      headers: this.authHeaders,
    });
    return decodeSubmitResponse(res.data);
  }

  /**
   * `GET /nonce` — the Safe's current `nonce()` as seen by the relayer. Returns 0 when
   * the Safe is not yet deployed (or the field is missing — pm-sdk-go parity).
   */
  async getNonce(lookup: SafeLookup): Promise<bigint> {
    const res = await this.http.get<unknown>("/nonce", {
      query: this.lookupQuery(lookup, "getNonce"),
      headers: this.authHeaders,
    });
    const raw = (res.data as { nonce?: unknown } | null)?.nonce;
    if (raw === undefined || raw === null || raw === "") return 0n;
    try {
      return BigInt(String(raw));
    } catch {
      throw new ValidationError(`decoding NonceResponse: invalid nonce "${String(raw)}"`);
    }
  }

  /**
   * `GET /deployed` — whether the Safe exists; `address` is the deployed Safe or the
   * CREATE2-predicted address when `deployed` is false.
   */
  async getDeployed(lookup: SafeLookup): Promise<DeployedResponse> {
    const res = await this.http.get<unknown>("/deployed", {
      query: this.lookupQuery(lookup, "getDeployed"),
      headers: this.authHeaders,
    });
    return decodeDeployedResponse(res.data);
  }

  /** `GET /transaction?id=<txId>` — current lifecycle state of a submitted meta-tx. */
  async getTransaction(txId: string): Promise<RelayerTransaction> {
    if (txId === "") {
      throw new ValidationError("getTransaction: txId required");
    }
    const res = await this.http.get<unknown>("/transaction", {
      query: { id: txId },
      headers: this.authHeaders,
    });
    return decodeRelayerTransaction(res.data);
  }

  /**
   * `GET /transactions?limit=&offset=` — the authenticated address's own transactions
   * (the server filters by the auth identity; no cross-address queries).
   */
  async getTransactions(
    options: { limit?: number; offset?: number } = {},
  ): Promise<RelayerTransaction[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.limit !== undefined && options.limit > 0) query.limit = options.limit;
    if (options.offset !== undefined && options.offset > 0) query.offset = options.offset;
    const res = await this.http.get<unknown>("/transactions", {
      query,
      headers: this.authHeaders,
    });
    if (!Array.isArray(res.data)) {
      throw new ValidationError("decoding /transactions: expected a JSON array");
    }
    return res.data.map(decodeRelayerTransaction);
  }

  /**
   * `GET /relay-payload?scopeId=` — the relayer's next gas-paying address + its pending
   * nonce (for offline tx-hash precomputation). `scopeId` may be omitted under JWT auth
   * (the server takes it from the JWT claims).
   */
  async getRelayPayload(scopeId?: string): Promise<RelayPayload> {
    const query: Record<string, string | undefined> = {};
    if (scopeId !== undefined && scopeId !== "") query.scopeId = scopeId;
    const res = await this.http.get<unknown>("/relay-payload", {
      query,
      headers: this.authHeaders,
    });
    return decodeRelayPayload(res.data);
  }

  /**
   * Poll `GET /transaction` until a terminal state.
   *
   * - `STATE_CONFIRMED` → resolves with the transaction.
   * - `STATE_FAILED` / `STATE_DROPPED` (and the Go relayer's `STATE_INVALID`) → throws
   *   {@link RelayerTxError}.
   * - Not terminal after `maxAttempts` polls → throws {@link RelayerTxError} with the
   *   last observed state.
   *
   * Monad settles STATE_NEW → STATE_CONFIRMED in ~10–30 s; the 2 s / 120-attempt
   * defaults match pm-sdk-go.
   */
  async waitForTransaction(
    txId: string,
    options: WaitForTransactionOptions = {},
  ): Promise<RelayerTransaction> {
    const intervalMs = options.intervalMs ?? 2_000;
    const maxAttempts = options.maxAttempts ?? 120;
    if (maxAttempts <= 0) {
      throw new ValidationError("waitForTransaction: maxAttempts must be positive");
    }
    let last: RelayerTransaction | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(intervalMs);
      last = await this.getTransaction(txId);
      if (last.state === TransactionState.CONFIRMED) return last;
      if (isFailureState(last.state)) {
        throw new RelayerTxError(txId, last.state, last.error);
      }
    }
    throw new RelayerTxError(
      txId,
      last?.state ?? "UNKNOWN",
      `not terminal after ${maxAttempts} polls`,
    );
  }

  private lookupQuery(lookup: SafeLookup, method: string): Record<string, string | undefined> {
    const query: Record<string, string | undefined> = {};
    if (lookup.safe !== undefined) query.address = lookup.safe;
    if (lookup.signer !== undefined) query.signer = lookup.signer;
    if (lookup.scopeId !== undefined) query.scopeId = lookup.scopeId;
    if (Object.keys(query).length === 0) {
      throw new ValidationError(`${method}: requires \`safe\`, or \`signer\` + \`scopeId\``);
    }
    return query;
  }
}
