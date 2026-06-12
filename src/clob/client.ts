/**
 * CLOB REST client. Port of predict-rs `clob-client/src/client.rs` — same paths,
 * query params, auth levels, and client-side limits.
 *
 * Auth levels:
 * - public — market data (GET + batch POST reads), `/ok`, `/time`.
 * - L1 (EIP-712 ClobAuth headers) — `/auth/api-key` create / derive / revoke.
 * - L2 (HMAC over `timestamp + method + path + body`, path WITHOUT query string) —
 *   trading endpoints. The HMAC is computed over the exact serialized body
 *   (`HttpClient.serializeBody`), which is also the body sent on the wire.
 */

import { buildL1Headers, buildL2Headers, currentTimestamp } from "../auth.js";
import type { PredictSigner } from "../crypto/signer.js";
import { ApiError, ValidationError } from "../errors.js";
import { HttpClient, type HttpRequestOptions } from "../http.js";
import {
  type BuiltOrder,
  buildLimitOrder,
  buildMarketOrder,
  type LimitOrderArgs,
  type MarketOrderArgs,
  type SignedOrderWire,
  signBuiltOrder,
} from "../order-builder.js";
import {
  type Address,
  type ApiCredentials,
  normalizeAddress,
  type OrderType,
  type Side,
} from "../types.js";
import {
  type ApiKeyInfo,
  type AssetType,
  type BalanceAllowanceResponse,
  buildSendOrderRequest,
  type CancelMarketOrdersRequest,
  type CancelOrdersResponse,
  decodeApiKeyInfo,
  decodeBalanceAllowance,
  decodeBook,
  decodeCancelOrdersResponse,
  decodeCredentials,
  decodeDecimalMap,
  decodeFeeRate,
  decodeLastTradePrice,
  decodeLastTradePriceEntry,
  decodeMidpoint,
  decodeOpenOrder,
  decodePage,
  decodePostOrderResponse,
  decodePrice,
  decodePriceHistory,
  decodeReplaceOrdersResponse,
  decodeSpread,
  decodeTickSize,
  decodeTrade,
  type FeeRateResponse,
  type HeartbeatResponse,
  type LastTradePriceEntry,
  type LastTradePriceResponse,
  type MidpointResponse,
  type MidpointsResponse,
  type OpenOrderResponse,
  type OrderBookSummary,
  type OrderScoringResponse,
  type OrdersQuery,
  type Page,
  type PostOrderResponse,
  type PriceHistoryInterval,
  type PriceHistoryResponse,
  type PriceResponse,
  type PricesResponse,
  type ReplaceOrdersRequest,
  type ReplaceOrdersResponse,
  type SpreadResponse,
  type SpreadsResponse,
  type TickSizeResponse,
  type TokenIdItem,
  type TokenSideItem,
  type TradeResponse,
  type TradesQuery,
} from "./types.js";

/** Server cap on `POST /orders` batch size. */
export const MAX_ORDERS_PER_BATCH = 15;
/** Server cap on `DELETE /orders` batch size. */
export const MAX_CANCEL_IDS_PER_BATCH = 3000;
/** Server cap on `POST /last-trades-prices` batch size. */
export const MAX_LAST_TRADES_PRICES_BATCH = 500;

