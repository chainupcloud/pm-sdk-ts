/**
 * Wire types for the CLOB REST API.
 *
 * Field names mirror predict-rs `clob-client/src/clob/types.rs` (which matches the
 * platform's `services/clob-service/docs/openapi.yaml`) EXACTLY, including serde
 * renames (`tokenID`, `orderType`, `errorMsg`, ...) and aliases (`mid`, `base_fee`,
 * `last_trade_price`, `apiKey`, `tradeIds`, ...). Decode helpers normalize alias
 * variants and serde defaults (null arrays -> [], missing strings -> "").
 *
 * Decimal-valued fields are kept as strings on the TS side; the server emits strings
 * for most decimal fields but numbers for a few (e.g. `/tick-size`), so decoders
 * accept both and normalize to string (parity with rust_decimal's serde behavior).
 */

import { ValidationError } from "../errors.js";
import type { SignedOrderWire } from "../order-builder.js";
import type { ApiCredentials, OrderType, Side } from "../types.js";

// ─── Public market-data responses ───────────────────────────────────────────

/** `GET /midpoint` — Rust accepts the `mid` alias for `price`. */
export interface MidpointResponse {
  price: string;
}

/** `GET /price` */
export interface PriceResponse {
  price: string;
}

/** `GET /spread` */
export interface SpreadResponse {
  spread: string;
}

/** `GET /tick-size` — wire key `minimum_tick_size`, string or number on the wire. */
export interface TickSizeResponse {
  minimum_tick_size: string;
}

/**
 * `GET /fee-rate` — the server returns `base_fee`; upstream V1 names are accepted as
 * aliases (`fee_rate_bps` / `feeRateBps`), mirroring Rust `FeeRateResponse`.
 */
export interface FeeRateResponse {
  fee_rate_bps: number;
}

