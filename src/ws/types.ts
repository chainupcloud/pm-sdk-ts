/**
 * WebSocket wire types for the CLOB `/ws/market` (public) and `/ws/user`
 * (auth-required) channels.
 *
 * Parity targets (authoritative): predict-rs `clob-client/src/clob/ws/types/{request,response}.rs`
 * (verified against the live hermestrade.xyz deployment) and `pm-sdk-go/pkg/ws/types.go`.
 *
 * Wire-format notes:
 * - Inbound events are NESTED: `{"event_type": "...", "data": {...}}`. The asyncapi spec
 *   shows a flat shape; production diverges — we follow live behaviour like predict-rs.
 *   Top-level echo fields (`asset_id` on book/price_change frames, `owner` / `condition_id`
 *   on user frames) repeat values inside `data` and are ignored.
 * - PING/PONG are literal TEXT frames, not protocol-level ping opcodes.
 * - Order statuses arrive in three flavours (`ORDER_STATUS_LIVE` / `live` / `LIVE`);
 *   trade statuses in two-plus (`TRADE_STATUS_MATCHED` / `MATCHED` / `matched`). All are
 *   normalized to the long prefixed form (the predict-rs canonical serialization).
 * - Timestamps arrive as JSON numbers, quoted integer strings, or (rarely) RFC3339
 *   strings; all parse to an integer (RFC3339 collapses to Unix seconds, mirroring the
 *   predict-rs `Timestamp` visitor).
 */

import { PredictError } from "../errors.js";
import type { Side } from "../types.js";

// ─── errors ─────────────────────────────────────────────────────────────────

/** JSON decode failure on an inbound frame. Non-terminal: the stream continues. */
export class WsDecodeError extends PredictError {
  readonly rawFrame: string;

  constructor(message: string, rawFrame = "") {
    super(message);
    this.rawFrame = rawFrame;
  }
}

/**
 * Authentication failure. Terminal: the reconnect loop never swallows it
 * (parity with predict-rs `WsError::Auth` / `WsError::UserAuthRejected`).
 */
