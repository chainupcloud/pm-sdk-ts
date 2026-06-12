/**
 * Wire types for the `data-service` (portfolio / trades / activity / leaderboards).
 *
 * Field shapes mirror predict-rs `clob-client/src/data/types.rs`, which matches the
 * platform's `data-service/internal/handlers/` structs 1:1 — including platform
 * extensions (`questionTranslation` / `eventTitleTranslation` i18n fields, `fee` on
 * trades, the wrapped leaderboard envelope, `unwrap-requests`). JSON keys are camelCase.
 */

// ─── /positions ──────────────────────────────────────────────────────────────

/** Open position row returned by `GET /positions`. */
export interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  /** i18n extension — JSON-encoded `{"zh_CN":"...","en_US":"..."}`. */
  questionTranslation?: string;
  /** i18n extension. */
  eventTitleTranslation?: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
  /** `"negrisk" | "sports" | ""` — omitted when empty. */
  eventType?: string;
  negRiskMarketId?: string;
  negRiskTotalOptions?: number;
  gameId?: string;
}

/** Closed position row returned by `GET /closed-positions`. */
export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  eventType?: string;
  negRiskMarketId?: string;
  negRiskTotalOptions?: number;
  gameId?: string;
}

/** Per-trader position row inside a `MarketPositionGroup`. */
export interface MarketPositionEntry {
  proxyWallet: string;
  name: string;
  profileImage?: string;
  verified?: boolean;
  asset: string;
  conditionId: string;
  avgPrice: number;
  size: number;
  currPrice: number;
  currentValue: number;
  cashPnl: number;
  totalBought: number;
  realizedPnl: number;
  totalPnl: number;
  outcome: string;
  outcomeIndex: number;
}

/**
 * One token bucket returned by `GET /v1/market-positions` — token id, originating
 * condition id, and the per-trader position list.
 */
export interface MarketPositionGroup {
  token: string;
  conditionId: string;
  positions?: MarketPositionEntry[];
}

// ─── /trades ─────────────────────────────────────────────────────────────────

/** Trade row returned by `GET /trades`. */
export interface DataTrade {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  transactionHash: string;
  /** Platform extension — fee in USDW. Always present (non-omitempty). */
  fee: number;
  eventType?: string;
  negRiskMarketId?: string;
  gameId?: string;
}

// ─── /activity ───────────────────────────────────────────────────────────────

/** Activity row returned by `GET /activity`. */
export interface Activity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  negRiskMarketId?: string;
  /** `TRADE | SPLIT | MERGE | REDEEM | REWARD | CONVERSION`. */
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  questionTranslation?: string;
  eventTitleTranslation?: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
}

// ─── /holders ────────────────────────────────────────────────────────────────

/** Token-holder entry inside a `HoldersBucket`. */
export interface Holder {
  proxyWallet: string;
  asset: string;
  amount: number;
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  profileImageOptimized?: string;
  displayUsernamePublic?: boolean;
}

/** One bucket inside the array returned by `GET /holders` (one bucket per token). */
export interface HoldersBucket {
  token: string;
  holders?: Holder[];
}

// ─── /traded ─────────────────────────────────────────────────────────────────

/** `GET /traded` response — `{"traded": <int>, "user": "<addr>"}`. */
export interface TradedResponse {
  traded: number;
  user?: string;
}

// ─── /oi (open interest) ─────────────────────────────────────────────────────

/** Single row in the array returned by `GET /oi`. */
export interface OpenInterestEntry {
  market: string;
  value: number;
  /** Grouping level of `market`: `"condition" | "negRiskParent" | "sportsEvent"` etc. */
  scope?: string;
}

// ─── /live-volume ────────────────────────────────────────────────────────────

/** Single market entry inside a `LiveVolumeBucket`. */
export interface LiveVolumeMarket {
  market: string;
  value: number;
}

/**
 * One bucket inside the array returned by `GET /live-volume`. neg-risk events yield one
 * bucket per parent; sports events yield one per game.
 */
export interface LiveVolumeBucket {
  total: number;
  negRiskMarketId?: string;
  gameId?: string;
  markets?: LiveVolumeMarket[];
}

// ─── /prices-history ─────────────────────────────────────────────────────────

/** Single price point — `t` is a Unix timestamp in seconds, `p` the mid-price. */
export interface PricePoint {
  t: number;
  p: number;
}

/** `GET /prices-history` response. */
export interface PricesHistoryResponse {
  history?: PricePoint[];
}

// ─── /user-pnl ───────────────────────────────────────────────────────────────

/** Single PNL point — `t` is a Unix timestamp in seconds, `p` cumulative PnL in USDC. */
export interface PnlPoint {
  t: number;
  p: number;
}

/** `GET /user-pnl` response — a flat array of points. */
export type UserPnlResponse = PnlPoint[];

// ─── /stats ──────────────────────────────────────────────────────────────────

/** `GET /stats` response — global platform statistics. */
export interface StatsResponse {
  totalVolume: number;
  volume24h: number;
  totalTrades: number;
  trades24h: number;
  activeMarkets: number;
  openInterest: number;
}

// ─── /v1/leaderboard ─────────────────────────────────────────────────────────

/** Single row in `LeaderboardResponse.data`. Note: `rank` is a string on the wire. */
export interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  profileImage: string;
  xUsername: string;
  verifiedBadge: boolean;
  pnl: number;
  vol: number;
}

/** Single row in `LeaderboardResponse.biggestWins`. */
export interface BiggestWinEntry {
  username: string;
  avatar: string;
  address: string;
  title: string;
  slug: string;
  eventSlug: string;
  entryValue: number;
  exitValue: number;
  profit: number;
}

/**
 * Wrapped envelope returned by `GET /v1/leaderboard` — `biggestWins` is bundled into the
 * same response (platform divergence from upstream V1, saves a second RTT).
 */
export interface LeaderboardResponse {
  data?: LeaderboardEntry[];
  biggestWins?: BiggestWinEntry[];
  errors?: string[];
}

/** `GET /v1/leaderboard` query options. Wire keys: `timePeriod`, `orderBy`, `limit`, `offset`. */
export interface LeaderboardQuery {
  /** `DAY | WEEK | MONTH | ALL` (case-insensitive on the server; default `DAY`). */
  timePeriod?: string;
  /** `PNL | VOL` (default `PNL`). */
  orderBy?: string;
  limit?: number;
  offset?: number;
}

// ─── /unwrap-requests ────────────────────────────────────────────────────────

/** USDW unwrap-request row (`GET /unwrap-requests`). No upstream V1 equivalent. */
export interface UnwrapRequest {
  id: string;
  requestId: string;
  recipient: string;
  asset: string;
  usdwAmount: string;
  assetAmount: string;
  claimableAt: string;
  claimed: boolean;
  initTxHash: string;
  initTimestamp: string;
  claimTxHash?: string;
  claimTimestamp?: string;
  actualRecipient?: string;
}
