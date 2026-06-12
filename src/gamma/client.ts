/**
 * HTTP client for the Gamma API (market metadata + auth/JWT).
 *
 * Gamma is a separate REST service from CLOB; it lives at `gamma-api.<tenant>`
 * (e.g. `https://gamma-api.hermestrade.xyz`). All metadata endpoints are public.
 * The auth endpoints (`/auth/nonce` → EIP-712 LoginMessage → `/auth/login`) issue the
 * RS256 JWT used by the relayer and `POST /profiles`.
 *
 * Path / query / body shapes mirror predict-rs `gamma/client.rs` + `Client::jwt_login`
 * (verified against the live hermestrade.xyz deployment).
 */

import type { PredictSigner } from "../crypto/signer.js";
import { ValidationError } from "../errors.js";
import { HttpClient, type HttpRequestOptions } from "../http.js";
import { scopeIdFromHex } from "../types.js";
import type {
  Agreement,
  AgreementsResponse,
  Event,
  HealthResponse,
  ListEventsQuery,
  ListTagsQuery,
  LoginRequestBody,
  Market,
  MarketsInformationBody,
  NonceResponse,
  Profile,
  PublicInfo,
  PublicProfile,
  Tag,
  TokenLookup,
  TokenResponse,
  UpsertProfileRequest,
} from "./types.js";
import { marketClobTokenIds, parseJsonArrayString } from "./types.js";

type Query = NonNullable<HttpRequestOptions["query"]>;