export interface ClobClientOptions {
  /** Pre-configured HTTP client (takes precedence over `baseUrl`). */
  http?: HttpClient;
  /** CLOB base URL, e.g. `https://clob-api.hermestrade.xyz`. */
  baseUrl?: string;
  /** L1 signer — required for API-key CRUD and the limitOrder/marketOrder helpers. */
  signer?: PredictSigner;
  /** L2 credentials — required for trading endpoints. */
  credentials?: ApiCredentials;
  /**
   * Maker / Safe address holding the funds: default `maker` for built orders and
   * default `maker_address` for `GET /trades`. (Balance queries don't take an
   * address — the server derives the Safe from `EOA + scopeId`.)
   */
  fundingAddress?: Address;
  /**
   * EOA address for the L2 `PRED_ADDRESS` header (the key owner). Defaults to
   * `signer.address`; required for L2 calls when no signer is configured.
   */
  signerAddress?: Address;
  /**
   * Neg-risk CTF exchange address. When set, the limitOrder/marketOrder helpers
   * auto-detect neg-risk tokens (via `GET /book` `neg_risk`) and sign against this
   * contract instead of the standard exchange — required for multi-outcome (neg-risk)
   * markets, whose on-chain verifier is a different contract. Neither pm-sdk-go nor
   * predict-rs supports this; both fail with INVALID_SIGNATURE on neg-risk markets.
   */
  negRiskExchange?: Address;
}

/** Per-order args for the convenience helpers; tick size + fee rate are auto-fetched. */
export type ClobLimitOrderArgs = Omit<LimitOrderArgs, "feeRateBps" | "minimumTickSize"> & {
  /** Override the fee rate; defaults to `GET /fee-rate` for the token. */
  feeRateBps?: number | bigint;
  /** Force the neg-risk exchange domain; defaults to auto-detect via `GET /book`. */
  negRisk?: boolean;
};

export type ClobMarketOrderArgs = Omit<MarketOrderArgs, "feeRateBps" | "minimumTickSize"> & {
  feeRateBps?: number | bigint;
  /** Force the neg-risk exchange domain; defaults to auto-detect via `GET /book`. */
  negRisk?: boolean;
};

export class ClobClient {
  readonly http: HttpClient;
  readonly fundingAddress: Address | undefined;
  private readonly signer: PredictSigner | undefined;
  private readonly signerAddress: Address | undefined;
  private readonly negRiskExchange: Address | undefined;
  private readonly negRiskTokens = new Map<string, boolean>();
  private credentials: ApiCredentials | undefined;

  constructor(options: ClobClientOptions) {
    if (options.http) {
      this.http = options.http;
    } else if (options.baseUrl) {
      this.http = new HttpClient(options.baseUrl);
    } else {
      throw new ValidationError("ClobClient requires `http` or `baseUrl`");
    }
    this.signer = options.signer;
    this.negRiskExchange = options.negRiskExchange;
    this.credentials = options.credentials;
    this.fundingAddress = options.fundingAddress
      ? normalizeAddress(options.fundingAddress)
      : undefined;
    this.signerAddress = options.signerAddress
      ? normalizeAddress(options.signerAddress)
      : options.signer?.address;
  }

  /** Attach (or rotate) L2 credentials after construction. */
  setCredentials(credentials: ApiCredentials): void {
    this.credentials = credentials;
  }

  // ─── Public market data ───────────────────────────────────────────────────

  /** Health check — `GET /ok`. Returns the raw body (`"OK"`). */
  async ok(): Promise<string> {
    const res = await this.http.get<unknown>("/ok");
    return String(res.data);
  }

  /** Server time — `GET /time`. Returns a Unix timestamp (seconds). */
  async time(): Promise<number> {
    const res = await this.http.get<unknown>("/time");
    const n = typeof res.data === "number" ? res.data : Number(String(res.data).trim());
    if (!Number.isInteger(n)) {
      throw new ValidationError(`/time returned non-integer body '${String(res.data)}'`);
    }
    return n;
  }

  /** Mid-price — `GET /midpoint?token_id=...`. */
  async midpoint(tokenId: string): Promise<MidpointResponse> {
    const res = await this.http.get<unknown>("/midpoint", { query: { token_id: tokenId } });
    return decodeMidpoint(res.data);
  }

  /** Best price for a side — `GET /price?token_id=...&side=buy|sell` (lowercase side). */
  async price(tokenId: string, side: Side): Promise<PriceResponse> {
    const res = await this.http.get<unknown>("/price", {
      query: { token_id: tokenId, side: side === "BUY" ? "buy" : "sell" },
    });
    return decodePrice(res.data);
  }

