/**
 * HTTP client for the `data-service` (portfolio / trades / activity / leaderboards).
 *
 * Lives at `data-api.<tenant>`. Public read-only — no L1/L2 auth; tenant is inferred
 * from the HTTP `Host` header. Path / query / envelope shapes mirror predict-rs
 * `data/client.rs` (verified against the live hermestrade.xyz deployment):
 *
 * - `/positions`, `/closed-positions`, `/activity`, `/v1/market-positions` wrap the
 *   array in `{data: [...]}` (platform divergence from upstream V1); the client unwraps
 *   it transparently.
 * - `/trades`, `/holders`, `/oi`, `/live-volume`, `/unwrap-requests` return flat arrays.
 * - Wallet-scoped endpoints use `user=<addr>`, except `/user-pnl` which uses
 *   `user_address=<addr>`. Market-scoped endpoints use `market=<id>` (including
 *   `/v1/market-positions`, which takes `market=<conditionId>`).
 */

import { HttpClient } from "../http.js";
import type {
  Activity,
  ClosedPosition,
  DataTrade,
  HoldersBucket,
  LeaderboardQuery,
  LeaderboardResponse,
  LiveVolumeBucket,
  MarketPositionGroup,
  OpenInterestEntry,
  Position,
  PricesHistoryResponse,
  StatsResponse,
  TradedResponse,
  UnwrapRequest,
  UserPnlResponse,
} from "./types.js";

/** Generic `{data: [...]}` envelope used by several list endpoints. */
interface DataEnvelope<T> {
  data?: T[];
}

export class DataClient {
  private readonly http: HttpClient;

  constructor(baseUrl: string) {
    this.http = new HttpClient(baseUrl);
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  // ─── /positions ────────────────────────────────────────────────────────────

  /** `GET /positions` — open positions for a wallet (Safe / proxy wallet address). */
  async positions(address: string, limit: number, offset?: number): Promise<Position[]> {
    const res = await this.http.get<DataEnvelope<Position>>("/positions", {
      query: { user: address, limit, offset },
    });
    return res.data.data ?? [];
  }

  /** `GET /closed-positions` — closed positions for a wallet. */
  async closedPositions(
    address: string,
    limit: number,
    offset?: number,
  ): Promise<ClosedPosition[]> {
    const res = await this.http.get<DataEnvelope<ClosedPosition>>("/closed-positions", {
      query: { user: address, limit, offset },
    });
    return res.data.data ?? [];
  }

  /**
   * `GET /v1/market-positions` — leaderboard-style position list for one market, grouped
   * by outcome token. Live wire uses `market=<conditionId>`, not `conditionId=`.
   */
  async marketPositions(
    conditionId: string,
    limit: number,
    offset?: number,
  ): Promise<MarketPositionGroup[]> {
    const res = await this.http.get<DataEnvelope<MarketPositionGroup>>("/v1/market-positions", {
      query: { market: conditionId, limit, offset },
    });
    return res.data.data ?? [];
  }

  // ─── /trades ───────────────────────────────────────────────────────────────

  /** `GET /trades` — trade history for a wallet (flat array, no envelope). */
  async trades(address: string, limit: number, offset?: number): Promise<DataTrade[]> {
    const res = await this.http.get<DataTrade[]>("/trades", {
      query: { user: address, limit, offset },
    });
    return res.data;
  }

  // ─── /activity ─────────────────────────────────────────────────────────────

  /** `GET /activity` — on-chain activity (trades + splits + merges + redeems + rewards). */
  async activity(address: string, limit: number, offset?: number): Promise<Activity[]> {
    const res = await this.http.get<DataEnvelope<Activity>>("/activity", {
      query: { user: address, limit, offset },
    });
    return res.data.data ?? [];
  }

  // ─── /holders ──────────────────────────────────────────────────────────────

  /** `GET /holders` — top token holders for a market (one bucket per token). */
  async holders(market: string, limit?: number): Promise<HoldersBucket[]> {
    const res = await this.http.get<HoldersBucket[]>("/holders", {
      query: { market, limit },
    });
    return res.data;
  }

  // ─── /traded ───────────────────────────────────────────────────────────────

  /** `GET /traded` — count of unique markets traded by a wallet. */
  async traded(address: string): Promise<TradedResponse> {
    const res = await this.http.get<TradedResponse>("/traded", { query: { user: address } });
    return res.data;
  }

  // ─── /oi (open interest) ───────────────────────────────────────────────────

  /** `GET /oi` — open interest for one market (one entry per scope grouping). */
  async openInterest(market: string): Promise<OpenInterestEntry[]> {
    const res = await this.http.get<OpenInterestEntry[]>("/oi", { query: { market } });
    return res.data;
  }

  // ─── /live-volume ──────────────────────────────────────────────────────────

  /** `GET /live-volume` — live volume for an event (one bucket per parent / game). */
  async liveVolume(id: string): Promise<LiveVolumeBucket[]> {
    const res = await this.http.get<LiveVolumeBucket[]>("/live-volume", { query: { id } });
    return res.data;
  }

  // ─── /prices-history ───────────────────────────────────────────────────────

  /**
   * `GET /prices-history` — token price history. `interval` accepts the granularity
   * strings (`1m / 1h / 6h / 1d / max`); `fidelity` is the bucket resolution in seconds.
   */
  async pricesHistory(
    market: string,
    interval?: string,
    fidelity?: number,
  ): Promise<PricesHistoryResponse> {
    const res = await this.http.get<PricesHistoryResponse>("/prices-history", {
      query: { market, interval, fidelity },
    });
    return res.data;
  }

  // ─── /user-pnl ─────────────────────────────────────────────────────────────

  /**
   * `GET /user-pnl` — cumulative profit/loss time-series for a wallet.
   * `interval` accepts `1d / 1w / 1m / all`; `fidelity` accepts `1h / 3h / 12h / 18h / 1d`.
   * Live wire uses `user_address=` (divergence from the upstream `user=` param).
   */
  async userPnl(address: string, interval?: string, fidelity?: string): Promise<UserPnlResponse> {
    const res = await this.http.get<UserPnlResponse>("/user-pnl", {
      query: { user_address: address, interval, fidelity },
    });
    return res.data;
  }

  // ─── /stats ────────────────────────────────────────────────────────────────

  /** `GET /stats` — global platform statistics. */
  async stats(): Promise<StatsResponse> {
    return (await this.http.get<StatsResponse>("/stats")).data;
  }

  // ─── /v1/leaderboard ───────────────────────────────────────────────────────

  /** `GET /v1/leaderboard` — trader leaderboard with biggest-wins sidebar. */
  async leaderboard(query: LeaderboardQuery = {}): Promise<LeaderboardResponse> {
    const res = await this.http.get<LeaderboardResponse>("/v1/leaderboard", {
      query: {
        timePeriod: query.timePeriod,
        orderBy: query.orderBy,
        limit: query.limit,
        offset: query.offset,
      },
    });
    return res.data;
  }

  // ─── /unwrap-requests ──────────────────────────────────────────────────────

  /** `GET /unwrap-requests` — USDW unwrap queue for a Safe address. */
  async unwrapRequests(safe: string, claimed?: boolean): Promise<UnwrapRequest[]> {
    const res = await this.http.get<UnwrapRequest[]>("/unwrap-requests", {
      query: { safe, claimed },
    });
    return res.data;
  }
}
