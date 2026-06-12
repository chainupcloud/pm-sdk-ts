/**
 * `PredictWsClient` — WebSocket client for the CLOB `/ws/market` and `/ws/user` channels.
 *
 * Behaviour parity:
 * - predict-rs `ws/{config,connection}.rs` + `clob/ws/{client,subscription}.rs`:
 *   text-frame `"PING"` heartbeat every 10 s with inbound `"PONG"` discarded, exponential
 *   reconnect backoff (1 s doubling to a 30 s cap), resubscribe-on-reconnect, terminal
 *   auth errors (HTTP upgrade rejection / in-band `{"error": ...}` envelope) never
 *   swallowed by the reconnect loop, non-terminal decode errors surfaced as stream items.
 * - pm-sdk-go `pkg/ws/client.go`: 0-500 ms reconnect jitter, and the market-channel
 *   sequence guard — a RESET item is emitted (and local caches must be rebuilt) after
 *   every reconnect and whenever a frame's timestamp regresses or an identical
 *   (timestamp, hash) frame repeats; the offending frame is dropped.
 *   predict-rs has no seq guard (it emits connection-level `Reconnecting` instead);
 *   we follow pm-sdk-go here, surfacing both `reset` and `reconnecting` items.
 */

import WebSocket, { type RawData } from "ws";
import { ValidationError } from "../errors.js";
import type { ApiCredentials } from "../types.js";
import {
  type MarketEvent,
  type MarketLevel,
  type MarketSubscribeMessage,
  type MarketUpdateMessage,
  parseMarketEvent,
  parseUserEventValue,
  type UserEvent,
  type UserSubscribeMessage,
  type UserUpdateMessage,
  userErrorEnvelope,
  WsAuthError,
  type WsUserAuth,
  withRawFrame,
} from "./types.js";

// ─── options ────────────────────────────────────────────────────────────────

export interface PredictWsOptions {
  /** Text-frame `"PING"` heartbeat interval. 0 disables. Default 10000 (server pongWait is 15 s). */
  pingIntervalMs?: number;
  /** First reconnect delay. Default 1000. */
  initialBackoffMs?: number;
  /** Reconnect delay cap. Default 30000. */
  maxBackoffMs?: number;
  /** Upper bound of the random jitter added to every reconnect delay. Default 500. */
  jitterMs?: number;
  /** Per-attempt dial timeout. Default 10000. */
  connectTimeoutMs?: number;
}

interface ResolvedWsOptions {
  pingIntervalMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  jitterMs: number;
  connectTimeoutMs: number;
}

const DEFAULT_WS_OPTIONS: ResolvedWsOptions = {
  pingIntervalMs: 10_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  jitterMs: 500,
  connectTimeoutMs: 10_000,
};

// ─── stream items ───────────────────────────────────────────────────────────

/**
 * One item on a subscription stream.
 *
 * - `event` — a decoded wire event.
 * - `reset` — market channel only: emitted after a reconnect or a sequence anomaly;
 *   consumers must discard cached book state and wait for the next snapshot.
 * - `reconnecting` — the connection dropped; the next dial happens after `delayMs`.
 * - `error` — `fatal: false` for frame decode failures (stream continues),
 *   `fatal: true` for auth failures (always the last item before the stream ends).
 */
export type WsStreamItem<E> =
  | { kind: "event"; event: E }
  | { kind: "reset" }
  | { kind: "reconnecting"; attempt: number; delayMs: number }
  | { kind: "error"; error: Error; fatal: boolean };

export type MarketStreamItem = WsStreamItem<MarketEvent>;
export type UserStreamItem = WsStreamItem<UserEvent>;

