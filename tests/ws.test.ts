/**
 * Offline tests for the WebSocket module.
 *
 * Fixture frames are copied verbatim from predict-rs
 * `clob-client/tests/ws_fixtures.rs` / `ws_offline.rs` and
 * `clob-client/src/clob/ws/types/response.rs` (live-verified against
 * clob-ws.hermestrade.xyz). A local in-process `WebSocketServer` stands in for the
 * server; no test touches the network.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import { ValidationError } from "../src/errors.js";
import {
  type MarketStreamItem,
  type MarketSubscription,
  PredictWsClient,
  type UserSubscription,
  type WsStreamItem,
} from "../src/ws/client.js";
import {
  parseMarketEvent,
  parseOrderStatus,
  parseTradeStatus,
  parseUserEvent,
  WsAuthError,
  WsDecodeError,
  WsOrderStatus,
  WsTradeStatus,
} from "../src/ws/types.js";

// ─── fixtures (from predict-rs tests — do not edit) ─────────────────────────

const MARKET_FIXTURES: Array<{ raw: string; eventType: string }> = [
  {
    raw: '{"event_type":"book","data":{"asset_id":"1","market":"0xcid","bids":[{"price":"0.4","size":"1"}],"asks":[{"price":"0.6","size":"2"}],"timestamp":1,"hash":"h"}}',
    eventType: "book",
  },
  {
    raw: '{"event_type":"price_change","data":{"market":"0xcid","price_changes":[{"asset_id":"1","price":"0.4","size":"0","side":"BUY","hash":"h","best_bid":"0.39","best_ask":"0.41"}],"timestamp":1}}',
    eventType: "price_change",
  },
  {
    raw: '{"event_type":"last_trade_price","data":{"asset_id":"1","market":"0xcid","price":"0.5","size":"1","fee_rate_bps":"10","side":"SELL","timestamp":1,"transaction_hash":""}}',
    eventType: "last_trade_price",
  },
  {
    raw: '{"event_type":"tick_size_change","data":{"asset_id":"1","market":"0xcid","old_tick_size":"0.01","new_tick_size":"0.001","timestamp":1}}',
    eventType: "tick_size_change",
  },
  {
    raw: '{"event_type":"best_bid_ask","data":{"asset_id":"1","market":"0xcid","best_bid":"0.49","best_ask":"0.51","spread":"0.02","timestamp":1}}',
    eventType: "best_bid_ask",
  },
  {
    raw: '{"event_type":"new_market","data":{"id":"m","question":"Q?","market":"0xcid","slug":"q","assets_ids":["1","2"],"outcomes":["Yes","No"],"tags":["t"],"timestamp":1}}',
    eventType: "new_market",
  },
  {
    raw: '{"event_type":"market_resolved","data":{"id":"m","market":"0xcid","assets_ids":["1","2"],"winning_asset_id":"1","winning_outcome":"Yes","tags":[],"timestamp":1}}',
    eventType: "market_resolved",
  },
];

/** Live frame captured on 2026-05-20 from clob-ws.hermestrade.xyz (Monad). */
const LIVE_TRADE_FRAME =
  '{"event_type":"trade","owner":"b40cbc5f-b3c0-4644-94a1-57e859f0038b","condition_id":"0xb808642dacfc6af662e46d58a118564afa1df134d41952e37532ef7b4b89001e","data":{"asset_id":"75376549546305181946655842061972812241926814861786064316719293942708924791063","id":"315312644720427008","match_type":"MINT","order_id":"315312644699455488","price":"0.91","side":"BUY","size":"5","status":"MATCHED"}}';

/** Live `/ws/user` placement shape: lean payload, wire `type` = order type, lowercase status. */
const LIVE_ORDER_PLACEMENT_FRAME =
  '{"event_type":"order","owner":"owner-uuid","condition_id":"0xcid","data":{"id":"0xorderhash","asset_id":"1234","lazy":"false","original_size":"10","price":"0.5","side":"BUY","status":"live","type":"GTC"}}';