  /** Bid-ask spread — `GET /spread?token_id=...`. */
  async spread(tokenId: string): Promise<SpreadResponse> {
    const res = await this.http.get<unknown>("/spread", { query: { token_id: tokenId } });
    return decodeSpread(res.data);
  }

  /** Order book snapshot — `GET /book?token_id=...`. */
  async book(tokenId: string): Promise<OrderBookSummary> {
    const res = await this.http.get<unknown>("/book", { query: { token_id: tokenId } });
    return decodeBook(res.data);
  }

  /** Tick size — `GET /tick-size?token_id=...`. */
  async tickSize(tokenId: string): Promise<TickSizeResponse> {
    const res = await this.http.get<unknown>("/tick-size", { query: { token_id: tokenId } });
    return decodeTickSize(res.data);
  }

  /** Fee rate (bps) — `GET /fee-rate?token_id=...`. */
  async feeRate(tokenId: string): Promise<FeeRateResponse> {
    const res = await this.http.get<unknown>("/fee-rate", { query: { token_id: tokenId } });
    return decodeFeeRate(res.data);
  }

  /** Last trade price — `GET /last-trade-price?token_id=...`. */
  async lastTradePrice(tokenId: string): Promise<LastTradePriceResponse> {
    const res = await this.http.get<unknown>("/last-trade-price", {
      query: { token_id: tokenId },
    });
    return decodeLastTradePrice(res.data);
  }

  /** Batch midpoints — `POST /midpoints` with `[{"token_id": ...}, ...]`. */
  async midpoints(tokenIds: string[]): Promise<MidpointsResponse> {
    const body: TokenIdItem[] = tokenIds.map((t) => ({ token_id: t }));
    const res = await this.http.post<unknown>("/midpoints", { body });
    return decodeDecimalMap(res.data);
  }

  /**
   * Batch prices — `POST /prices` with `[{"token_id": ..., "side": "BUY"|"SELL"}, ...]`.
   * Returns a nested map `token_id -> { "BUY": price, "SELL": price }` (numbers).
   */
  async prices(requests: Array<{ tokenId: string; side: Side }>): Promise<PricesResponse> {
    const body: TokenSideItem[] = requests.map((r) => ({ token_id: r.tokenId, side: r.side }));
    const res = await this.http.post<PricesResponse>("/prices", { body });
    return res.data;
  }

  /** Batch spreads — `POST /spreads` with `[{"token_id": ...}, ...]`. */
  async spreads(tokenIds: string[]): Promise<SpreadsResponse> {
    const body: TokenIdItem[] = tokenIds.map((t) => ({ token_id: t }));
    const res = await this.http.post<unknown>("/spreads", { body });
    return decodeDecimalMap(res.data);
  }

  /**
   * Batch order books — `POST /books` with `[{"token_id": ..., "side": ...}, ...]`.
   * One slot per request, preserving order; `null` slots are unknown tokens.
   */
  async books(
    requests: Array<{ tokenId: string; side: Side }>,
  ): Promise<Array<OrderBookSummary | null>> {
    const body: TokenSideItem[] = requests.map((r) => ({ token_id: r.tokenId, side: r.side }));
    const res = await this.http.post<unknown>("/books", { body });
    if (!Array.isArray(res.data)) {
      throw new ValidationError("decoding /books: expected a JSON array");
    }
    return res.data.map((slot) => (slot === null || slot === undefined ? null : decodeBook(slot)));
  }

  /** Batch last-trade prices — `POST /last-trades-prices` (server caps at 500). */
  async lastTradesPrices(tokenIds: string[]): Promise<LastTradePriceEntry[]> {
    if (tokenIds.length > MAX_LAST_TRADES_PRICES_BATCH) {
      throw new ValidationError(
        `lastTradesPrices: accepts at most ${MAX_LAST_TRADES_PRICES_BATCH} token_ids per request (got ${tokenIds.length})`,
      );
    }
    const body: TokenIdItem[] = tokenIds.map((t) => ({ token_id: t }));
    const res = await this.http.post<unknown>("/last-trades-prices", { body });
    if (!Array.isArray(res.data)) {
      throw new ValidationError("decoding /last-trades-prices: expected a JSON array");
    }
    return res.data.map(decodeLastTradePriceEntry);
  }