// ─── async queue (single consumer) ──────────────────────────────────────────

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const head = this.items.shift();
        if (head !== undefined) {
          return Promise.resolve({ value: head, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

// ─── sequence guard (port of pm-sdk-go seqGuard) ────────────────────────────

/**
 * Nonce / sequence guard for the market channel:
 * - rejects frames whose sequence (timestamp) strictly regresses,
 * - rejects exact (sequence, hash) duplicates,
 * - allows equal sequence with a different hash (multiple events per timestamp).
 * A rejection triggers a RESET item and clears the guard.
 */
class SeqGuard {
  private lastSeq = 0;
  private lastHash = "";

  accept(seq: number, hash: string): boolean {
    if (seq === 0 && hash === "") return true;
    if (this.lastSeq === 0 && this.lastHash === "") {
      this.lastSeq = seq;
      this.lastHash = hash;
      return true;
    }
    if (seq < this.lastSeq) return false;
    if (seq === this.lastSeq && hash === this.lastHash) return false;
    this.lastSeq = seq;
    this.lastHash = hash;
    return true;
  }

  reset(): void {
    this.lastSeq = 0;
    this.lastHash = "";
  }
}

/**
 * Derive (sequence, dedupe-hash) from a market event, mirroring pm-sdk-go `frameHash`.
 * Only `book` and `price_change` participate; other events bypass the guard.
 */
function frameSeqHash(event: MarketEvent): { seq: number; hash: string } {
  switch (event.eventType) {
    case "book": {
      const d = event.data;
      let hash = `${d.timestamp}|${d.asset_id}|book`;
      for (const level of d.bids) hash += `|b${level.price}:${level.size}`;
      for (const level of d.asks) hash += `|a${level.price}:${level.size}`;
      return { seq: d.timestamp, hash };
    }
    case "price_change": {
      const d = event.data;
      let hash = `${d.timestamp}|${d.market}|price_change`;
      for (const change of d.price_changes) {
        hash += `|${change.asset_id}:${change.side}:${change.price}:${change.size}`;
      }
      return { seq: d.timestamp, hash };
    }
    default:
      return { seq: 0, hash: "" };
  }
}

// ─── base subscription ──────────────────────────────────────────────────────

abstract class WsSubscription<E> implements AsyncIterable<WsStreamItem<E>> {
  private readonly queue = new AsyncQueue<WsStreamItem<E>>();
  private readonly onItem: ((item: WsStreamItem<E>) => void) | undefined;
  private ws: WebSocket | undefined;
  private started = false;
  private closed = false;
  private fatal = false;
  private everConnected = false;
  private attempt = 0;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  protected constructor(
    private readonly url: string,
    protected readonly cfg: ResolvedWsOptions,
    onItem?: (item: WsStreamItem<E>) => void,
  ) {
    this.backoffMs = cfg.initialBackoffMs;
    this.onItem = onItem;
  }

  /** Serialized subscribe envelope, re-sent on every (re)connect. */
  protected abstract buildSubscribeFrame(): string;
  /** Handle one inbound text frame (PONG keep-alives are already filtered out). */
  protected abstract handleText(text: string): void;
  /** Hook invoked after a successful RE-connect (not the first connect). */
  protected abstract handleReconnected(): void;

  /**
   * Begin the connect / reconnect loop. Invoked by `PredictWsClient`; idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Close the connection, stop reconnecting, and end the stream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "client close");
      } else {
        ws.terminate();
      }
    }
    this.queue.close();
  }

  /** Single-consumer stream of items. Empty when an `onItem` callback was supplied. */
  [Symbol.asyncIterator](): AsyncIterator<WsStreamItem<E>> {
    return this.queue[Symbol.asyncIterator]();
  }

  protected emit(item: WsStreamItem<E>): void {
    if (this.onItem) {
      this.onItem(item);
      return;
    }
    this.queue.push(item);
  }

  /** Terminal failure: emit the fatal error item, stop reconnecting, end the stream. */
  protected fail(error: Error): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.emit({ kind: "error", error, fatal: true });
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "client close");
      // The 'close' handler closes the queue (fatal flag is set).
    } else {
      this.clearTimers();
      if (ws) ws.terminate();
      this.ws = undefined;
      this.queue.close();
    }
  }

  /** Send a runtime control frame if the socket is open; otherwise rely on resubscribe. */
  protected sendIfOpen(payload: string): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }

  private connect(): void {
    if (this.closed || this.fatal) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      ws.terminate();
    }, this.cfg.connectTimeoutMs);

    ws.on("open", () => {
      this.clearConnectTimer();
      this.attempt = 0;
      this.backoffMs = this.cfg.initialBackoffMs;
      if (this.everConnected) this.handleReconnected();
      this.everConnected = true;
      ws.send(this.buildSubscribeFrame());
      this.startPing(ws);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // the server never emits binary frames
      const text = rawDataToText(data);
      if (text === "PONG") return; // heartbeat reply, never surfaced
      this.handleText(text);
    });

    // The server rejected the HTTP upgrade (e.g. 401/403 on /ws/user). Like
    // predict-rs WsError::Auth this is terminal — never retried.
    ws.on("unexpected-response", (req, res) => {
      this.clearConnectTimer();
      const status = res.statusCode ?? 0;
      this.fatal = true;
      this.emit({
        kind: "error",
        error: new WsAuthError(status, `websocket upgrade rejected with HTTP ${status}`),
        fatal: true,
      });
      res.resume();
      req.destroy();
      this.clearTimers();
      this.ws = undefined;
      this.queue.close();
    });

    ws.on("error", () => {
      // Swallow: the 'close' event always follows and drives reconnection.
    });

    ws.on("close", () => {
      this.clearConnectTimer();
      this.stopPing();
      this.ws = undefined;
      if (this.closed || this.fatal) {
        this.queue.close();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const jitter = this.cfg.jitterMs > 0 ? Math.floor(Math.random() * this.cfg.jitterMs) : 0;
    const delayMs = this.backoffMs + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.maxBackoffMs);
    this.emit({ kind: "reconnecting", attempt: this.attempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private startPing(ws: WebSocket): void {
    if (this.cfg.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("PING"); // text frame, not the protocol-level ping opcode
      }
    }, this.cfg.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    this.clearConnectTimer();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

// ─── market subscription ────────────────────────────────────────────────────

export interface MarketSubscribeOptions {
  /** Skip the per-asset `book` snapshot dump after subscribe when false. Default true. */
  initialDump?: boolean;
  /** Order-book depth level; omitted from the wire when unset (server defaults to 2). */
  level?: MarketLevel;
  /** Opt in to `best_bid_ask` / `new_market` / `market_resolved` events. */
  customFeatureEnabled?: boolean;
  /** Callback delivery; when set, the async iterator stays empty. */
  onItem?: (item: MarketStreamItem) => void;
}

export class MarketSubscription extends WsSubscription<MarketEvent> {
  private assetIds: string[];
  private readonly initialDump: boolean;
  private readonly level: MarketLevel | undefined;
  private readonly customFeatureEnabled: boolean | undefined;
  private readonly guard = new SeqGuard();

  constructor(
    url: string,
    cfg: ResolvedWsOptions,
    assetIds: string[],
    options: MarketSubscribeOptions = {},
  ) {
    super(url, cfg, options.onItem);
    this.assetIds = [...assetIds];
    this.initialDump = options.initialDump ?? true;
    this.level = options.level;
    this.customFeatureEnabled = options.customFeatureEnabled;
  }

  protected buildSubscribeFrame(): string {
    const msg: MarketSubscribeMessage = {
      assets_ids: [...this.assetIds],
      type: "market",
      initial_dump: this.initialDump,
      ...(this.level !== undefined ? { level: this.level } : {}),
      ...(this.customFeatureEnabled !== undefined
        ? { custom_feature_enabled: this.customFeatureEnabled }
        : {}),
    };
    return JSON.stringify(msg);
  }

  protected handleText(text: string): void {
    let event: MarketEvent;
    try {
      event = parseMarketEvent(text);
    } catch (e) {
      this.emit({ kind: "error", error: e as Error, fatal: false });
      return;
    }
    const { seq, hash } = frameSeqHash(event);
    if (!this.guard.accept(seq, hash)) {
      // Timestamp regress or duplicate hash: drop the frame, tell consumers to rebuild.
      this.guard.reset();
      this.emit({ kind: "reset" });
      return;
    }
    this.emit({ kind: "event", event });
  }

  protected handleReconnected(): void {
    this.guard.reset();
    this.emit({ kind: "reset" });
  }

  /** Add asset ids to the live subscription (and to the resubscribe-on-reconnect set). */
  subscribe(assetIds: string[]): void {
    for (const id of assetIds) {
      if (!this.assetIds.includes(id)) this.assetIds.push(id);
    }
    const msg: MarketUpdateMessage = {
      operation: "subscribe",
      assets_ids: assetIds,
      ...(this.level !== undefined ? { level: this.level } : {}),
      ...(this.customFeatureEnabled !== undefined
        ? { custom_feature_enabled: this.customFeatureEnabled }
        : {}),
    };
    this.sendIfOpen(JSON.stringify(msg));
  }

  /** Drop asset ids from the live subscription. */
  unsubscribe(assetIds: string[]): void {
    this.assetIds = this.assetIds.filter((id) => !assetIds.includes(id));
    const msg: MarketUpdateMessage = { operation: "unsubscribe", assets_ids: assetIds };
    this.sendIfOpen(JSON.stringify(msg));
  }
}

// ─── user subscription ──────────────────────────────────────────────────────

export interface UserSubscribeOptions {
  /** Callback delivery; when set, the async iterator stays empty. */
  onItem?: (item: UserStreamItem) => void;
}

export class UserSubscription extends WsSubscription<UserEvent> {
  private markets: string[];
  private readonly credentials: ApiCredentials;

  constructor(
    url: string,
    cfg: ResolvedWsOptions,
    credentials: ApiCredentials,
    markets: string[],
    options: UserSubscribeOptions = {},
  ) {
    super(url, cfg, options.onItem);
    this.credentials = credentials;
    this.markets = [...markets];
  }

  protected buildSubscribeFrame(): string {
    const auth: WsUserAuth = {
      apiKey: this.credentials.key,
      ...(this.credentials.secret !== "" ? { secret: this.credentials.secret } : {}),
      passphrase: this.credentials.passphrase,
    };
    const msg: UserSubscribeMessage = { auth, type: "user", markets: [...this.markets] };
    return JSON.stringify(msg);
  }

  protected handleText(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      this.emit({ kind: "error", error: withRawFrame(e, text), fatal: false });
      return;
    }
    // The server answers a bad apiKey + passphrase with {"error":"authentication failed"}
    // and closes. Terminal — the reconnect loop must NOT swallow this.
    const authError = userErrorEnvelope(value);
    if (authError !== undefined) {
      this.fail(new WsAuthError(0, `user-channel authentication failed: ${authError}`));
      return;
    }
    let event: UserEvent;
    try {
      event = parseUserEventValue(value);
    } catch (e) {
      this.emit({ kind: "error", error: withRawFrame(e, text), fatal: false });
      return;
    }
    this.emit({ kind: "event", event });
  }

  protected handleReconnected(): void {
    // No RESET on the user channel (parity with pm-sdk-go runOrderLoop / predict-rs
    // user pump): order/trade events are id-keyed, not cumulative book state.
  }

  /** Add condition ids; a non-empty list switches the server from "all markets" to filtered. */
  subscribe(conditionIds: string[]): void {
    for (const cid of conditionIds) {
      if (!this.markets.includes(cid)) this.markets.push(cid);
    }
    const msg: UserUpdateMessage = { operation: "subscribe", markets: conditionIds };
    this.sendIfOpen(JSON.stringify(msg));
  }

  /** Drop condition ids from the live subscription. */
  unsubscribe(conditionIds: string[]): void {
    this.markets = this.markets.filter((cid) => !conditionIds.includes(cid));
    const msg: UserUpdateMessage = { operation: "unsubscribe", markets: conditionIds };
    this.sendIfOpen(JSON.stringify(msg));
  }
}

// ─── client ─────────────────────────────────────────────────────────────────

/**
 * Entry point for the two WS channels. `wsUrl` is the bare WS endpoint
 * (e.g. `wss://clob-ws.hermestrade.xyz`); the channel paths `/ws/market` and
 * `/ws/user` are appended per subscription. Each subscribe call dials its own socket.
 */
export class PredictWsClient {
  private readonly wsUrl: string;
  private readonly options: ResolvedWsOptions;

  constructor(wsUrl: string, options: PredictWsOptions = {}) {
    const trimmed = wsUrl.replace(/\/+$/, "");
    if (trimmed === "") {
      throw new ValidationError("ws endpoint not configured");
    }
    this.wsUrl = trimmed;
    this.options = { ...DEFAULT_WS_OPTIONS, ...options };
  }

  /**
   * Subscribe to `/ws/market` for one or more asset (token) ids.
   * The subscribe envelope is `{"assets_ids": [...], "type": "market",
   * "initial_dump": <bool>, "level"?: 1|2|3, "custom_feature_enabled"?: bool}`.
   */
  subscribeMarket(assetIds: string[], options: MarketSubscribeOptions = {}): MarketSubscription {
    if (assetIds.length === 0) {
      throw new ValidationError("subscribeMarket: assetIds must be non-empty");
    }
    const sub = new MarketSubscription(`${this.wsUrl}/ws/market`, this.options, assetIds, options);
    sub.start();
    return sub;
  }

  /**
   * Subscribe to `/ws/user`. Auth (apiKey + passphrase, secret optional and unused by
   * the server) rides in the first WS frame. Empty `markets` = all markets owned by
   * the API key; entries are condition ids.
   */
  subscribeUser(
    credentials: ApiCredentials,
    markets: string[] = [],
    options: UserSubscribeOptions = {},
  ): UserSubscription {
    if (credentials.key === "" || credentials.passphrase === "") {
      throw new ValidationError("subscribeUser: credentials.key and passphrase are required");
    }
    const sub = new UserSubscription(
      `${this.wsUrl}/ws/user`,
      this.options,
      credentials,
      markets,
      options,
    );
    sub.start();
    return sub;
  }
}