function rfc3339(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/** Map the camelCase filter object onto the snake_case wire query keys. */
function eventsQuery(q: ListEventsQuery): Query {
  return {
    limit: q.limit,
    offset: q.offset,
    order: q.order,
    ascending: q.ascending,
    slug: q.slug,
    tag_id: q.tagId,
    active: q.active,
    closed: q.closed,
    archived: q.archived,
    featured: q.featured,
    start_date_min: rfc3339(q.startDateMin),
    start_date_max: rfc3339(q.startDateMax),
    end_date_min: rfc3339(q.endDateMin),
    end_date_max: rfc3339(q.endDateMax),
    created_at_min: rfc3339(q.createdAtMin),
    created_at_max: rfc3339(q.createdAtMax),
    volume_min: q.volumeMin,
    volume_max: q.volumeMax,
    liquidity_min: q.liquidityMin,
    liquidity_max: q.liquidityMax,
  };
}

export class GammaClient {
  private readonly http: HttpClient;

  constructor(baseUrl: string) {
    this.http = new HttpClient(baseUrl);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  // ─── system ────────────────────────────────────────────────────────────────

  /** `GET /health` — service liveness probe. */
  async health(): Promise<HealthResponse> {
    return (await this.http.get<HealthResponse>("/health")).data;
  }

  /** `GET /public-info` — tenant brand, chain config, and contract addresses. */
  async publicInfo(): Promise<PublicInfo> {
    return (await this.http.get<PublicInfo>("/public-info")).data;
  }

  /** `GET /agreements` — enabled agreements (unwraps the `{agreements: [...]}` envelope). */
  async agreements(): Promise<Agreement[]> {
    const res = await this.http.get<AgreementsResponse>("/agreements");
    return res.data.agreements ?? [];
  }

  // ─── events ────────────────────────────────────────────────────────────────

  /** `GET /events` — tenant-scoped event list with filtering and pagination. */
  async listEvents(query: ListEventsQuery = {}): Promise<Event[]> {
    return (await this.http.get<Event[]>("/events", { query: eventsQuery(query) })).data;
  }

  /** `GET /events/{id}` — event by numeric ID. */
  async getEvent(id: string): Promise<Event> {
    return (await this.http.get<Event>(`/events/${id}`)).data;
  }

  /** `GET /events/slug/{slug}` — event by slug. */
  async getEventBySlug(slug: string): Promise<Event> {
    return (await this.http.get<Event>(`/events/slug/${slug}`)).data;
  }

  /** `GET /events/{id}/tags` — tags attached to an event. */
  async eventTags(id: string): Promise<Tag[]> {
    return (await this.http.get<Tag[]>(`/events/${id}/tags`)).data;
  }

  // ─── markets ───────────────────────────────────────────────────────────────

  /** `GET /markets/{id}` — market by numeric ID. `includeTag` embeds the market's tags. */
  async getMarket(id: string, includeTag = false): Promise<Market> {
    const options: HttpRequestOptions = includeTag ? { query: { include_tag: "true" } } : {};
    return (await this.http.get<Market>(`/markets/${id}`, options)).data;
  }

  /** `GET /markets/slug/{slug}` — market by slug. */
  async getMarketBySlug(slug: string, includeTag = false): Promise<Market> {
    const options: HttpRequestOptions = includeTag ? { query: { include_tag: "true" } } : {};
    return (await this.http.get<Market>(`/markets/slug/${slug}`, options)).data;
  }

  /** `GET /markets/{id}/tags` — tags attached to a market. */
  async marketTags(id: string): Promise<Tag[]> {
    return (await this.http.get<Tag[]>(`/markets/${id}/tags`)).data;
  }

  /**
   * `POST /markets/information` — bulk-fetch markets by id / slug / clob token /
   * condition id / date range.
   */
  async marketsInformation(body: MarketsInformationBody): Promise<Market[]> {
    return (await this.http.post<Market[]>("/markets/information", { body })).data;
  }

  /**
   * Look up a single market by its on-chain condition id via
   * `POST /markets/information { conditionIds: [...] }`. Returns null when not found.
   */
  async getMarketByConditionId(conditionId: string): Promise<Market | null> {
    if (conditionId === "") {
      throw new ValidationError("empty condition id");
    }
    const markets = await this.marketsInformation({ conditionIds: [conditionId] });
    return markets[0] ?? null;
  }

  /**
   * Batch-fetch markets by numeric market id via `POST /markets/information { id: [...] }`.
   * The upstream id filter is a number array, so every id must be numeric.
   * Return order is server-defined.
   */
  async getMarketsByIds(marketIds: Array<string | number>): Promise<Market[]> {
    if (marketIds.length === 0) return [];
    const ids = marketIds.map((raw) => {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isSafeInteger(n)) {
        throw new ValidationError(`market id "${raw}" is not numeric`);
      }
      return n;
    });
    return this.marketsInformation({ id: ids });
  }

  /**
   * Reverse-lookup the market owning an outcome token via
   * `POST /markets/information { clobTokenIds: [...] }` and derive the outcome index
   * ([0]=YES, [1]=NO). Returns null when no market carries the token.
   */
  async getToken(tokenId: string): Promise<TokenLookup | null> {
    if (tokenId === "") {
      throw new ValidationError("empty token id");
    }
    const markets = await this.marketsInformation({ clobTokenIds: [tokenId] });
    for (const market of markets) {
      const tokenIds = marketClobTokenIds(market);
      const outcomeIndex = tokenIds.indexOf(tokenId);
      if (outcomeIndex >= 0) {
        const upstream = parseJsonArrayString(market.upstreamTokenExtIds);
        return {
          tokenId,
          marketId: market.id,
          outcomeIndex,
          upstreamTokenExtId: upstream[outcomeIndex] ?? "",
          market,
        };
      }
    }
    return null;
  }

  // ─── tags ──────────────────────────────────────────────────────────────────

  /** `GET /tags` — tenant-scoped tag list. */
  async listTags(query: ListTagsQuery = {}): Promise<Tag[]> {
    const wire: Query = {
      limit: query.limit,
      offset: query.offset,
      order: query.order,
      ascending: query.ascending,
      is_carousel: query.isCarousel,
    };
    return (await this.http.get<Tag[]>("/tags", { query: wire })).data;
  }

  /** `GET /tags/{id}` — tag by numeric ID. */
  async getTag(id: string): Promise<Tag> {
    return (await this.http.get<Tag>(`/tags/${id}`)).data;
  }

  /** `GET /tags/slug/{slug}` — tag by slug. */
  async getTagBySlug(slug: string): Promise<Tag> {
    return (await this.http.get<Tag>(`/tags/slug/${slug}`)).data;
  }

  // ─── auth ──────────────────────────────────────────────────────────────────

  /**
   * `GET /auth/nonce?address=0x...` — one-time nonce plus the parameters needed to build
   * the EIP-712 LoginMessage. The address is lowercased on the wire.
   */
  async getNonce(address: string): Promise<NonceResponse> {
    return (
      await this.http.get<NonceResponse>("/auth/nonce", {
        query: { address: address.toLowerCase() },
      })
    ).data;
  }

  /** `POST /auth/login` — exchange a signed LoginMessage for an RS256 JWT. */
  async postLogin(body: LoginRequestBody): Promise<TokenResponse> {
    return (await this.http.post<TokenResponse>("/auth/login", { body })).data;
  }

  /**
   * Full JWT login flow (parity with predict-rs `Client::jwt_login`):
   * `GET /auth/nonce` → sign the EIP-712 LoginMessage → `POST /auth/login`.
   *
   * `domain` / `uri` are written into the EIP-712 message and recorded in the JWT; the
   * server only checks presence. Use the tenant root host for both, e.g.
   * `("hermestrade.xyz", "https://hermestrade.xyz")`. Returns the bare token string.
   */
  async login(signer: PredictSigner, domain: string, uri: string): Promise<TokenResponse> {
    const address = signer.address;
    const nonce = await this.getNonce(address);
    const signature = await signer.signLoginMessage({
      wallet: address,
      nonce: nonce.nonce,
      scopeId: scopeIdFromHex(nonce.scopeId),
      issuedAt: nonce.issuedAt,
      domain,
      uri,
      chainId: nonce.chainId,
    });
    return this.postLogin({
      signature,
      messageParams: {
        address,
        nonce: nonce.nonce,
        // Pass the nonce response's scopeId string through verbatim.
        scopeId: nonce.scopeId,
        issuedAt: nonce.issuedAt,
        domain,
        uri,
        chainId: nonce.chainId,
      },
    });
  }

  /**
   * `POST /auth/refresh` — validate the current JWT (Bearer header; no body) and issue a
   * new one with a reset expiry.
   */
  async refreshToken(token: string): Promise<TokenResponse> {
    return (
      await this.http.post<TokenResponse>("/auth/refresh", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).data;
  }

  // ─── profiles ──────────────────────────────────────────────────────────────

  /** `GET /profiles/user_address/{address}` — full profile by wallet address. */
  async getProfile(address: string): Promise<Profile> {
    return (await this.http.get<Profile>(`/profiles/user_address/${address}`)).data;
  }

  /** `GET /public-profile?address=...` — slim public profile (EOA or Safe address). */
  async getPublicProfile(address: string): Promise<PublicProfile> {
    return (await this.http.get<PublicProfile>("/public-profile", { query: { address } })).data;
  }

  /**
   * `POST /profiles` — upsert the caller's profile (JWT bearer auth). Omitted fields are
   * left unchanged. Returns the stored profile.
   */
  async updateProfile(token: string, body: UpsertProfileRequest): Promise<Profile> {
    return (
      await this.http.post<Profile>("/profiles", {
        headers: { authorization: `Bearer ${token}` },
        body,
      })
    ).data;
  }
}