export class WsAuthError extends PredictError {
  /** HTTP status of a rejected upgrade, or 0 for an in-band `{"error": ...}` envelope. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── outbound subscribe envelopes ───────────────────────────────────────────

/** Order-book depth level for `/ws/market`. Server default (when omitted): 2. */
export type MarketLevel = 1 | 2 | 3;

export type SubscriptionOperation = "subscribe" | "unsubscribe";

/**
 * Initial subscription envelope for `/ws/market` (`subscriptionRequest` schema).
 * predict-rs always serializes `initial_dump` (defaulting it to true) and omits
 * `level` / `custom_feature_enabled` when unset; we mirror that.
 */
export interface MarketSubscribeMessage {
  assets_ids: string[];
  type: "market";
  initial_dump?: boolean;
  level?: MarketLevel;
  custom_feature_enabled?: boolean;
}

/** Runtime subscribe / unsubscribe envelope for `/ws/market` (`subscriptionRequestUpdate`). */
export interface MarketUpdateMessage {
  operation: SubscriptionOperation;
  assets_ids: string[];
  level?: MarketLevel;
  custom_feature_enabled?: boolean;
}

/**
 * Auth block shipped in the first `/ws/user` frame. The server validates
 * `apiKey` + `passphrase` only; `secret` is accepted but currently unused.
 */
export interface WsUserAuth {
  apiKey: string;
  secret?: string;
  passphrase: string;
}

/**
 * Authenticated subscribe envelope for `/ws/user`. Auth rides in the FIRST WS frame —
 * HTTP headers are ignored by the server. Empty `markets` = all markets owned by the key.
 */
export interface UserSubscribeMessage {
  auth: WsUserAuth;
  type: "user";
  markets: string[];
}

/** Runtime subscribe / unsubscribe envelope for `/ws/user` (`userSubscriptionRequestUpdate`). */
export interface UserUpdateMessage {
  operation: SubscriptionOperation;
  markets: string[];
}

// ─── inbound market-channel events ──────────────────────────────────────────

/** `OrderLevel` schema entry shared by `book` snapshots. */
export interface OrderLevel {
  price: string;
  size: string;
}

/** `book` event payload — initial dump + on-demand snapshots. */
export interface BookEvent {
  asset_id: string;
  market: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  timestamp: number;
  hash: string;
}

/** Single entry inside `PriceChangeEvent.price_changes`. */
export interface PriceChangeEntry {
  asset_id: string;
  price: string;
  /** `"0"` indicates that price level was removed. */
  size: string;
  side: Side;
  hash: string;
  best_bid: string;
  best_ask: string;
}

/** `price_change` event payload — deltas. */
export interface PriceChangeEvent {
  market: string;
  price_changes: PriceChangeEntry[];
  timestamp: number;
}

/** `last_trade_price` event payload. */
export interface LastTradePriceEvent {
  asset_id: string;
  market: string;
  price: string;
  size: string;
  fee_rate_bps: string;
  side: Side;
  timestamp: number;
  /** Empty string for synthetic trades pushed via the internal `POST /self-trade`. */
  transaction_hash: string;
}

/** `tick_size_change` event payload. */
export interface TickSizeChangeEvent {
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: number;
}

/** `best_bid_ask` event payload (pushed only when `custom_feature_enabled = true`). */
export interface BestBidAskEvent {
  asset_id: string;
  market: string;
  best_bid: string;
  best_ask: string;
  spread: string;
  timestamp: number;
}

/** `new_market` event payload (requires `custom_feature_enabled`). */
export interface NewMarketEvent {
  id: string;
  question: string;
  market: string;
  slug: string;
  assets_ids: string[];
  outcomes: string[];
  tags: string[];
  timestamp: number;
}

/** `market_resolved` event payload (requires `custom_feature_enabled`). */
export interface MarketResolvedEvent {
  id: string;
  market: string;
  assets_ids: string[];
  winning_asset_id: string;
  winning_outcome: string;
  tags: string[];
  timestamp: number;
}

/** Discriminated union over `/ws/market` events, keyed by the wire `event_type`. */
export type MarketEvent =
  | { eventType: "book"; data: BookEvent }
  | { eventType: "price_change"; data: PriceChangeEvent }
  | { eventType: "last_trade_price"; data: LastTradePriceEvent }
  | { eventType: "tick_size_change"; data: TickSizeChangeEvent }
  | { eventType: "best_bid_ask"; data: BestBidAskEvent }
  | { eventType: "new_market"; data: NewMarketEvent }
  | { eventType: "market_resolved"; data: MarketResolvedEvent };

// ─── inbound user-channel events ────────────────────────────────────────────

/**
 * Order state, normalized to the long prefixed form. The REST `/orders` endpoint uses
 * `ORDER_STATUS_LIVE`; the `/ws/user` channel uses the short lowercase form (`live`),
 * and some live frames switch to short UPPERCASE (`LIVE`). All aliases are accepted.
 */
export const WsOrderStatus = {
  LIVE: "ORDER_STATUS_LIVE",
  MATCHED: "ORDER_STATUS_MATCHED",
  CANCELED: "ORDER_STATUS_CANCELED",
  CANCELED_MARKET_RESOLVED: "ORDER_STATUS_CANCELED_MARKET_RESOLVED",
  SYSTEM_CLEARED: "ORDER_STATUS_SYSTEM_CLEARED",
  INVALID: "ORDER_STATUS_INVALID",
} as const;
export type WsOrderStatus = (typeof WsOrderStatus)[keyof typeof WsOrderStatus];

const ORDER_STATUS_ALIASES: Readonly<Record<string, WsOrderStatus>> = {
  ORDER_STATUS_LIVE: WsOrderStatus.LIVE,
  live: WsOrderStatus.LIVE,
  LIVE: WsOrderStatus.LIVE,
  ORDER_STATUS_MATCHED: WsOrderStatus.MATCHED,
  matched: WsOrderStatus.MATCHED,
  MATCHED: WsOrderStatus.MATCHED,
  ORDER_STATUS_CANCELED: WsOrderStatus.CANCELED,
  canceled: WsOrderStatus.CANCELED,
  cancelled: WsOrderStatus.CANCELED,
  CANCELED: WsOrderStatus.CANCELED,
  CANCELLED: WsOrderStatus.CANCELED,
  ORDER_STATUS_CANCELED_MARKET_RESOLVED: WsOrderStatus.CANCELED_MARKET_RESOLVED,
  canceled_market_resolved: WsOrderStatus.CANCELED_MARKET_RESOLVED,
  CANCELED_MARKET_RESOLVED: WsOrderStatus.CANCELED_MARKET_RESOLVED,
  ORDER_STATUS_SYSTEM_CLEARED: WsOrderStatus.SYSTEM_CLEARED,
  system_cleared: WsOrderStatus.SYSTEM_CLEARED,
  SYSTEM_CLEARED: WsOrderStatus.SYSTEM_CLEARED,
  ORDER_STATUS_INVALID: WsOrderStatus.INVALID,
  invalid: WsOrderStatus.INVALID,
  INVALID: WsOrderStatus.INVALID,
};

export function parseOrderStatus(raw: string): WsOrderStatus {
  const status = ORDER_STATUS_ALIASES[raw];
  if (status === undefined) {
    throw new WsDecodeError(`unknown order status "${raw}"`);
  }
  return status;
}

/**
 * Trade-lifecycle status, normalized to the long prefixed form. The same trade id
 * progresses MATCHED -> MINED -> CONFIRMED across successive `trade` frames.
 * The `/ws/user` channel uses the short UPPERCASE form (`MATCHED`); REST `/trades`
 * uses `TRADE_STATUS_MATCHED`; lowercase is accepted defensively.
 */
export const WsTradeStatus = {
  MATCHED: "TRADE_STATUS_MATCHED",
  MINED: "TRADE_STATUS_MINED",
  CONFIRMED: "TRADE_STATUS_CONFIRMED",
  RETRYING: "TRADE_STATUS_RETRYING",
  FAILED: "TRADE_STATUS_FAILED",
} as const;
export type WsTradeStatus = (typeof WsTradeStatus)[keyof typeof WsTradeStatus];

const TRADE_STATUS_ALIASES: Readonly<Record<string, WsTradeStatus>> = {
  TRADE_STATUS_MATCHED: WsTradeStatus.MATCHED,
  matched: WsTradeStatus.MATCHED,
  MATCHED: WsTradeStatus.MATCHED,
  TRADE_STATUS_MINED: WsTradeStatus.MINED,
  mined: WsTradeStatus.MINED,
  MINED: WsTradeStatus.MINED,
  TRADE_STATUS_CONFIRMED: WsTradeStatus.CONFIRMED,
  confirmed: WsTradeStatus.CONFIRMED,
  CONFIRMED: WsTradeStatus.CONFIRMED,
  TRADE_STATUS_RETRYING: WsTradeStatus.RETRYING,
  retrying: WsTradeStatus.RETRYING,
  RETRYING: WsTradeStatus.RETRYING,
  TRADE_STATUS_FAILED: WsTradeStatus.FAILED,
  failed: WsTradeStatus.FAILED,
  FAILED: WsTradeStatus.FAILED,
};

export function parseTradeStatus(raw: string): WsTradeStatus {
  const status = TRADE_STATUS_ALIASES[raw];
  if (status === undefined) {
    throw new WsDecodeError(`unknown trade status "${raw}"`);
  }
  return status;
}

/** Which side of the trade the user appears on. */
export const TraderSide = {
  TAKER: "TAKER",
  MAKER: "MAKER",
} as const;
export type TraderSide = (typeof TraderSide)[keyof typeof TraderSide];

/** Legacy sub-type values the asyncapi spec lists for the order wire `type` field. */
export type OrderSubType = "PLACEMENT" | "UPDATE" | "CANCELLATION";

/**
 * `order` event payload (inside `data: {...}`).
 *
 * The live server uses an extremely lean envelope — only `id` and `status` are
 * guaranteed. Placement events fill `asset_id` / `side` / `original_size` / `price` /
 * `type`; cancellation events typically arrive with just `{id, status}`.
 */
export interface OrderEvent {
  id: string;
  status: WsOrderStatus;
  asset_id: string;
  side?: Side;
  price: string;
  original_size: string;
  /**
   * Wire field `type`. On live frames it carries the order type (`GTC`/`GTD`/`FOK`/`FAK`);
   * legacy spec fixtures put the sub-type (`PLACEMENT`/`UPDATE`/`CANCELLATION`) here.
   */
  order_type: string;
  /** MM-lazy persistence flag, serialized as the string `"true"` / `"false"`. */
  lazy?: string;
  size_matched: string;
  owner: string;
  market: string;
  outcome: string;
  maker_address: string;
  expiration: number;
  created_at: number;
  associate_trades?: string[];
  timestamp: number;
}

/** `MakerOrderFill` schema — inside `TradeEvent.maker_orders` on taker-side trades. */
export interface MakerOrderFill {
  order_id: string;
  owner: string;
  maker_address: string;
  matched_amount: string;
  price: string;
  fee_rate_bps: string;
  asset_id: string;
  outcome: string;
  side: Side;
}

/**
 * `trade` event payload (inside `data: {...}`). Lean on the live wire: observation
 * guarantees `id`, `asset_id`, `side`, `size`, `price`, `status`; later lifecycle frames
 * (mined / confirmed) fill more. Server extensions over the asyncapi spec: `match_type`
 * (`MATCH` / `MINT` / `MERGE`) and `order_id` (alias for `taker_order_id`).
 */
export interface TradeEvent {
  id: string;
  status: WsTradeStatus;
  /** Wire field `type`; defaults to `"TRADE"` when omitted. */
  sub_type: string;
  /** Wire `taker_order_id`, with `order_id` accepted as an alias. */
  taker_order_id: string;
  market: string;
  asset_id: string;
  side?: Side;
  size: string;
  price: string;
  fee_rate_bps: string;
  /** `MATCH` = bilateral fill, `MINT` / `MERGE` = negRisk settlement. Empty when omitted. */
  match_type: string;
  outcome: string;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  bucket_index: number;
  matchtime: number;
  last_update: number;
  trader_side?: TraderSide;
  maker_orders: MakerOrderFill[];
  timestamp: number;
}

/** Discriminated union over `/ws/user` events, keyed by the wire `event_type`. */
export type UserEvent =
  | { eventType: "order"; data: OrderEvent }
  | { eventType: "trade"; data: TradeEvent };

// ─── parsing helpers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new WsDecodeError(`${ctx}: missing or non-string field "${key}"`);
  }
  return v;
}

