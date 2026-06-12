/**
 * Wire types for the Gamma API (market metadata + auth/JWT).
 *
 * Field names mirror predict-rs `clob-client/src/gamma/types/response.rs` (which itself
 * mirrors the platform's `gamma-service/internal/models/models.go` byte-for-byte):
 * - JSON keys are camelCase, with off-pattern exceptions kept verbatim
 *   (`tagID`, `relatedTagID`, `relID`, `event_count` on the search tag shape).
 * - Required string IDs are non-optional; almost everything else is nullable on the
 *   wire (Go pointers), surfaced as optional fields here.
 * - `clobTokenIds`, `outcomes`, `outcomePrices`, `upstreamTokenExtIds` are JSON-array
 *   *strings* (e.g. `"[\"123\",\"456\"]"`), not arrays — use `parseJsonArrayString`.
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a gamma JSON-array-string field (e.g. `"[\"123\",\"456\"]"`) into a string
 * array. Returns [] when missing, empty, or unparseable (parity with predict-rs
 * `Market::parsed_clob_token_ids` / pm-sdk-go `parseJSONStringArray`).
 */
export function parseJsonArrayString(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const out: unknown = JSON.parse(raw);
    return Array.isArray(out) ? out.map(String) : [];
  } catch {
    return [];
  }
}

// ─── tags ────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string;
  label?: string | null;
  labelTranslation?: string | null;
  slug?: string | null;
  isCarousel?: boolean | null;
  tagType?: string | null;
  publishedAt?: string | null;
  createdBy?: number | null;
  updatedBy?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Relationship row from `/tags/{id}/related-tags`. Note the off-pattern key casing. */
export interface RelatedTag {
  id: string;
  tagID?: number | null;
  relatedTagID?: number | null;
  rank?: number | null;
}

// ─── adjudication (UMA oracle lifecycle) ─────────────────────────────────────

export interface NextStep {
  action: string;
  deadline?: string | null;
  description: string;
}

export interface Adjudication {
  status: string;
  currentPhase: string;
  nextSteps?: NextStep[];
  proposedOutcome?: string | null;
  proposedAt?: string | null;
  proposer?: string | null;
  proposeDeadline?: string | null;
  livenessSecs?: number;
  livenessDeadline?: string | null;
  challenger?: string | null;
  challengedAt?: string | null;
  arbitrator?: string | null;
  arbitratedAt?: string | null;
  arbitrationCorrect?: number | null;
  settledOutcome?: string | null;
  resolvedAt?: string | null;
  payoutVector?: string | null;
  canceledAt?: string | null;
  requestedAt?: string | null;
  resetCount?: number;
  questionId?: string;
  adapterAddress?: string;
}

// ─── markets ─────────────────────────────────────────────────────────────────

/**
 * A single binary prediction market (`gamma-service` `models.Market`).
 *
 * `clobTokenIds` / `outcomes` / `outcomePrices` / `upstreamTokenExtIds` are JSON-array
 * strings; in a binary market index 0 is the YES token and index 1 the NO token.
 */
export interface Market {
  id: string;
  question?: string | null;
  questionTranslation?: string | null;
  conditionId: string;
  slug?: string | null;
  resolutionSource?: string | null;
  endDate?: string | null;
  startDate?: string | null;
  category?: string | null;
  /** Decimal string on the wire (unlike `Event.liquidity`, which is a number). */
  liquidity?: string | null;
  image?: string | null;
  icon?: string | null;
  description?: string | null;
  /** JSON-array string, e.g. `"[\"Yes\",\"No\"]"`. */
  outcomes?: string | null;
  outcomeTranslation?: string | null;
  /** JSON-array string of decimal strings. */
  outcomePrices?: string | null;
  /** Decimal string on the wire. */
  volume?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  marketMakerAddress?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  featured?: boolean | null;
  archived?: boolean | null;
  restricted?: boolean | null;
  enableOrderBook?: boolean | null;
  orderPriceMinTickSize?: number | null;
  orderMinSize?: number | null;
  orderMaxSize?: number | null;
  volume24hr?: number | null;
  /** JSON-array string, e.g. `"[\"123\",\"456\"]"` — [0]=YES, [1]=NO. */
  clobTokenIds?: string | null;
  acceptingOrders?: boolean | null;
  lastTradePrice?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  oneDayPriceChange?: number | null;
  tags?: Tag[];
  adjudication?: Adjudication | null;
  eventSlug?: string | null;
  negRiskAugmented?: boolean | null;
  groupItemTitle?: string | null;
  groupItemThreshold?: number | null;
  sportPlayType?: string | null;
  adapterInstance?: string | null;
  /** Parent event id (platform extension; exposed since gamma-service P1.3.0). */
  eventId?: string;
  /** Upstream provenance: `"polymarket"` / `"kalshi"` / ... (platform extension). */
  upstreamType?: string;
  /** Upstream market identifier (Polymarket: condition_id). */
  upstreamMarketExtId?: string;
  /** Upstream event identifier (Polymarket: gamma event slug or id). */
  upstreamEventExtId?: string;
  /** JSON-array string parallel to `clobTokenIds` / `outcomes`. */
  upstreamTokenExtIds?: string | null;
}