/** `GET /last-trade-price` — Rust accepts the `last_trade_price` alias for `price`. */
export interface LastTradePriceResponse {
  price: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

/** `GET /book` / one slot of `POST /books`. Optional fields are server extensions. */
export interface OrderBookSummary {
  /** CLOB token id (uint256 decimal string). */
  asset_id: string;
  /** Condition id — sent alongside `asset_id`; distinct field, not an alias. */
  market?: string | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp?: string | null;
  hash?: string | null;
  /** Last-trade-price echo (decimal string). */
  last_trade_price?: string | null;
  /** Per-market tick size returned inside `/book` (decimal string). */
  tick_size?: string | null;
  /** Neg-risk flag returned inside `/book`. */
  neg_risk?: boolean | null;
  /** Minimum order size (decimal string). */
  min_order_size?: string | null;
  /** Maximum order size (decimal string). Empty string when uncapped. */
  max_order_size?: string | null;
}

// ─── Batch-read shapes (POST endpoints) ─────────────────────────────────────

/** `POST /midpoints` response — map `token_id -> midpoint` (decimal string). */
export type MidpointsResponse = Record<string, string>;

/** `POST /spreads` response — map `token_id -> spread` (decimal string). */
export type SpreadsResponse = Record<string, string>;

/**
 * `POST /prices` response — nested map `token_id -> { "BUY": price, "SELL": price }`.
 * The server returns floating-point numbers (not strings) for this endpoint.
 */
export type PricesResponse = Record<string, Record<string, number>>;

/** One entry in the `POST /last-trades-prices` response. */
export interface LastTradePriceEntry {
  token_id: string;
  price: string;
  /** Last trade side as a free-form string (empty when no trades yet). */
  side: string;
}

// ─── Price history ──────────────────────────────────────────────────────────

/** `GET /price-history` interval values (no minute granularity). */
export type PriceHistoryInterval = "1H" | "6H" | "1D" | "1W" | "1M" | "ALL";

export interface PricePoint {
  /** Unix-seconds bucket timestamp (alias `timestamp`). */
  t: number;
  /** Bucket price as a decimal string (alias `price`). */
  p: string;
}

export interface PriceHistoryResponse {
  history: PricePoint[];
}

// ─── Auth / balance-allowance ───────────────────────────────────────────────

/**
 * `asset_type` query parameter for `/balance-allowance` (and `/update`). Only the
 * literals `"COLLATERAL"` / `"CONDITIONAL"` are accepted server-side.
 */
export const AssetType = {
  COLLATERAL: "COLLATERAL",
  CONDITIONAL: "CONDITIONAL",
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

/** `GET /auth/api-keys` response. */
export interface ApiKeyInfo {
  /** Active API key UUIDs (wire key `apiKeys`). */
  apiKeys: string[];
  /** EOA address — the L1 signer behind every listed key. */
  address?: string | null;
  /** Safe wallet address (wire key `proxyWallet` or `proxy_wallet`). */
  proxy_wallet?: string | null;
}

/** `GET /balance-allowance` response. The balance belongs to the Safe, not the EOA. */
export interface BalanceAllowanceResponse {
  balance: string;
  /** Allowance map keyed by spender address. */
  allowances: Record<string, string>;
  /** Available balance after open-order locks (virtual-balance manager only). */
  virtual_available?: string | null;
  /** Amount locked by open orders (virtual-balance manager only). */
  locked?: string | null;
}

// ─── Order / trade / cancel wire types ──────────────────────────────────────

/**
 * `POST /order` / `POST /orders` request envelope (Go `handlers.orderRequest`).
 * `owner` is omitted when empty; `postOnly` / `deferExec` are omitted when false
 * (serde `skip_serializing_if`).
 */
export interface SendOrderRequest {
  order: SignedOrderWire;
  owner?: string;
  orderType: OrderType;
  postOnly?: boolean;
  deferExec?: boolean;
}

/**
 * On the wire `signatureType` is the NUMERIC string `"0" | "1" | "2"` (Go
 * `OrderSignatureType` / Rust `o.signature_type.to_string()`), NOT the enum name.
 * `toWireOrder` in order-builder.ts emits the name form; this normalizes either.
 */
export function signatureTypeToNumericWire(value: string): string {
  switch (value) {
    case "0":
    case "EOA":
      return "0";
    case "1":
    case "POLY_PROXY":
      return "1";
    case "2":
    case "POLY_GNOSIS_SAFE":
      return "2";
    default:
      throw new ValidationError(`invalid signatureType "${value}"`);
  }
}

/**
 * Build the `POST /order(s)` envelope from a signed wire order. Normalizes
 * `signatureType` to the numeric wire string and applies the serde skip rules.
 */
export function buildSendOrderRequest(
  signed: SignedOrderWire,
  orderType: OrderType,
  postOnly = false,
  owner = "",
): SendOrderRequest {
  const order: SignedOrderWire = {
    ...signed,
    signatureType: signatureTypeToNumericWire(signed.signatureType),
  };
  const req: SendOrderRequest = owner !== "" ? { order, owner, orderType } : { order, orderType };
  if (postOnly) {
    req.postOnly = true;
  }
  return req;
}

/** `POST /order` (and per-item batch / replace placement) response. */
export interface PostOrderResponse {
  success: boolean;
  errorMsg: string;
  orderID: string;
  takingAmount: string;
  makingAmount: string;
  status: string;
  transactionsHashes: string[];
  /** Wire key `tradeIDs` (alias `tradeIds`). */
  tradeIDs: string[];
}

/** `POST /orders/replace` request body. */
export interface ReplaceOrdersRequest {
  cancelOrderIDs: string[];
  orders: SendOrderRequest[];
}

/** `POST /orders/replace` per-cancel result. */
export interface ReplaceCancelResult {
  orderID: string;
  status: string;
}

/** `POST /orders/replace` per-placement result. */
export interface ReplacePlaceResult extends PostOrderResponse {
  index: number;
}

/** `POST /orders/replace` response. */
export interface ReplaceOrdersResponse {
  stoppedAt: string;
  cancels: ReplaceCancelResult[];
  placements: ReplacePlaceResult[];
  errorMsg: string;
}

/** `DELETE /order|/orders|/cancel-all|/cancel-market-orders` response. */
export interface CancelOrdersResponse {
  canceled: string[];
  /** Map of `orderID -> reason`; `{}` on full success. */
  not_canceled: Record<string, string>;
}

/**
 * `DELETE /cancel-market-orders` request body. At least one of `market` (condition
 * id) or `asset_id` (token id) must be present.
 */
export interface CancelMarketOrdersRequest {
  market?: string;
  asset_id?: string;
}

/** `GET /orders` query filters. All optional. */
export interface OrdersQuery {
  id?: string;
  market?: string;
  asset_id?: string;
  /** `ORDER_STATUS_LIVE` (server default), `"all"`, or an explicit status literal. */
  status?: string;
}

/**
 * `GET /trades` query filters. `maker_address` is server-required; the client fills
 * it from `fundingAddress` (falling back to the L2 signer address) when unset.
 */
export interface TradesQuery {
  maker_address?: string;
  id?: string;
  market?: string;
  asset_id?: string;
  /** Unix-seconds upper bound. */
  before?: number;
  /** Unix-seconds lower bound. */
  after?: number;
  /** Snowflake `from_id` ASC cursor. */
  from_id?: number;
  /** Page size [1, 1000]. Server default 100. */
  limit?: number;
}

/** One row in `GET /orders` (server `openOrderJSON`). */
export interface OpenOrderResponse {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  outcome: string;
  original_size: string;
  size_matched: string;
  price: string;
  expiration: string;
  order_type: string;
  created_at: string;
  associate_trades: string[];
  lazy: boolean;
}

/** One row in `GET /trades` (server `tradeJSON`). */
export interface TradeResponse {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  fee_rate_bps: string;
  fee: string;
  price: string;
  status: string;
  match_time: string;
  match_time_nano: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side: string;
  maker_orders: unknown[];
  match_type: string;
  order_type: string;
}

/**
 * Cursor-paginated envelope used by `GET /orders` and `GET /trades`. The server
 * signals end-of-stream with `next_cursor: "LTE="` (base64 of "-1"); the empty
 * string is also treated as end-of-stream.
 */
export interface Page<T> {
  limit: number;
  count: number;
  next_cursor: string;
  data: T[];
}

/** Server-side sentinel for "no more pages". */
export const END_CURSOR = "LTE=";

export function isPageEnd(page: Page<unknown>): boolean {
  return page.next_cursor === "" || page.next_cursor === END_CURSOR;
}

/** `GET /order-scoring` response. */
export interface OrderScoringResponse {
  scoring: boolean;
}

/** `POST /heartbeats` response. */
export interface HeartbeatResponse {
  status: string;
}

// ─── Decode helpers (serde alias / default parity) ──────────────────────────

type Raw = Record<string, unknown>;

function asRaw(value: unknown, what: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`decoding ${what}: expected a JSON object`);
  }
  return value as Raw;
}