/** Optional string with serde-style default `""`. null is treated as missing. */
function optString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    throw new WsDecodeError(`${ctx}: field "${key}" must be a string`);
  }
  return v;
}

/** Optional integer with serde-style default 0 (plain i64 fields, not timestamps). */
function optInteger(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (v === undefined || v === null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  throw new WsDecodeError(`${ctx}: field "${key}" must be a JSON number`);
}

/**
 * Timestamp field: JSON number, quoted integer string, empty string (-> 0), or RFC3339
 * (-> Unix seconds). Mirrors the predict-rs `Timestamp` deserialize visitor.
 */
function optTimestamp(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new WsDecodeError(`${ctx}: invalid numeric timestamp in "${key}"`);
    }
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    if (v === "") return 0;
    if (/^-?\d+$/.test(v)) return Number(v);
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    throw new WsDecodeError(
      `${ctx}: invalid timestamp "${v}" in "${key}": not an integer or RFC3339 string`,
    );
  }
  throw new WsDecodeError(`${ctx}: field "${key}" is not a valid timestamp`);
}

function parseSideValue(v: unknown, ctx: string): Side {
  if (v === "BUY" || v === "SELL") return v;
  throw new WsDecodeError(`${ctx}: invalid side ${JSON.stringify(v)} (expected BUY or SELL)`);
}