  /**
   * Price history — `GET /price-history?token_id=...&interval=...`. Optional
   * `fidelity` (sample period, minutes) and `limit` (max points) use server
   * defaults when omitted.
   */
  async priceHistory(
    tokenId: string,
    interval: PriceHistoryInterval,
    options: { fidelity?: number; limit?: number } = {},
  ): Promise<PriceHistoryResponse> {
    const res = await this.http.get<unknown>("/price-history", {
      query: {
        token_id: tokenId,
        interval,
        fidelity: options.fidelity,
        limit: options.limit,
      },
    });
    return decodePriceHistory(res.data);
  }

  // ─── L1 auth — API key CRUD ──────────────────────────────────────────────

  /** `POST /auth/api-key` — create an L2 key bound to `(address, scopeId, nonce)`. */
  async createApiKey(nonce?: number): Promise<ApiCredentials> {
    const res = await this.http.post<unknown>("/auth/api-key", {
      headers: await this.l1Headers(nonce),
    });
    return decodeCredentials(res.data);
  }

  /** `GET /auth/derive-api-key` — recover existing credentials without minting. */
  async deriveApiKey(nonce?: number): Promise<ApiCredentials> {
    const res = await this.http.get<unknown>("/auth/derive-api-key", {
      headers: await this.l1Headers(nonce),
    });
    return decodeCredentials(res.data);
  }

  /**
   * Idempotent: try `POST /auth/api-key`; on any HTTP error response fall back to
   * `GET /auth/derive-api-key`. Transport / decode failures bubble up unchanged.
   */
  async createOrDeriveApiKey(nonce?: number): Promise<ApiCredentials> {
    try {
      return await this.createApiKey(nonce);
    } catch (e) {
      if (e instanceof ApiError) {
        return this.deriveApiKey(nonce);
      }
      throw e;
    }
  }

  /**
   * `DELETE /auth/api-key` — revoke the L2 key for `(address, scopeId, nonce)`. The
   * server identifies the row by the L1 headers; no body or key id is sent.
   */
  async revokeApiKey(nonce = 0): Promise<void> {
    await this.http.del<unknown>("/auth/api-key", { headers: await this.l1Headers(nonce) });
  }

  // ─── L2 auth — reads ─────────────────────────────────────────────────────

  /** `GET /auth/api-keys` — list active API keys + `proxy_wallet`. */
  async apiKeys(): Promise<ApiKeyInfo> {
    return decodeApiKeyInfo(await this.requestL2("GET", "/auth/api-keys"));
  }

  /**
   * `GET /balance-allowance?asset_type=...&token_id=...` — Safe-wallet balance +
   * allowances. `CONDITIONAL` requires `token_id`; `COLLATERAL` must not carry one.
   */
  async balanceAllowance(
    assetType: AssetType,
    tokenId?: string,
  ): Promise<BalanceAllowanceResponse> {
    const query = balanceAllowanceQuery(assetType, tokenId);
    return decodeBalanceAllowance(await this.requestL2("GET", "/balance-allowance", { query }));
  }