/** Decimal field: the server emits strings for most endpoints, numbers for a few. */
function decimalString(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  throw new ValidationError(`decoding ${what}: expected a decimal string or number`);
}

function str(raw: Raw, key: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : "";
}

function num(raw: Raw, key: string): number {
  const v = raw[key];
  return typeof v === "number" ? v : 0;
}

function bool(raw: Raw, key: string): boolean {
  return raw[key] === true;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function strRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Raw)) {
    out[k] = decimalString(v, `map entry ${k}`);
  }
  return out;
}

export function decodeMidpoint(value: unknown): MidpointResponse {
  const raw = asRaw(value, "/midpoint");
  return { price: decimalString(raw.price ?? raw.mid, "/midpoint price") };
}

export function decodePrice(value: unknown): PriceResponse {
  const raw = asRaw(value, "/price");
  return { price: decimalString(raw.price, "/price price") };
}

export function decodeSpread(value: unknown): SpreadResponse {
  const raw = asRaw(value, "/spread");
  return { spread: decimalString(raw.spread, "/spread spread") };
}

export function decodeTickSize(value: unknown): TickSizeResponse {
  const raw = asRaw(value, "/tick-size");
  return {
    minimum_tick_size: decimalString(raw.minimum_tick_size, "/tick-size minimum_tick_size"),
  };
}

export function decodeFeeRate(value: unknown): FeeRateResponse {
  const raw = asRaw(value, "/fee-rate");
  const v = raw.fee_rate_bps ?? raw.feeRateBps ?? raw.base_fee;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ValidationError("decoding /fee-rate: missing fee_rate_bps/feeRateBps/base_fee");
  }
  return { fee_rate_bps: n };
}

export function decodeLastTradePrice(value: unknown): LastTradePriceResponse {
  const raw = asRaw(value, "/last-trade-price");
  return { price: decimalString(raw.price ?? raw.last_trade_price, "/last-trade-price price") };
}