/** Optional `Option<Side>` field: missing / null -> undefined. */
function optSide(obj: Record<string, unknown>, key: string, ctx: string): Side | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  return parseSideValue(v, ctx);
}

function optLevels(obj: Record<string, unknown>, key: string, ctx: string): OrderLevel[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new WsDecodeError(`${ctx}: field "${key}" must be an array`);
  }
  return v.map((entry, i) => {
    if (!isRecord(entry)) {
      throw new WsDecodeError(`${ctx}: "${key}"[${i}] is not an object`);
    }
    return {
      price: reqString(entry, "price", `${ctx} ${key}[${i}]`),
      size: reqString(entry, "size", `${ctx} ${key}[${i}]`),
    };
  });
}

function optStringArray(obj: Record<string, unknown>, key: string, ctx: string): string[] {
  return optionalStringArray(obj, key, ctx) ?? [];
}

/** `Option<Vec<String>>` semantics: missing / null -> undefined. */
function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new WsDecodeError(`${ctx}: field "${key}" must be an array`);
  }
  return v.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new WsDecodeError(`${ctx}: "${key}"[${i}] is not a string`);
    }
    return entry;
  });
}

// ─── per-event parsers ──────────────────────────────────────────────────────

function parseBookEvent(d: Record<string, unknown>): BookEvent {
  const ctx = "book event";
  return {
    asset_id: reqString(d, "asset_id", ctx),
    market: reqString(d, "market", ctx),
    bids: optLevels(d, "bids", ctx),
    asks: optLevels(d, "asks", ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
    hash: optString(d, "hash", ctx),
  };
}

function parsePriceChangeEvent(d: Record<string, unknown>): PriceChangeEvent {
  const ctx = "price_change event";
  const rawChanges = d.price_changes;
  let changes: PriceChangeEntry[] = [];
  if (rawChanges !== undefined && rawChanges !== null) {
    if (!Array.isArray(rawChanges)) {
      throw new WsDecodeError(`${ctx}: "price_changes" must be an array`);
    }
    changes = rawChanges.map((entry, i) => {
      if (!isRecord(entry)) {
        throw new WsDecodeError(`${ctx}: price_changes[${i}] is not an object`);
      }
      const ectx = `${ctx} price_changes[${i}]`;
      return {
        asset_id: reqString(entry, "asset_id", ectx),
        price: reqString(entry, "price", ectx),
        size: reqString(entry, "size", ectx),
        side: parseSideValue(entry.side, ectx),
        hash: optString(entry, "hash", ectx),
        best_bid: optString(entry, "best_bid", ectx),
        best_ask: optString(entry, "best_ask", ectx),
      };
    });
  }
  return {
    market: reqString(d, "market", ctx),
    price_changes: changes,
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseLastTradePriceEvent(d: Record<string, unknown>): LastTradePriceEvent {
  const ctx = "last_trade_price event";
  return {
    asset_id: reqString(d, "asset_id", ctx),
    market: reqString(d, "market", ctx),
    price: reqString(d, "price", ctx),
    size: reqString(d, "size", ctx),
    fee_rate_bps: optString(d, "fee_rate_bps", ctx),
    side: parseSideValue(d.side, ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
    transaction_hash: optString(d, "transaction_hash", ctx),
  };
}

function parseTickSizeChangeEvent(d: Record<string, unknown>): TickSizeChangeEvent {
  const ctx = "tick_size_change event";
  return {
    asset_id: reqString(d, "asset_id", ctx),
    market: reqString(d, "market", ctx),
    old_tick_size: reqString(d, "old_tick_size", ctx),
    new_tick_size: reqString(d, "new_tick_size", ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseBestBidAskEvent(d: Record<string, unknown>): BestBidAskEvent {
  const ctx = "best_bid_ask event";
  return {
    asset_id: reqString(d, "asset_id", ctx),
    market: reqString(d, "market", ctx),
    best_bid: reqString(d, "best_bid", ctx),
    best_ask: reqString(d, "best_ask", ctx),
    spread: optString(d, "spread", ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseNewMarketEvent(d: Record<string, unknown>): NewMarketEvent {
  const ctx = "new_market event";
  return {
    id: reqString(d, "id", ctx),
    question: reqString(d, "question", ctx),
    market: reqString(d, "market", ctx),
    slug: reqString(d, "slug", ctx),
    assets_ids: optStringArray(d, "assets_ids", ctx),
    outcomes: optStringArray(d, "outcomes", ctx),
    tags: optStringArray(d, "tags", ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseMarketResolvedEvent(d: Record<string, unknown>): MarketResolvedEvent {
  const ctx = "market_resolved event";
  return {
    id: reqString(d, "id", ctx),
    market: reqString(d, "market", ctx),
    assets_ids: optStringArray(d, "assets_ids", ctx),
    winning_asset_id: reqString(d, "winning_asset_id", ctx),
    winning_outcome: reqString(d, "winning_outcome", ctx),
    tags: optStringArray(d, "tags", ctx),
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseOrderEvent(d: Record<string, unknown>): OrderEvent {
  const ctx = "order event";
  const side = optSide(d, "side", ctx);
  const lazyRaw = d.lazy;
  let lazy: string | undefined;
  if (lazyRaw !== undefined && lazyRaw !== null) {
    if (typeof lazyRaw !== "string") {
      throw new WsDecodeError(`${ctx}: field "lazy" must be a string`);
    }
    lazy = lazyRaw;
  }
  const associateTrades = optionalStringArray(d, "associate_trades", ctx);
  return {
    id: reqString(d, "id", ctx),
    status: parseOrderStatus(reqString(d, "status", ctx)),
    asset_id: optString(d, "asset_id", ctx),
    ...(side !== undefined ? { side } : {}),
    price: optString(d, "price", ctx),
    original_size: optString(d, "original_size", ctx),
    order_type: optString(d, "type", ctx),
    ...(lazy !== undefined ? { lazy } : {}),
    size_matched: optString(d, "size_matched", ctx),
    owner: optString(d, "owner", ctx),
    market: optString(d, "market", ctx),
    outcome: optString(d, "outcome", ctx),
    maker_address: optString(d, "maker_address", ctx),
    expiration: optInteger(d, "expiration", ctx),
    created_at: optInteger(d, "created_at", ctx),
    ...(associateTrades !== undefined ? { associate_trades: associateTrades } : {}),
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

function parseMakerOrderFill(entry: unknown, ctx: string): MakerOrderFill {
  if (!isRecord(entry)) {
    throw new WsDecodeError(`${ctx}: maker_orders entry is not an object`);
  }
  return {
    order_id: reqString(entry, "order_id", ctx),
    owner: reqString(entry, "owner", ctx),
    maker_address: reqString(entry, "maker_address", ctx),
    matched_amount: reqString(entry, "matched_amount", ctx),
    price: reqString(entry, "price", ctx),
    fee_rate_bps: reqString(entry, "fee_rate_bps", ctx),
    asset_id: reqString(entry, "asset_id", ctx),
    outcome: reqString(entry, "outcome", ctx),
    side: parseSideValue(entry.side, ctx),
  };
}

function parseTradeEvent(d: Record<string, unknown>): TradeEvent {
  const ctx = "trade event";
  const side = optSide(d, "side", ctx);
  // `taker_order_id` with `order_id` accepted as an alias (predict-rs serde alias).
  const takerOrderId =
    d.taker_order_id !== undefined && d.taker_order_id !== null
      ? optString(d, "taker_order_id", ctx)
      : optString(d, "order_id", ctx);
  const traderSideRaw = d.trader_side;
  let traderSide: TraderSide | undefined;
  if (traderSideRaw !== undefined && traderSideRaw !== null) {
    if (traderSideRaw !== "TAKER" && traderSideRaw !== "MAKER") {
      throw new WsDecodeError(`${ctx}: invalid trader_side ${JSON.stringify(traderSideRaw)}`);
    }
    traderSide = traderSideRaw;
  }
  const makerOrdersRaw = d.maker_orders;
  let makerOrders: MakerOrderFill[] = [];
  if (makerOrdersRaw !== undefined && makerOrdersRaw !== null) {
    if (!Array.isArray(makerOrdersRaw)) {
      throw new WsDecodeError(`${ctx}: "maker_orders" must be an array`);
    }
    makerOrders = makerOrdersRaw.map((entry, i) =>
      parseMakerOrderFill(entry, `${ctx} maker_orders[${i}]`),
    );
  }
  const subTypeRaw = d.type;
  return {
    id: reqString(d, "id", ctx),
    status: parseTradeStatus(reqString(d, "status", ctx)),
    sub_type: subTypeRaw === undefined || subTypeRaw === null ? "TRADE" : optString(d, "type", ctx),
    taker_order_id: takerOrderId,
    market: optString(d, "market", ctx),
    asset_id: optString(d, "asset_id", ctx),
    ...(side !== undefined ? { side } : {}),
    size: optString(d, "size", ctx),
    price: optString(d, "price", ctx),
    fee_rate_bps: optString(d, "fee_rate_bps", ctx),
    match_type: optString(d, "match_type", ctx),
    outcome: optString(d, "outcome", ctx),
    owner: optString(d, "owner", ctx),
    maker_address: optString(d, "maker_address", ctx),
    transaction_hash: optString(d, "transaction_hash", ctx),
    bucket_index: optInteger(d, "bucket_index", ctx),
    matchtime: optInteger(d, "matchtime", ctx),
    last_update: optInteger(d, "last_update", ctx),
    ...(traderSide !== undefined ? { trader_side: traderSide } : {}),
    maker_orders: makerOrders,
    timestamp: optTimestamp(d, "timestamp", ctx),
  };
}

// ─── frame-level parsing ────────────────────────────────────────────────────

function frameEnvelope(
  value: unknown,
  channel: string,
): { eventType: string; data: Record<string, unknown> } {
  if (!isRecord(value)) {
    throw new WsDecodeError(`${channel} frame is not a JSON object`);
  }
  const eventType = value.event_type;
  if (typeof eventType !== "string") {
    throw new WsDecodeError(`${channel} frame missing string "event_type"`);
  }
  // The live server nests payloads inside `data: {...}` (top-level echo fields ignored).
  const data = value.data;
  if (!isRecord(data)) {
    throw new WsDecodeError(`${channel} frame "${eventType}" missing nested "data" object`);
  }
  return { eventType, data };
}

/** Parse a pre-decoded JSON value into a market event. Throws `WsDecodeError`. */
export function parseMarketEventValue(value: unknown): MarketEvent {
  const { eventType, data } = frameEnvelope(value, "market");
  switch (eventType) {
    case "book":
      return { eventType, data: parseBookEvent(data) };
    case "price_change":
      return { eventType, data: parsePriceChangeEvent(data) };
    case "last_trade_price":
      return { eventType, data: parseLastTradePriceEvent(data) };
    case "tick_size_change":
      return { eventType, data: parseTickSizeChangeEvent(data) };
    case "best_bid_ask":
      return { eventType, data: parseBestBidAskEvent(data) };
    case "new_market":
      return { eventType, data: parseNewMarketEvent(data) };
    case "market_resolved":
      return { eventType, data: parseMarketResolvedEvent(data) };
    default:
      throw new WsDecodeError(`unknown market event_type "${eventType}"`);
  }
}

/** Parse a pre-decoded JSON value into a user event. Throws `WsDecodeError`. */
export function parseUserEventValue(value: unknown): UserEvent {
  const { eventType, data } = frameEnvelope(value, "user");
  switch (eventType) {
    case "order":
      return { eventType, data: parseOrderEvent(data) };
    case "trade":
      return { eventType, data: parseTradeEvent(data) };
    default:
      throw new WsDecodeError(`unknown user event_type "${eventType}"`);
  }
}

function truncateRaw(s: string): string {
  return s.length <= 1024 ? s : `${s.slice(0, 1024)}…`;
}

/** Wrap any error as a `WsDecodeError` carrying the (truncated) raw frame text. */
export function withRawFrame(e: unknown, raw: string): WsDecodeError {
  const message = e instanceof Error ? e.message : String(e);
  return new WsDecodeError(`${message}; raw frame (truncated 1024B): ${truncateRaw(raw)}`, raw);
}

/** Parse a raw market-channel text frame. Throws `WsDecodeError` (with raw frame). */
export function parseMarketEvent(text: string): MarketEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw withRawFrame(e, text);
  }
  try {
    return parseMarketEventValue(value);
  } catch (e) {
    throw withRawFrame(e, text);
  }
}

/** Parse a raw user-channel text frame. Throws `WsDecodeError` (with raw frame). */
export function parseUserEvent(text: string): UserEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw withRawFrame(e, text);
  }
  try {
    return parseUserEventValue(value);
  } catch (e) {
    throw withRawFrame(e, text);
  }
}

/**
 * Detect the user-channel error envelope (`{"error":"authentication failed"}`,
 * sent by the server right before closing on a bad apiKey + passphrase).
 * Returns the error string, or undefined when the frame is not an error envelope.
 */
export function userErrorEnvelope(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return undefined;
}