/** Legacy asyncapi-shaped order fixture (long status, `type` = PLACEMENT, null associate_trades). */
const LEGACY_ORDER_FRAME =
  '{"event_type":"order","data":{"type":"PLACEMENT","id":"0x","owner":"o","market":"0xcid","asset_id":"1","side":"BUY","original_size":"10","size_matched":"0","price":"0.5","outcome":"Yes","order_type":"GTC","status":"ORDER_STATUS_LIVE","maker_address":"0xs","expiration":0,"created_at":1,"associate_trades":null,"lazy":"false","timestamp":1}}';

const FULL_TRADE_FRAME =
  '{"event_type":"trade","data":{"type":"TRADE","id":"t","taker_order_id":"0x","market":"0xcid","asset_id":"1","side":"BUY","size":"1","price":"0.5","fee_rate_bps":"10","status":"TRADE_STATUS_MATCHED","outcome":"Yes","owner":"o","maker_address":"0xs","transaction_hash":"","bucket_index":0,"matchtime":1,"last_update":1,"trader_side":"TAKER","maker_orders":[{"order_id":"0xmaker","owner":"om","maker_address":"0xms","matched_amount":"1","price":"0.5","fee_rate_bps":"10","asset_id":"1234","outcome":"Yes","side":"SELL"}],"timestamp":1}}';

function bookFrame(timestamp: number, price: string): string {
  return JSON.stringify({
    event_type: "book",
    asset_id: "a1",
    data: {
      asset_id: "a1",
      market: "0xcid",
      bids: [{ price, size: "1" }],
      asks: [{ price: "0.9", size: "2" }],
      timestamp,
      hash: "h",
    },
  });
}

function tradeStatusFrame(id: string, status: string): string {
  return JSON.stringify({
    event_type: "trade",
    data: { id, asset_id: "1", side: "BUY", size: "5", price: "0.91", status },
  });
}

// ─── test server / helpers ──────────────────────────────────────────────────

interface TestServer {
  url: string;
  connections: ServerSocket[];
  received: string[];
  close(): Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function startServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const server: TestServer = {
      url: "",
      connections: [],
      received: [],
      close: () =>
        new Promise<void>((done) => {
          for (const conn of server.connections) conn.terminate();
          wss.close(() => done());
        }),
    };
    wss.on("connection", (ws) => {
      server.connections.push(ws);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) server.received.push(data.toString());
      });
    });
    wss.on("listening", () => {
      const addr = wss.address() as AddressInfo;
      server.url = `ws://127.0.0.1:${addr.port}`;
      cleanups.push(server.close);
      resolve(server);
    });
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000, step = 5): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

async function nextItem<T>(it: AsyncIterator<T>, ms = 2000): Promise<T> {
  const result = await Promise.race([
    it.next(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("nextItem: timed out waiting for ws item")), ms),
    ),
  ]);
  if (result.done) throw new Error("nextItem: stream ended unexpectedly");
  return result.value;
}

function expectEvent<E>(item: WsStreamItem<E>): E {
  expect(item.kind).toBe("event");
  if (item.kind !== "event") throw new Error("unreachable");
  return item.event;
}

const FAST = { initialBackoffMs: 10, jitterMs: 0, pingIntervalMs: 0, connectTimeoutMs: 1000 };

const CREDS = {
  key: "00000000-0000-0000-0000-000000000000",
  secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  passphrase: "pass-1",
};

function trackSub(sub: MarketSubscription | UserSubscription): void {
  cleanups.push(() => sub.close());
}

// ─── frame parsing (no server) ──────────────────────────────────────────────