function decodeLevel(value: unknown): OrderBookLevel {
  const raw = asRaw(value, "book level");
  return {
    price: decimalString(raw.price, "book level price"),
    size: decimalString(raw.size, "book level size"),
  };
}

export function decodeBook(value: unknown): OrderBookSummary {
  const raw = asRaw(value, "/book");
  const out: OrderBookSummary = {
    asset_id: str(raw, "asset_id"),
    bids: Array.isArray(raw.bids) ? raw.bids.map(decodeLevel) : [],
    asks: Array.isArray(raw.asks) ? raw.asks.map(decodeLevel) : [],
  };
  if (typeof raw.market === "string") out.market = raw.market;
  if (typeof raw.timestamp === "string") out.timestamp = raw.timestamp;
  if (typeof raw.hash === "string") out.hash = raw.hash;
  if (raw.last_trade_price !== undefined && raw.last_trade_price !== null) {
    out.last_trade_price = decimalString(raw.last_trade_price, "/book last_trade_price");
  }
  if (raw.tick_size !== undefined && raw.tick_size !== null) {
    out.tick_size = decimalString(raw.tick_size, "/book tick_size");
  }
  if (typeof raw.neg_risk === "boolean") out.neg_risk = raw.neg_risk;
  if (typeof raw.min_order_size === "string") out.min_order_size = raw.min_order_size;
  if (typeof raw.max_order_size === "string") out.max_order_size = raw.max_order_size;
  return out;
}

export function decodeDecimalMap(value: unknown): Record<string, string> {
  return strRecord(value);
}

export function decodeLastTradePriceEntry(value: unknown): LastTradePriceEntry {
  const raw = asRaw(value, "/last-trades-prices entry");
  return {
    token_id: str(raw, "token_id"),
    price: decimalString(raw.price, "/last-trades-prices price"),
    side: str(raw, "side"),
  };
}

export function decodePricePoint(value: unknown): PricePoint {
  const raw = asRaw(value, "price point");
  const t = raw.t ?? raw.timestamp;
  return {
    t: typeof t === "number" ? t : Number(t ?? 0),
    p: decimalString(raw.p ?? raw.price, "price point p"),
  };
}

export function decodePriceHistory(value: unknown): PriceHistoryResponse {
  const raw = asRaw(value, "/price-history");
  return {
    history: Array.isArray(raw.history) ? raw.history.map(decodePricePoint) : [],
  };
}

/** `POST /auth/api-key` / `GET /auth/derive-api-key` response (`apiKey` alias for `key`). */
export function decodeCredentials(value: unknown): ApiCredentials {
  const raw = asRaw(value, "/auth/api-key");
  const key = raw.key ?? raw.apiKey;
  if (
    typeof key !== "string" ||
    typeof raw.secret !== "string" ||
    typeof raw.passphrase !== "string"
  ) {
    throw new ValidationError("decoding /auth/api-key: missing key/secret/passphrase");
  }
  return { key, secret: raw.secret, passphrase: raw.passphrase };
}

export function decodeApiKeyInfo(value: unknown): ApiKeyInfo {
  const raw = asRaw(value, "/auth/api-keys");
  const out: ApiKeyInfo = { apiKeys: strArray(raw.apiKeys) };
  if (typeof raw.address === "string") out.address = raw.address;
  const proxy = raw.proxy_wallet ?? raw.proxyWallet;
  if (typeof proxy === "string") out.proxy_wallet = proxy;
  return out;
}

export function decodeBalanceAllowance(value: unknown): BalanceAllowanceResponse {
  const raw = asRaw(value, "/balance-allowance");
  const out: BalanceAllowanceResponse = {
    balance: str(raw, "balance"),
    allowances: strRecord(raw.allowances),
  };
  if (typeof raw.virtual_available === "string") out.virtual_available = raw.virtual_available;
  if (typeof raw.locked === "string") out.locked = raw.locked;
  return out;
}

export function decodePostOrderResponse(value: unknown): PostOrderResponse {
  const raw = asRaw(value, "/order response");
  return {
    success: bool(raw, "success"),
    errorMsg: str(raw, "errorMsg"),
    orderID: str(raw, "orderID"),
    takingAmount: str(raw, "takingAmount"),
    makingAmount: str(raw, "makingAmount"),
    status: str(raw, "status"),
    transactionsHashes: strArray(raw.transactionsHashes),
    tradeIDs: strArray(raw.tradeIDs ?? raw.tradeIds),
  };
}