  /**
   * `GET /balance-allowance/update` — force a server-side balance cache refresh.
   * The live deployment returns an empty body from `/update` (predict-rs still assumes
   * the balance shape); when that happens we follow up with `GET /balance-allowance`.
   */
  async updateBalanceAllowance(
    assetType: AssetType,
    tokenId?: string,
  ): Promise<BalanceAllowanceResponse> {
    const query = balanceAllowanceQuery(assetType, tokenId);
    const raw = await this.requestL2("GET", "/balance-allowance/update", { query });
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return decodeBalanceAllowance(raw);
    }
    return this.balanceAllowance(assetType, tokenId);
  }

  // ─── L2 auth — orders / trades ───────────────────────────────────────────

  /** `POST /order` — submit a single signed order. */
  async postOrder(
    signed: SignedOrderWire,
    orderType: OrderType,
    postOnly = false,
    owner = "",
  ): Promise<PostOrderResponse> {
    const body = buildSendOrderRequest(signed, orderType, postOnly, owner);
    return decodePostOrderResponse(await this.requestL2("POST", "/order", { body }));
  }

  /** `POST /orders` — batch up to 15 signed orders (bare JSON array of envelopes). */
  async postOrders(
    signed: SignedOrderWire[],
    orderType: OrderType,
    postOnly = false,
    owner = "",
  ): Promise<PostOrderResponse[]> {
    if (signed.length === 0) return [];
    if (signed.length > MAX_ORDERS_PER_BATCH) {
      throw new ValidationError(
        `postOrders: accepts at most ${MAX_ORDERS_PER_BATCH} orders per batch (got ${signed.length})`,
      );
    }
    const body = signed.map((o) => buildSendOrderRequest(o, orderType, postOnly, owner));
    const raw = await this.requestL2("POST", "/orders", { body });
    if (!Array.isArray(raw)) {
      throw new ValidationError("decoding /orders response: expected a JSON array");
    }
    return raw.map(decodePostOrderResponse);
  }

  /** `POST /orders/replace` — atomic cancel + place. */
  async replaceOrders(request: ReplaceOrdersRequest): Promise<ReplaceOrdersResponse> {
    return decodeReplaceOrdersResponse(
      await this.requestL2("POST", "/orders/replace", { body: request }),
    );
  }

  /** `DELETE /order` — cancel one order. Body: `{"orderID": "..."}`. */
  async cancelOrder(orderId: string): Promise<CancelOrdersResponse> {
    return decodeCancelOrdersResponse(
      await this.requestL2("DELETE", "/order", { body: { orderID: orderId } }),
    );
  }

  /** `DELETE /orders` — batch cancel by id (max 3000). Body is a bare JSON array. */
  async cancelOrders(orderIds: string[]): Promise<CancelOrdersResponse> {
    if (orderIds.length > MAX_CANCEL_IDS_PER_BATCH) {
      throw new ValidationError(
        `cancelOrders: accepts at most ${MAX_CANCEL_IDS_PER_BATCH} ids per batch (got ${orderIds.length})`,
      );
    }
    return decodeCancelOrdersResponse(
      await this.requestL2("DELETE", "/orders", { body: orderIds }),
    );
  }

  /** `DELETE /cancel-all` — cancel every open order for the API-key owner. No body. */
  async cancelAll(): Promise<CancelOrdersResponse> {
    return decodeCancelOrdersResponse(await this.requestL2("DELETE", "/cancel-all"));
  }

  /**
   * `DELETE /cancel-market-orders` — cancel by condition id (`market`) and/or token
   * id (`asset_id`). At least one is required.
   */
  async cancelMarketOrders(request: CancelMarketOrdersRequest): Promise<CancelOrdersResponse> {
    if (request.market === undefined && request.asset_id === undefined) {
      throw new ValidationError(
        "cancelMarketOrders: at least one of `market` (condition id) or `asset_id` (token id) is required",
      );
    }
    const body: CancelMarketOrdersRequest = {};
    if (request.market !== undefined) body.market = request.market;
    if (request.asset_id !== undefined) body.asset_id = request.asset_id;
    return decodeCancelOrdersResponse(
      await this.requestL2("DELETE", "/cancel-market-orders", { body }),
    );
  }

  /** `GET /orders` — paginated open-order query. Pass `cursor` from `next_cursor`. */
  async openOrders(request: OrdersQuery = {}, cursor?: string): Promise<Page<OpenOrderResponse>> {
    const raw = await this.requestL2("GET", "/orders", {
      query: {
        id: request.id,
        market: request.market,
        asset_id: request.asset_id,
        status: request.status,
        next_cursor: cursor,
      },
    });
    return decodePage(raw, decodeOpenOrder);
  }

  /** `GET /order/{orderID}` — fetch a single order (404 -> ApiError). */
  async openOrder(orderId: string): Promise<OpenOrderResponse> {
    return decodeOpenOrder(await this.requestL2("GET", `/order/${orderId}`));
  }

  /**
   * `GET /trades` — paginated trade query. `maker_address` is server-required; when
   * unset it falls back to `fundingAddress`, then the L2 signer address.
   */
  async trades(request: TradesQuery = {}, cursor?: string): Promise<Page<TradeResponse>> {
    const makerAddress = request.maker_address ?? this.fundingAddress ?? this.signerAddress;
    if (makerAddress === undefined) {
      throw new ValidationError(
        "trades: maker_address required (set TradesQuery.maker_address, fundingAddress, or a signer)",
      );
    }
    const raw = await this.requestL2("GET", "/trades", {
      query: {
        maker_address: makerAddress,
        id: request.id,
        market: request.market,
        asset_id: request.asset_id,
        before: request.before,
        after: request.after,
        from_id: request.from_id,
        limit: request.limit,
        next_cursor: cursor,
      },
    });
    return decodePage(raw, decodeTrade);
  }

  /** `GET /builder/trades` — builder-program variant (no maker_address injection). */
  async builderTrades(request: TradesQuery = {}, cursor?: string): Promise<Page<TradeResponse>> {
    const raw = await this.requestL2("GET", "/builder/trades", {
      query: {
        id: request.id,
        market: request.market,
        asset_id: request.asset_id,
        from_id: request.from_id,
        limit: request.limit,
        next_cursor: cursor,
      },
    });
    return decodePage(raw, decodeTrade);
  }

  /** `GET /order-scoring?order_id=...` — maker-program reward eligibility. */
  async orderScoring(orderId: string): Promise<OrderScoringResponse> {
    const raw = await this.requestL2("GET", "/order-scoring", {
      query: { order_id: orderId },
    });
    const scoring = (raw as { scoring?: unknown } | null)?.scoring === true;
    return { scoring };
  }

  /**
   * Convenience: `/order-scoring` per id -> `orderID -> scoring` map. No batch
   * endpoint exists; each call is a separate HMAC-signed request.
   */
  async ordersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of orderIds) {
      out[id] = (await this.orderScoring(id)).scoring;
    }
    return out;
  }

  /** `POST /heartbeats` — keep maker-program orders alive (send every 5 s). */
  async heartbeat(): Promise<HeartbeatResponse> {
    const raw = await this.requestL2("POST", "/heartbeats", { body: {} });
    return { status: String((raw as { status?: unknown } | null)?.status ?? "") };
  }

  // ─── Convenience: build + sign + post ────────────────────────────────────

  /**
   * Build, sign, and post a limit order. Fetches `GET /tick-size` and
   * `GET /fee-rate` for the token first (predict-rs `Client::limit_order` flow);
   * `maker` defaults to `fundingAddress`.
   */
  async limitOrder(args: ClobLimitOrderArgs): Promise<PostOrderResponse> {
    const { built, signed } = await this.buildAndSign(args, "limit");
    return this.postOrder(signed, built.orderType, built.postOnly, built.owner);
  }

  /** Build, sign, and post a market order (FAK default). See {@link limitOrder}. */
  async marketOrder(args: ClobMarketOrderArgs): Promise<PostOrderResponse> {
    const { built, signed } = await this.buildAndSign(args, "market");
    return this.postOrder(signed, built.orderType, built.postOnly, built.owner);
  }

  /**
   * Whether a token belongs to a neg-risk (multi-outcome) market, per `GET /book`.
   * Cached per token id for the client's lifetime.
   */
  async isNegRiskToken(tokenId: string): Promise<boolean> {
    const cached = this.negRiskTokens.get(tokenId);
    if (cached !== undefined) return cached;
    const book = await this.book(tokenId);
    const negRisk = book.neg_risk === true;
    this.negRiskTokens.set(tokenId, negRisk);
    return negRisk;
  }

  private async buildAndSign(
    args: ClobLimitOrderArgs | ClobMarketOrderArgs,
    kind: "limit" | "market",
  ): Promise<{ built: BuiltOrder; signed: SignedOrderWire }> {
    let signer = this.requireSigner();
    const tokenId = args.tokenId.toString();
    const [tick, fee] = await Promise.all([this.tickSize(tokenId), this.feeRate(tokenId)]);
    if (this.negRiskExchange) {
      const negRisk = args.negRisk ?? (await this.isNegRiskToken(tokenId));
      if (negRisk) {
        signer = signer.withExchange(this.negRiskExchange);
      }
    }
    const full: Record<string, unknown> = {
      ...args,
      feeRateBps: args.feeRateBps ?? fee.fee_rate_bps,
      minimumTickSize: tick.minimum_tick_size,
    };
    if (full.maker === undefined && this.fundingAddress !== undefined) {
      full.maker = this.fundingAddress;
    }
    const built =
      kind === "limit"
        ? buildLimitOrder(full as unknown as LimitOrderArgs, signer)
        : buildMarketOrder(full as unknown as MarketOrderArgs, signer);
    const signed = await signBuiltOrder(built, signer);
    return { built, signed };
  }

  // ─── plumbing ────────────────────────────────────────────────────────────

  private requireSigner(): PredictSigner {
    if (!this.signer) {
      throw new ValidationError("this call requires a signer: pass `signer` to ClobClient");
    }
    return this.signer;
  }

  private requireCredentials(): ApiCredentials {
    if (!this.credentials) {
      throw new ValidationError(
        "L2 request requires credentials: pass `credentials` to ClobClient or call setCredentials()",
      );
    }
    return this.credentials;
  }

  private requireL2Address(): Address {
    if (!this.signerAddress) {
      throw new ValidationError(
        "L2 request requires the key owner's EOA address: pass `signer` or `signerAddress` to ClobClient",
      );
    }
    return this.signerAddress;
  }

  private async l1Headers(nonce?: number): Promise<Record<string, string>> {
    const signer = this.requireSigner();
    return buildL1Headers(signer, nonce === undefined ? {} : { nonce });
  }

  /**
   * Issue an L2-authenticated request. The HMAC is computed over the URL path only
   * (no query string) and the exact serialized body — the same body string the
   * HttpClient puts on the wire.
   */
  private async requestL2(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: HttpRequestOptions["query"]; body?: unknown } = {},
  ): Promise<unknown> {
    const creds = this.requireCredentials();
    const address = this.requireL2Address();
    const timestamp = currentTimestamp();
    const bodyText = HttpClient.serializeBody(options.body);
    const headers = buildL2Headers(
      creds,
      address,
      timestamp,
      method,
      this.http.buildPath(path),
      bodyText,
    );
    const reqOptions: HttpRequestOptions = { headers };
    if (options.query !== undefined) reqOptions.query = options.query;
    if (options.body !== undefined) reqOptions.body = options.body;
    const res = await this.http.request<unknown>(method, path, reqOptions);
    return res.data;
  }
}

function balanceAllowanceQuery(assetType: AssetType, tokenId?: string): Record<string, string> {
  if (assetType === "CONDITIONAL") {
    if (tokenId === undefined || tokenId === "") {
      throw new ValidationError(
        "balance-allowance: token_id is required when asset_type=CONDITIONAL",
      );
    }
    return { asset_type: assetType, token_id: tokenId };
  }
  if (tokenId !== undefined && tokenId !== "") {
    throw new ValidationError(
      "balance-allowance: token_id must be omitted when asset_type=COLLATERAL",
    );
  }
  return { asset_type: assetType };
}