describe("market frame parsing", () => {
  it("decodes every documented market event_type from the nested data envelope", () => {
    for (const { raw, eventType } of MARKET_FIXTURES) {
      const event = parseMarketEvent(raw);
      expect(event.eventType).toBe(eventType);
    }
  });

  it("decodes book payload fields", () => {
    const event = parseMarketEvent(MARKET_FIXTURES[0]?.raw ?? "");
    if (event.eventType !== "book") throw new Error("wrong variant");
    expect(event.data.asset_id).toBe("1");
    expect(event.data.market).toBe("0xcid");
    expect(event.data.bids).toEqual([{ price: "0.4", size: "1" }]);
    expect(event.data.asks).toEqual([{ price: "0.6", size: "2" }]);
    expect(event.data.timestamp).toBe(1);
    expect(event.data.hash).toBe("h");
  });

  it("decodes price_change entries with side and removal size", () => {
    const event = parseMarketEvent(MARKET_FIXTURES[1]?.raw ?? "");
    if (event.eventType !== "price_change") throw new Error("wrong variant");
    const entry = event.data.price_changes[0];
    expect(entry?.side).toBe("BUY");
    expect(entry?.size).toBe("0");
    expect(entry?.best_bid).toBe("0.39");
    expect(entry?.best_ask).toBe("0.41");
  });

  it("accepts number, quoted-integer, empty-string, and RFC3339 timestamps", () => {
    const make = (ts: unknown) =>
      JSON.stringify({
        event_type: "tick_size_change",
        data: {
          asset_id: "1",
          market: "0xcid",
          old_tick_size: "0.01",
          new_tick_size: "0.001",
          timestamp: ts,
        },
      });
    const get = (raw: string): number => {
      const ev = parseMarketEvent(raw);
      if (ev.eventType !== "tick_size_change") throw new Error("wrong variant");
      return ev.data.timestamp;
    };
    expect(get(make(1700000000))).toBe(1700000000);
    expect(get(make("1700000000"))).toBe(1700000000);
    expect(get(make(""))).toBe(0);
    // RFC3339 collapses to Unix seconds (predict-rs Timestamp visitor).
    expect(get(make("2026-05-19T19:17:39Z"))).toBe(1779218259);
  });

  it("rejects flat (non-nested) frames and unknown event types with WsDecodeError", () => {
    // asyncapi shows a flat shape; the live server nests under data — flat must fail.
    expect(() =>
      parseMarketEvent('{"event_type":"book","asset_id":"1","market":"0xcid","bids":[]}'),
    ).toThrow(WsDecodeError);
    expect(() => parseMarketEvent('{"event_type":"bogus","data":{}}')).toThrow(WsDecodeError);
    expect(() => parseMarketEvent("not json")).toThrow(WsDecodeError);
  });
});

describe("user frame parsing", () => {
  it("decodes the live placement shape: lowercase status, wire type carries the order type", () => {
    const event = parseUserEvent(LIVE_ORDER_PLACEMENT_FRAME);
    if (event.eventType !== "order") throw new Error("wrong variant");
    expect(event.data.id).toBe("0xorderhash");
    expect(event.data.status).toBe(WsOrderStatus.LIVE);
    expect(event.data.order_type).toBe("GTC");
    expect(event.data.lazy).toBe("false");
    expect(event.data.side).toBe("BUY");
  });

  it("decodes a lean cancellation with just id and status", () => {
    const event = parseUserEvent(
      '{"event_type":"order","data":{"id":"0xorder","status":"canceled"}}',
    );
    if (event.eventType !== "order") throw new Error("wrong variant");
    expect(event.data.status).toBe(WsOrderStatus.CANCELED);
    expect(event.data.lazy).toBeUndefined();
    expect(event.data.side).toBeUndefined();
    expect(event.data.asset_id).toBe("");
  });

  it("decodes the legacy asyncapi order fixture (PLACEMENT sub-type, null associate_trades)", () => {
    const event = parseUserEvent(LEGACY_ORDER_FRAME);
    if (event.eventType !== "order") throw new Error("wrong variant");
    expect(event.data.status).toBe(WsOrderStatus.LIVE);
    // Wire `type` maps to order_type; the legacy `order_type` key is ignored.
    expect(event.data.order_type).toBe("PLACEMENT");
    expect(event.data.associate_trades).toBeUndefined();
    expect(event.data.created_at).toBe(1);
  });

  it("decodes the captured live trade frame with server extensions", () => {
    const event = parseUserEvent(LIVE_TRADE_FRAME);
    if (event.eventType !== "trade") throw new Error("wrong variant");
    const trade = event.data;
    expect(trade.id).toBe("315312644720427008");
    expect(trade.status).toBe(WsTradeStatus.MATCHED); // short-UPPERCASE alias
    expect(trade.match_type).toBe("MINT");
    // order_id aliases taker_order_id.
    expect(trade.taker_order_id).toBe("315312644699455488");
    expect(trade.side).toBe("BUY");
    expect(trade.size).toBe("5");
    expect(trade.price).toBe("0.91");
    // Lean frame: absent fields default cleanly.
    expect(trade.market).toBe("");
    expect(trade.sub_type).toBe("TRADE");
    expect(trade.trader_side).toBeUndefined();
    expect(trade.maker_orders).toEqual([]);
  });

  it("decodes the full trade fixture including maker_orders and trader_side", () => {
    const event = parseUserEvent(FULL_TRADE_FRAME);
    if (event.eventType !== "trade") throw new Error("wrong variant");
    expect(event.data.status).toBe(WsTradeStatus.MATCHED);
    expect(event.data.trader_side).toBe("TAKER");
    expect(event.data.maker_orders).toHaveLength(1);
    expect(event.data.maker_orders[0]?.side).toBe("SELL");
    expect(event.data.maker_orders[0]?.matched_amount).toBe("1");
  });
});