export function decodeCancelOrdersResponse(value: unknown): CancelOrdersResponse {
  const raw = asRaw(value, "cancel response");
  const notCanceled: Record<string, string> = {};
  if (typeof raw.not_canceled === "object" && raw.not_canceled !== null) {
    for (const [k, v] of Object.entries(raw.not_canceled as Raw)) {
      notCanceled[k] = String(v);
    }
  }
  return { canceled: strArray(raw.canceled), not_canceled: notCanceled };
}

export function decodeReplaceOrdersResponse(value: unknown): ReplaceOrdersResponse {
  const raw = asRaw(value, "/orders/replace response");
  const cancels: ReplaceCancelResult[] = Array.isArray(raw.cancels)
    ? raw.cancels.map((c) => {
        const r = asRaw(c, "replace cancel result");
        return { orderID: str(r, "orderID"), status: str(r, "status") };
      })
    : [];
  const placements: ReplacePlaceResult[] = Array.isArray(raw.placements)
    ? raw.placements.map((p) => {
        const r = asRaw(p, "replace placement result");
        return { index: num(r, "index"), ...decodePostOrderResponse(r) };
      })
    : [];
  return {
    stoppedAt: str(raw, "stoppedAt"),
    cancels,
    placements,
    errorMsg: str(raw, "errorMsg"),
  };
}

export function decodeOpenOrder(value: unknown): OpenOrderResponse {
  const raw = asRaw(value, "open order");
  return {
    id: str(raw, "id"),
    status: str(raw, "status"),
    owner: str(raw, "owner"),
    maker_address: str(raw, "maker_address"),
    market: str(raw, "market"),
    asset_id: str(raw, "asset_id"),
    side: str(raw, "side"),
    outcome: str(raw, "outcome"),
    original_size: str(raw, "original_size"),
    size_matched: str(raw, "size_matched"),
    price: str(raw, "price"),
    expiration: str(raw, "expiration"),
    order_type: str(raw, "order_type"),
    created_at: str(raw, "created_at"),
    // Server sometimes returns null instead of [] (Rust null_as_empty_vec).
    associate_trades: strArray(raw.associate_trades),
    lazy: bool(raw, "lazy"),
  };
}

export function decodeTrade(value: unknown): TradeResponse {
  const raw = asRaw(value, "trade");
  return {
    id: str(raw, "id"),
    taker_order_id: str(raw, "taker_order_id"),
    market: str(raw, "market"),
    asset_id: str(raw, "asset_id"),
    side: str(raw, "side"),
    size: str(raw, "size"),
    fee_rate_bps: str(raw, "fee_rate_bps"),
    fee: str(raw, "fee"),
    price: str(raw, "price"),
    status: str(raw, "status"),
    match_time: str(raw, "match_time"),
    match_time_nano: str(raw, "match_time_nano"),
    last_update: str(raw, "last_update"),
    outcome: str(raw, "outcome"),
    bucket_index: num(raw, "bucket_index"),
    owner: str(raw, "owner"),
    maker_address: str(raw, "maker_address"),
    transaction_hash: str(raw, "transaction_hash"),
    trader_side: str(raw, "trader_side"),
    maker_orders: Array.isArray(raw.maker_orders) ? raw.maker_orders : [],
    match_type: str(raw, "match_type"),
    order_type: str(raw, "order_type"),
  };
}

export function decodePage<T>(value: unknown, decodeItem: (item: unknown) => T): Page<T> {
  const raw = asRaw(value, "page");
  return {
    limit: num(raw, "limit"),
    count: num(raw, "count"),
    next_cursor: str(raw, "next_cursor"),
    // null is treated as an empty page (Rust null_as_empty_vec).
    data: Array.isArray(raw.data) ? raw.data.map(decodeItem) : [],
  };
}

// ─── Batch request body shapes (POST) ───────────────────────────────────────

/** Wire shape for batch requests that take only `{ token_id }`. */
export interface TokenIdItem {
  token_id: string;
}

/** Wire shape for batch requests that take `{ token_id, side }` (UPPERCASE side). */
export interface TokenSideItem {
  token_id: string;
  side: Side;
}