/** Parse `Market.clobTokenIds`. `[0]` is the YES token id, `[1]` the NO token id. */
export function marketClobTokenIds(market: Pick<Market, "clobTokenIds">): string[] {
  return parseJsonArrayString(market.clobTokenIds);
}

/** Token lookup result derived from `POST /markets/information { clobTokenIds: [...] }`. */
export interface TokenLookup {
  tokenId: string;
  marketId: string;
  /** 0 = YES, 1 = NO. */
  outcomeIndex: number;
  /** Upstream token identifier at the same outcome index, if exposed. */
  upstreamTokenExtId: string;
  market: Market;
}

// ─── events / series ─────────────────────────────────────────────────────────

export interface Category {
  id: string;
  label?: string | null;
  parentCategory?: string | null;
  slug?: string | null;
  publishedAt?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Chat {
  id: string;
  channelId?: string | null;
  channelName?: string | null;
  channelImage?: string | null;
  live?: boolean | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface Series {
  id: string;
  ticker?: string | null;
  slug?: string | null;
  title?: string | null;
  subtitle?: string | null;
  seriesType?: string | null;
  recurrence?: string | null;
  description?: string | null;
  image?: string | null;
  icon?: string | null;
  layout?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  featured?: boolean | null;
  volume24hr?: number | null;
  volume?: number | null;
  liquidity?: number | null;
  startDate?: string | null;
  commentCount?: number | null;
  events?: Event[];
  categories?: Category[];
  tags?: Tag[];
  chats?: Chat[];
}

/** A prediction-market event (`gamma-service` `models.Event`). */
export interface Event {
  id: string;
  ticker?: string | null;
  slug?: string | null;
  title?: string | null;
  titleTranslation?: string | null;
  description?: string | null;
  resolutionSource?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  creationDate?: string | null;
  image?: string | null;
  icon?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  archived?: boolean | null;
  new?: boolean | null;
  featured?: boolean | null;
  restricted?: boolean | null;
  liquidity?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  category?: string | null;
  volume24hr?: number | null;
  /** Negative-risk flag lives on the Event (markets carry `negRiskAugmented`). */
  negRisk?: boolean | null;
  eventType?: string | null;
  commentCount?: number | null;
  markets?: Market[];
  series?: Series[];
  tags?: Tag[];
  numMarkets?: number | null;
}

// ─── profiles ────────────────────────────────────────────────────────────────

export interface ImageOptimization {
  id?: string | null;
  imageUrlSource?: string | null;
  imageUrlOptimized?: string | null;
  imageSizeKbSource?: number | null;
  imageSizeKbOptimized?: number | null;
  imageOptimizedComplete?: boolean | null;
  imageOptimizedLastUpdated?: string | null;
  relID?: number | null;
  field?: string | null;
  relname?: string | null;
}

export interface PublicProfileUser {
  id: string;
  creator?: boolean;
  mod?: boolean;
}

/** `GET /public-profile?address=...` response. */
export interface PublicProfile {
  createdAt?: string | null;
  eoaAddress?: string | null;
  /** Safe wallet address; null until the Safe is deployed (no EOA fallback). */
  proxyWallet?: string | null;
  profileImage?: string | null;
  displayUsernamePublic?: boolean | null;
  bio?: string | null;
  pseudonym?: string | null;
  name?: string | null;
  users?: PublicProfileUser[];
  xUsername?: string | null;
  verifiedBadge?: boolean | null;
}

/** Full profile (`GET /profiles/user_address/{address}` and `POST /profiles` response). */
export interface Profile {
  id: string;
  name?: string | null;
  pseudonym?: string | null;
  displayUsernamePublic?: boolean | null;
  bio?: string | null;
  eoaAddress?: string | null;
  proxyWallet?: string | null;
  profileImage?: string | null;
  profileImageOptimized?: ImageOptimization | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * `POST /profiles` body. All fields optional; omitted/null fields are left unchanged.
 * `proxyWallet` is only written while the stored safe_address is NULL.
 */
export interface UpsertProfileRequest {
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  displayUsernamePublic?: boolean;
  proxyWallet?: string;
  xUsername?: string;
}

// ─── public info / agreements / health ───────────────────────────────────────

export interface PublicInfoBrand {
  title?: string;
  logo?: string;
  titleTranslation?: string;
  subtitleTranslation?: string;
  footerConfig?: string;
}

export interface PublicInfoContracts {
  exchangeAddress?: string;
  negRiskExchangeAddress?: string;
  ctfAddress?: string;
  collateralToken?: string;
}

export interface PublicInfoApp {
  termsUrl?: string;
}

export interface Agreement {
  type?: string;
  titleTranslation?: string;
  version?: string;
  contentTranslation?: string;
  externalUrl?: string;
  required?: boolean;
  sortOrder?: number;
}

/**
 * `GET /public-info` response. `chain` is left untyped because the server returns either
 * `{ chainId: N }` or a fully enriched chain object depending on kv_config state.
 */
export interface PublicInfo {
  brand: PublicInfoBrand;
  chain?: unknown;
  contracts: PublicInfoContracts;
  app?: PublicInfoApp | null;
  loginStatement?: string;
  walletConnectProjectId?: string;
  agreements?: Agreement[];
}

/** `GET /agreements` envelope. */
export interface AgreementsResponse {
  agreements?: Agreement[];
}

/** `GET /health` response (millisecond timestamp). */
export interface HealthResponse {
  service?: string;
  status?: string;
  timestamp?: number;
}

// ─── auth (nonce / login / refresh) ──────────────────────────────────────────

/** `GET /auth/nonce?address=0x...` response. `scopeId` is a hex string. */
export interface NonceResponse {
  nonce: string;
  scopeId: string;
  issuedAt: string;
  chainId: number;
  /** Welcome text shown in the wallet popup. */
  statement?: string;
}

/**
 * `messageParams` block of the `POST /auth/login` body. `scopeId` carries the raw
 * string from the nonce response verbatim; `chainId` is a JSON number.
 */
export interface LoginMessageParamsWire {
  address: string;
  nonce: string;
  scopeId: string;
  issuedAt: string;
  domain: string;
  uri: string;
  chainId: number;
}

/** `POST /auth/login` body. `signature` is the 0x-hex EIP-712 LoginMessage signature. */
export interface LoginRequestBody {
  signature: string;
  messageParams: LoginMessageParamsWire;
}

/** `POST /auth/login` / `POST /auth/refresh` response — bare JWT, no `Bearer ` prefix. */
export interface TokenResponse {
  token: string;
}

// ─── request / query types ───────────────────────────────────────────────────

/**
 * `GET /events` filters. Wire query keys are snake_case (`tag_id`, `start_date_min`, ...);
 * omitted fields are not sent (server defaults: `limit=20`, `offset=0`).
 */
export interface ListEventsQuery {
  limit?: number;
  offset?: number;
  /** Sort field — one of: `id`, `label`, `slug`, `created_at`, `updated_at`. */
  order?: string;
  ascending?: boolean;
  slug?: string;
  tagId?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  featured?: boolean;
  /** RFC 3339 timestamp or Date. */
  startDateMin?: string | Date;
  startDateMax?: string | Date;
  endDateMin?: string | Date;
  endDateMax?: string | Date;
  createdAtMin?: string | Date;
  createdAtMax?: string | Date;
  volumeMin?: number;
  volumeMax?: number;
  liquidityMin?: number;
  liquidityMax?: number;
}

/** `GET /tags` filters. Wire query keys: `limit`, `offset`, `order`, `ascending`, `is_carousel`. */
export interface ListTagsQuery {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  isCarousel?: boolean;
}

/**
 * `POST /markets/information` body (`gamma-service` `MarketsInformationBody`).
 * All filters are optional; key names go on the wire as-is (camelCase).
 */
export interface MarketsInformationBody {
  id?: number[];
  slug?: string[];
  closed?: boolean;
  clobTokenIds?: string[];
  conditionIds?: string[];
  marketMakerAddress?: string[];
  liquidityNumMin?: number;
  liquidityNumMax?: number;
  volumeNumMin?: number;
  volumeNumMax?: number;
  startDateMin?: string;
  startDateMax?: string;
  endDateMin?: string;
  endDateMax?: string;
  relatedTags?: boolean;
  tagId?: number;
  cyom?: boolean;
  umaResolutionStatus?: string;
  gameId?: string;
  sportsMarketTypes?: string[];
  rewardsMinSize?: number;
  questionIds?: string[];
  includeTags?: boolean;
}