describe("status normalization", () => {
  it("accepts all three order-status flavours and normalizes to the long form", () => {
    for (const raw of ["ORDER_STATUS_LIVE", "live", "LIVE"]) {
      expect(parseOrderStatus(raw)).toBe(WsOrderStatus.LIVE);
    }
    for (const raw of ["ORDER_STATUS_CANCELED", "canceled", "cancelled", "CANCELED", "CANCELLED"]) {
      expect(parseOrderStatus(raw)).toBe(WsOrderStatus.CANCELED);
    }
    expect(parseOrderStatus("ORDER_STATUS_MATCHED")).toBe(WsOrderStatus.MATCHED);
    expect(parseOrderStatus("CANCELED_MARKET_RESOLVED")).toBe(
      WsOrderStatus.CANCELED_MARKET_RESOLVED,
    );
    expect(parseOrderStatus("system_cleared")).toBe(WsOrderStatus.SYSTEM_CLEARED);
    expect(parseOrderStatus("INVALID")).toBe(WsOrderStatus.INVALID);
    expect(() => parseOrderStatus("NOPE")).toThrow(WsDecodeError);
  });

  it("accepts all trade-status flavours and normalizes to the long form", () => {
    const cases: Array<[string[], string]> = [
      [["TRADE_STATUS_MATCHED", "matched", "MATCHED"], WsTradeStatus.MATCHED],
      [["TRADE_STATUS_MINED", "mined", "MINED"], WsTradeStatus.MINED],
      [["TRADE_STATUS_CONFIRMED", "confirmed", "CONFIRMED"], WsTradeStatus.CONFIRMED],
      [["TRADE_STATUS_RETRYING", "retrying", "RETRYING"], WsTradeStatus.RETRYING],
      [["TRADE_STATUS_FAILED", "failed", "FAILED"], WsTradeStatus.FAILED],
    ];
    for (const [aliases, expected] of cases) {
      for (const raw of aliases) expect(parseTradeStatus(raw)).toBe(expected);
    }
    expect(() => parseTradeStatus("NOPE")).toThrow(WsDecodeError);
  });
});

// ─── subscribe wire frames ──────────────────────────────────────────────────

describe("subscribe envelopes", () => {
  it("market subscribe sends the exact minimal envelope (initial_dump always present)", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a1", "a2"]);
    trackSub(sub);
    const frame = await waitFor(() => server.received[0]);
    expect(frame).toBe('{"assets_ids":["a1","a2"],"type":"market","initial_dump":true}');
  });

  it("market subscribe includes level and custom_feature_enabled when set", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["x"], {
      initialDump: true,
      level: 1,
      customFeatureEnabled: true,
    });
    trackSub(sub);
    const frame = await waitFor(() => server.received[0]);
    expect(JSON.parse(frame)).toEqual({
      assets_ids: ["x"],
      type: "market",
      initial_dump: true,
      level: 1,
      custom_feature_enabled: true,
    });
  });

  it("market runtime subscribe/unsubscribe send operation envelopes (level echoed on subscribe only)", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a"], { level: 2 });
    trackSub(sub);
    await waitFor(() => server.received[0]);
    sub.subscribe(["b"]);
    sub.unsubscribe(["a"]);
    await waitFor(() => (server.received.length >= 3 ? true : undefined));
    expect(JSON.parse(server.received[1] ?? "")).toEqual({
      operation: "subscribe",
      assets_ids: ["b"],
      level: 2,
    });
    expect(JSON.parse(server.received[2] ?? "")).toEqual({
      operation: "unsubscribe",
      assets_ids: ["a"],
    });
  });

  it("user subscribe carries the auth envelope in the first frame", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeUser(CREDS, ["0xcid"]);
    trackSub(sub);
    const frame = await waitFor(() => server.received[0]);
    expect(JSON.parse(frame)).toEqual({
      auth: { apiKey: CREDS.key, secret: CREDS.secret, passphrase: CREDS.passphrase },
      type: "user",
      markets: ["0xcid"],
    });
  });

  it("user runtime subscribe/unsubscribe use the markets field", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeUser(CREDS);
    trackSub(sub);
    await waitFor(() => server.received[0]);
    sub.subscribe(["0xc1"]);
    sub.unsubscribe(["0xc1"]);
    await waitFor(() => (server.received.length >= 3 ? true : undefined));
    expect(JSON.parse(server.received[1] ?? "")).toEqual({
      operation: "subscribe",
      markets: ["0xc1"],
    });
    expect(JSON.parse(server.received[2] ?? "")).toEqual({
      operation: "unsubscribe",
      markets: ["0xc1"],
    });
  });

  it("rejects empty assetIds and empty credentials", async () => {
    const client = new PredictWsClient("ws://127.0.0.1:1");
    expect(() => client.subscribeMarket([])).toThrow(ValidationError);
    expect(() => client.subscribeUser({ key: "", secret: "", passphrase: "" })).toThrow(
      ValidationError,
    );
    expect(() => new PredictWsClient("")).toThrow(ValidationError);
  });
});

// ─── streaming ──────────────────────────────────────────────────────────────

describe("event streaming", () => {
  it("yields decoded market events and skips PONG keep-alives", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["1"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]); // subscribe arrived; socket is up
    conn.send("PONG");
    conn.send(MARKET_FIXTURES[0]?.raw ?? "");
    const event = expectEvent(await nextItem(it));
    expect(event.eventType).toBe("book");
  });

  it("delivers items via the onItem callback when provided", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const items: MarketStreamItem[] = [];
    const sub = client.subscribeMarket(["1"], { onItem: (item) => items.push(item) });
    trackSub(sub);
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.send(MARKET_FIXTURES[2]?.raw ?? "");
    await waitFor(() => (items.length >= 1 ? true : undefined));
    expect(items[0]?.kind).toBe("event");
  });

  it("surfaces decode failures as non-fatal error items and keeps streaming", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["1"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.send('{"event_type":"bogus","data":{}}');
    conn.send(MARKET_FIXTURES[0]?.raw ?? "");
    const first = await nextItem(it);
    expect(first.kind).toBe("error");
    if (first.kind === "error") {
      expect(first.fatal).toBe(false);
      expect(first.error).toBeInstanceOf(WsDecodeError);
    }
    const second = expectEvent(await nextItem(it));
    expect(second.eventType).toBe("book");
  });

  it("streams the trade lifecycle MATCHED -> MINED -> CONFIRMED on the same trade id", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeUser(CREDS, ["0xcid"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.send(tradeStatusFrame("t-1", "MATCHED"));
    conn.send(tradeStatusFrame("t-1", "MINED"));
    conn.send(tradeStatusFrame("t-1", "CONFIRMED"));
    const statuses: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const event = expectEvent(await nextItem(it));
      if (event.eventType !== "trade") throw new Error("wrong variant");
      expect(event.data.id).toBe("t-1");
      statuses.push(event.data.status);
    }
    expect(statuses).toEqual([WsTradeStatus.MATCHED, WsTradeStatus.MINED, WsTradeStatus.CONFIRMED]);
  });

  it("treats the user-channel error envelope as fatal and ends the stream", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeUser(CREDS);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.send('{"error":"authentication failed"}');
    const item = await nextItem(it);
    expect(item.kind).toBe("error");
    if (item.kind === "error") {
      expect(item.fatal).toBe(true);
      expect(item.error).toBeInstanceOf(WsAuthError);
      expect((item.error as WsAuthError).status).toBe(0);
      expect(item.error.message).toContain("authentication failed");
    }
    const end = await it.next();
    expect(end.done).toBe(true);
  });
});

// ─── reconnect / sequence guard / heartbeat ─────────────────────────────────

describe("reconnect and sequence guard", () => {
  it("reconnects after a server close, emits reconnecting + RESET, and resubscribes", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a1"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.close();

    const reconnecting = await nextItem(it);
    expect(reconnecting.kind).toBe("reconnecting");
    if (reconnecting.kind === "reconnecting") {
      expect(reconnecting.attempt).toBe(1);
      expect(reconnecting.delayMs).toBe(10); // initialBackoffMs, no jitter
    }
    // After the second connect, the market channel pushes RESET (pm-sdk-go parity).
    const reset = await nextItem(it);
    expect(reset).toEqual({ kind: "reset" });
    // The subscribe envelope is re-sent on the new connection.
    await waitFor(() => (server.received.length >= 2 ? true : undefined));
    expect(server.received[1]).toBe('{"assets_ids":["a1"],"type":"market","initial_dump":true}');
    expect(server.connections.length).toBe(2);
  });

  it("emits RESET and drops the frame on timestamp regress and on duplicates", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a1"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);

    conn.send(bookFrame(2000, "0.4")); // accepted
    conn.send(bookFrame(1000, "0.5")); // regress -> RESET, dropped
    conn.send(bookFrame(3000, "0.6")); // accepted (guard was cleared)
    conn.send(bookFrame(3000, "0.6")); // exact duplicate -> RESET, dropped

    const first = expectEvent(await nextItem(it));
    if (first.eventType !== "book") throw new Error("wrong variant");
    expect(first.data.timestamp).toBe(2000);

    expect(await nextItem(it)).toEqual({ kind: "reset" });

    const third = expectEvent(await nextItem(it));
    if (third.eventType !== "book") throw new Error("wrong variant");
    expect(third.data.timestamp).toBe(3000);

    expect(await nextItem(it)).toEqual({ kind: "reset" });
  });

  it("allows equal timestamps with different content (multiple events per tick)", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a1"]);
    trackSub(sub);
    const it = sub[Symbol.asyncIterator]();
    const conn = await waitFor(() => server.connections[0]);
    await waitFor(() => server.received[0]);
    conn.send(bookFrame(5000, "0.4"));
    conn.send(bookFrame(5000, "0.5")); // same ts, different hash -> accepted
    expectEvent(await nextItem(it));
    const second = expectEvent(await nextItem(it));
    if (second.eventType !== "book") throw new Error("wrong variant");
    expect(second.data.bids[0]?.price).toBe("0.5");
  });

  it("sends the text-frame PING heartbeat at the configured interval", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, {
      ...FAST,
      pingIntervalMs: 20,
    });
    const sub = client.subscribeMarket(["a1"]);
    trackSub(sub);
    await waitFor(() => server.received[0]); // subscribe frame
    const ping = await waitFor(() => server.received.find((f) => f === "PING"));
    expect(ping).toBe("PING");
    // Subscribe frame stays first; PINGs follow.
    expect(server.received[0]).toContain('"type":"market"');
  });

  it("close() ends the stream and stops reconnecting", async () => {
    const server = await startServer();
    const client = new PredictWsClient(server.url, FAST);
    const sub = client.subscribeMarket(["a1"]);
    const it = sub[Symbol.asyncIterator]();
    await waitFor(() => server.received[0]);
    sub.close();
    const end = await it.next();
    expect(end.done).toBe(true);
    // No further connection attempts after close.
    const connectionsAtClose = server.connections.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connections.length).toBe(connectionsAtClose);
  });
});
