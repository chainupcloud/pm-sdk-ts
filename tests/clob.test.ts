/**
 * Offline unit tests for the CLOB REST client (mocked fetch).
 *
 * Wire expectations mirror predict-rs `clob-client/tests/orders_http.rs` and
 * `tests/batch_reads.rs`: exact paths, query params, L1/L2 headers (HMAC over the
 * path WITHOUT query string + the exact serialized body), the `POST /order`
 * envelope, batch limits, and cursor pagination.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClobClient } from "../src/clob/client.js";
import { buildSendOrderRequest, isPageEnd, signatureTypeToNumericWire } from "../src/clob/types.js";
import { computeL2Hmac } from "../src/crypto/hmac.js";
import { PredictSigner } from "../src/crypto/signer.js";
import { ValidationError } from "../src/errors.js";
import { buildLimitOrder, type SignedOrderWire, signBuiltOrder } from "../src/order-builder.js";
import { type ApiCredentials, scopeIdFromHex } from "../src/types.js";

// Hardhat / Anvil account #0 — the golden test key shared with predict-rs / pm-sdk-go.
const GOLDEN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const GOLDEN_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CHAIN_ID = 137;
const EXCHANGE = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const SAFE = "0x000000000000000000000000000000000000dead";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CREDS: ApiCredentials = {
  key: "11111111-2222-3333-4444-555555555555",
  secret: SECRET,
  passphrase: "passphrase-test",
};
const BASE = "https://clob-api.test.example";

/**
 * Pinned EIP-712 Order signature: golden key, chainId 137, exchange EXCHANGE,
 * salt 12345, BUY 100 shares @ 0.34, feeRateBps 100, maker = SAFE,
 * signatureType POLY_GNOSIS_SAFE (2), zero scope. Deterministic (RFC 6979).
 */
const PINNED_ORDER_SIGNATURE =
  "0x1d4c739dcfea945a677d93630f6b200b4e85b11667be53678edfa4c4101a37455a21b535425b23acf83468fcaecffdeaaf9211a4ef259c97bed60aa7383d3cea1b";

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

interface Route {
  method: string;
  path: string;
  status?: number;
  json?: unknown;
  text?: string;
}

function installFetch(...routes: Route[]): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ method, url, headers, body });
      const route = routes.find((r) => r.method === method && r.path === url.pathname);
      if (!route) {
        return new Response(`no route for ${method} ${url.pathname}`, { status: 404 });
      }
      const payload = route.text ?? JSON.stringify(route.json);
      return new Response(payload, { status: route.status ?? 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function newSigner(scopeIdHex?: string): PredictSigner {
  const options: ConstructorParameters<typeof PredictSigner>[1] = {
    chainId: CHAIN_ID,
    exchange: EXCHANGE,
  };
  if (scopeIdHex !== undefined) options.scopeId = scopeIdFromHex(scopeIdHex);
  return new PredictSigner(GOLDEN_KEY, options);
}

function newClient(signer = newSigner()): ClobClient {
  return new ClobClient({
    baseUrl: BASE,
    signer,
    credentials: CREDS,
    fundingAddress: SAFE,
  });
}

function getCall(calls: Recorded[], index: number): Recorded {
  const call = calls[index];
  if (!call) throw new Error(`no recorded call at index ${index}`);
  return call;
}

/** Verify the five L2 headers; the HMAC must cover the path only (no query). */
function assertL2Headers(call: Recorded, path: string): void {
  const ts = call.headers.PRED_TIMESTAMP ?? "";
  expect(ts).not.toBe("");
  expect(call.headers.PRED_API_KEY).toBe(CREDS.key);
  expect(call.headers.PRED_PASSPHRASE).toBe(CREDS.passphrase);
  expect(call.headers.PRED_ADDRESS).toBe(GOLDEN_ADDR);
  expect(call.headers.PRED_SIGNATURE).toBe(computeL2Hmac(SECRET, ts, call.method, path, call.body));
}

async function goldenSignedOrder(): Promise<SignedOrderWire> {
  const signer = newSigner();
  const built = buildLimitOrder(
    {
      tokenId: "100",
      side: "BUY",
      price: "0.34",
      size: "100",
      feeRateBps: 100,
      maker: SAFE,
      salt: 12345n,
    },
    signer,
  );
  return signBuiltOrder(built, signer);
}

// ─── public market data ──────────────────────────────────────────────────────

describe("public market data", () => {
  it("ok returns the raw body", async () => {
    const calls = installFetch({ method: "GET", path: "/ok", text: "OK" });
    expect(await newClient().ok()).toBe("OK");
    expect(getCall(calls, 0).url.pathname).toBe("/ok");
  });

  it("time parses the integer body", async () => {
    installFetch({ method: "GET", path: "/time", text: "1700000000" });
    expect(await newClient().time()).toBe(1_700_000_000);
  });

  it("midpoint queries token_id and accepts the `mid` alias", async () => {
    const calls = installFetch({ method: "GET", path: "/midpoint", json: { mid: "0.5" } });
    const out = await newClient().midpoint("t1");
    expect(out.price).toBe("0.5");
    expect(getCall(calls, 0).url.searchParams.get("token_id")).toBe("t1");
  });

  it("price sends the side as lowercase buy/sell", async () => {
    const calls = installFetch({ method: "GET", path: "/price", json: { price: "0.51" } });
    const out = await newClient().price("t1", "SELL");
    expect(out.price).toBe("0.51");
    expect(getCall(calls, 0).url.searchParams.get("side")).toBe("sell");
  });

  it("tick-size normalizes numeric minimum_tick_size to a string", async () => {
    installFetch({ method: "GET", path: "/tick-size", json: { minimum_tick_size: 0.01 } });
    expect((await newClient().tickSize("t1")).minimum_tick_size).toBe("0.01");
  });

  it("fee-rate accepts the server's base_fee field name", async () => {
    installFetch({ method: "GET", path: "/fee-rate", json: { base_fee: 100 } });
    expect((await newClient().feeRate("t1")).fee_rate_bps).toBe(100);
  });

  it("last-trade-price accepts the last_trade_price alias", async () => {
    installFetch({
      method: "GET",
      path: "/last-trade-price",
      json: { last_trade_price: "0.42" },
    });
    expect((await newClient().lastTradePrice("t1")).price).toBe("0.42");
  });

  it("book decodes the summary including server extension fields", async () => {
    installFetch({
      method: "GET",
      path: "/book",
      json: {
        asset_id: "100",
        market: "0xcondition",
        bids: [{ price: "0.4", size: "10" }],
        asks: [{ price: "0.6", size: "10" }],
        tick_size: "0.01",
        neg_risk: true,
        min_order_size: "5",
        max_order_size: "",
      },
    });
    const book = await newClient().book("100");
    expect(book.asset_id).toBe("100");
    expect(book.market).toBe("0xcondition");
    expect(book.bids).toEqual([{ price: "0.4", size: "10" }]);
    expect(book.asks).toEqual([{ price: "0.6", size: "10" }]);
    expect(book.tick_size).toBe("0.01");
    expect(book.neg_risk).toBe(true);
    expect(book.min_order_size).toBe("5");
  });

  it("midpoints POSTs a token_id array and decodes the map", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/midpoints",
      json: { t1: "0.5", t2: 0.123 },
    });
    const out = await newClient().midpoints(["t1", "t2"]);
    expect(out).toEqual({ t1: "0.5", t2: "0.123" });
    expect(getCall(calls, 0).body).toBe('[{"token_id":"t1"},{"token_id":"t2"}]');
  });

  it("prices POSTs token/side pairs with UPPERCASE side", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/prices",
      json: { t1: { BUY: 0.51, SELL: 0.52 } },
    });
    const out = await newClient().prices([
      { tokenId: "t1", side: "BUY" },
      { tokenId: "t2", side: "SELL" },
    ]);
    expect(out.t1?.BUY).toBe(0.51);
    expect(getCall(calls, 0).body).toBe(
      '[{"token_id":"t1","side":"BUY"},{"token_id":"t2","side":"SELL"}]',
    );
  });

  it("spreads POSTs and decodes the map", async () => {
    installFetch({ method: "POST", path: "/spreads", json: { t1: "0.02", t2: "0" } });
    expect(await newClient().spreads(["t1", "t2"])).toEqual({ t1: "0.02", t2: "0" });
  });

  it("books returns one slot per request with null for unknown tokens", async () => {
    installFetch({
      method: "POST",
      path: "/books",
      json: [{ asset_id: "t1", bids: [], asks: [] }, null],
    });
    const out = await newClient().books([
      { tokenId: "t1", side: "BUY" },
      { tokenId: "t2", side: "SELL" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.asset_id).toBe("t1");
    expect(out[1]).toBeNull();
  });

  it("last-trades-prices decodes entries and caps the batch at 500", async () => {
    installFetch({
      method: "POST",
      path: "/last-trades-prices",
      json: [
        { token_id: "t1", price: "0.5", side: "BUY" },
        { token_id: "t2", price: "0.4", side: "" },
      ],
    });
    const client = newClient();
    const out = await client.lastTradesPrices(["t1", "t2"]);
    expect(out[0]).toEqual({ token_id: "t1", price: "0.5", side: "BUY" });
    expect(out[1]?.side).toBe("");

    const tooMany = Array.from({ length: 501 }, () => "x");
    await expect(client.lastTradesPrices(tooMany)).rejects.toThrow(/at most 500/);
  });

  it("price-history forwards interval / fidelity / limit and decodes points", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/price-history",
      json: {
        history: [
          { t: 1_700_000_000, p: "0.5" },
          { timestamp: 1_700_000_060, price: "0.51" },
        ],
      },
    });
    const out = await newClient().priceHistory("t1", "1H", { fidelity: 1, limit: 100 });
    expect(out.history).toEqual([
      { t: 1_700_000_000, p: "0.5" },
      { t: 1_700_000_060, p: "0.51" },
    ]);
    const q = getCall(calls, 0).url.searchParams;
    expect(q.get("token_id")).toBe("t1");
    expect(q.get("interval")).toBe("1H");
    expect(q.get("fidelity")).toBe("1");
    expect(q.get("limit")).toBe("100");
  });
});

// ─── L1 auth — API key CRUD ──────────────────────────────────────────────────

describe("L1 API key endpoints", () => {
  it("createApiKey POSTs /auth/api-key with L1 headers and decodes the apiKey alias", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/auth/api-key",
      json: { apiKey: CREDS.key, secret: SECRET, passphrase: "pp" },
    });
    const creds = await newClient().createApiKey();
    expect(creds).toEqual({ key: CREDS.key, secret: SECRET, passphrase: "pp" });
    const call = getCall(calls, 0);
    expect(call.headers.PRED_ADDRESS).toBe(GOLDEN_ADDR);
    expect(call.headers.PRED_NONCE).toBe("0");
    expect(call.headers.PRED_TIMESTAMP).toMatch(/^\d+$/);
    expect(call.headers.PRED_SIGNATURE).toMatch(/^0x[0-9a-f]{130}$/);
    expect(call.headers.PRED_API_KEY).toBeUndefined();
    expect(call.headers.PRED_SCOPE_ID).toBeUndefined();
    expect(call.body).toBe("");
  });

  it("emits PRED_SCOPE_ID only for non-zero scopes", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/auth/api-key",
      json: { key: CREDS.key, secret: SECRET, passphrase: "pp" },
    });
    await newClient(newSigner("0x01")).createApiKey(7);
    const call = getCall(calls, 0);
    expect(call.headers.PRED_SCOPE_ID).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(call.headers.PRED_NONCE).toBe("7");
  });

  it("createOrDeriveApiKey falls back to GET /auth/derive-api-key on an HTTP error", async () => {
    const calls = installFetch(
      { method: "POST", path: "/auth/api-key", status: 409, json: { error: "exists" } },
      {
        method: "GET",
        path: "/auth/derive-api-key",
        json: { key: CREDS.key, secret: SECRET, passphrase: "pp" },
      },
    );
    const creds = await newClient().createOrDeriveApiKey();
    expect(creds.key).toBe(CREDS.key);
    expect(calls).toHaveLength(2);
    expect(getCall(calls, 1).method).toBe("GET");
    expect(getCall(calls, 1).url.pathname).toBe("/auth/derive-api-key");
  });

  it("revokeApiKey DELETEs /auth/api-key with the nonce-bound L1 headers", async () => {
    const calls = installFetch({ method: "DELETE", path: "/auth/api-key", text: "" });
    await newClient().revokeApiKey(3);
    const call = getCall(calls, 0);
    expect(call.headers.PRED_NONCE).toBe("3");
    expect(call.body).toBe("");
  });
});

// ─── L2 auth — orders ────────────────────────────────────────────────────────

describe("postOrder", () => {
  it("produces the pinned golden signature for the fixed salt", async () => {
    const signed = await goldenSignedOrder();
    expect(signed.signature).toBe(PINNED_ORDER_SIGNATURE);
    // toWireOrder emits the live wire form: the numeric string ("0" | "1" | "2").
    expect(signed.signatureType).toBe("2");
    expect(signed.scopeId).toBeUndefined();
  });

  it("sends the exact envelope body with numeric signatureType and L2 headers", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/order",
      json: {
        success: true,
        orderID: "snowflake-1",
        status: "live",
        takingAmount: "100000000",
        makingAmount: "34000000",
      },
    });
    const signed = await goldenSignedOrder();
    const resp = await newClient().postOrder(signed, "GTC");
    expect(resp.orderID).toBe("snowflake-1");
    expect(resp.status).toBe("live");
    expect(resp.success).toBe(true);
    expect(resp.transactionsHashes).toEqual([]);
    expect(resp.tradeIDs).toEqual([]);

    const call = getCall(calls, 0);
    assertL2Headers(call, "/order");
    // Exact wire body: tokenID mixed case, decimal-string numerics, side "BUY",
    // signatureType "2", owner/postOnly/deferExec omitted, scopeId omitted (zero).
    const expectedBody = JSON.stringify({
      order: {
        salt: "12345",
        maker: SAFE,
        signer: GOLDEN_ADDR,
        taker: ZERO_ADDR,
        tokenID: "100",
        makerAmount: "34000000",
        takerAmount: "100000000",
        expiration: "0",
        nonce: "0",
        feeRateBps: "100",
        side: "BUY",
        signatureType: "2",
        signature: PINNED_ORDER_SIGNATURE,
      },
      orderType: "GTC",
    });
    expect(call.body).toBe(expectedBody);
  });

  it("includes scopeId on the wire for scoped signers", async () => {
    const calls = installFetch({ method: "POST", path: "/order", json: { success: true } });
    const signer = newSigner("0x01");
    const built = buildLimitOrder(
      {
        tokenId: "100",
        side: "BUY",
        price: "0.34",
        size: "100",
        feeRateBps: 100,
        maker: SAFE,
        salt: 12345n,
      },
      signer,
    );
    const signed = await signBuiltOrder(built, signer);
    await newClient(signer).postOrder(signed, "GTC");
    const body = JSON.parse(getCall(calls, 0).body) as {
      order: { scopeId?: string; signatureType: string };
    };
    expect(body.order.scopeId).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(body.order.signatureType).toBe("2");
  });

  it("forwards owner and postOnly on the envelope when set", async () => {
    const calls = installFetch({ method: "POST", path: "/order", json: { success: true } });
    const signed = await goldenSignedOrder();
    await newClient().postOrder(signed, "GTD", true, "owner-uuid");
    const body = JSON.parse(getCall(calls, 0).body) as Record<string, unknown>;
    expect(body.owner).toBe("owner-uuid");
    expect(body.orderType).toBe("GTD");
    expect(body.postOnly).toBe(true);
    expect(body.deferExec).toBeUndefined();
  });
});

describe("postOrders (batch)", () => {
  it("serializes a bare JSON array of envelopes", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/orders",
      json: [
        { success: true, orderID: "a", status: "live" },
        { success: true, orderID: "b", status: "live" },
      ],
    });
    const signed = await goldenSignedOrder();
    const resp = await newClient().postOrders([signed, signed], "GTC");
    expect(resp.map((r) => r.orderID)).toEqual(["a", "b"]);

    const call = getCall(calls, 0);
    assertL2Headers(call, "/orders");
    const body = JSON.parse(call.body) as Array<{ orderType: string; order: { tokenID: string } }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]?.orderType).toBe("GTC");
    expect(body[0]?.order.tokenID).toBe("100");
  });

  it("rejects more than 15 orders client-side", async () => {
    installFetch();
    const signed = await goldenSignedOrder();
    const tooMany = Array.from({ length: 16 }, () => signed);
    await expect(newClient().postOrders(tooMany, "GTC")).rejects.toThrow(/at most 15/);
  });

  it("returns [] for an empty batch without hitting the network", async () => {
    const calls = installFetch();
    expect(await newClient().postOrders([], "GTC")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("replaceOrders", () => {
  it("POSTs /orders/replace with cancelOrderIDs + orders", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/orders/replace",
      json: {
        stoppedAt: "",
        cancels: [{ orderID: "old-1", status: "canceled" }],
        placements: [{ index: 0, success: true, orderID: "new-1", status: "live" }],
      },
    });
    const signed = await goldenSignedOrder();
    const resp = await newClient().replaceOrders({
      cancelOrderIDs: ["old-1"],
      orders: [buildSendOrderRequest(signed, "GTC")],
    });
    expect(resp.cancels[0]?.orderID).toBe("old-1");
    expect(resp.placements[0]?.orderID).toBe("new-1");
    expect(resp.placements[0]?.index).toBe(0);

    const call = getCall(calls, 0);
    assertL2Headers(call, "/orders/replace");
    const body = JSON.parse(call.body) as {
      cancelOrderIDs: string[];
      orders: Array<{ order: { signatureType: string } }>;
    };
    expect(body.cancelOrderIDs).toEqual(["old-1"]);
    expect(body.orders[0]?.order.signatureType).toBe("2");
  });
});

describe("cancel endpoints", () => {
  it("cancelOrder DELETEs /order with an orderID envelope", async () => {
    const calls = installFetch({
      method: "DELETE",
      path: "/order",
      json: { canceled: ["snowflake-1"], not_canceled: {} },
    });
    const resp = await newClient().cancelOrder("snowflake-1");
    expect(resp.canceled).toEqual(["snowflake-1"]);
    expect(resp.not_canceled).toEqual({});
    const call = getCall(calls, 0);
    assertL2Headers(call, "/order");
    expect(call.body).toBe('{"orderID":"snowflake-1"}');
  });

  it("cancelOrders DELETEs /orders with a bare JSON array and caps at 3000", async () => {
    const calls = installFetch({
      method: "DELETE",
      path: "/orders",
      json: { canceled: ["a", "b"], not_canceled: {} },
    });
    const client = newClient();
    await client.cancelOrders(["a", "b"]);
    const call = getCall(calls, 0);
    assertL2Headers(call, "/orders");
    expect(call.body).toBe('["a","b"]');

    const tooMany = Array.from({ length: 3001 }, (_, i) => String(i));
    await expect(client.cancelOrders(tooMany)).rejects.toThrow(/at most 3000/);
  });

  it("cancelAll DELETEs /cancel-all with no body (HMAC over empty string)", async () => {
    const calls = installFetch({
      method: "DELETE",
      path: "/cancel-all",
      json: { canceled: ["a", "b"], not_canceled: {} },
    });
    const resp = await newClient().cancelAll();
    expect(resp.canceled).toHaveLength(2);
    const call = getCall(calls, 0);
    expect(call.body).toBe("");
    assertL2Headers(call, "/cancel-all");
  });

  it("cancelMarketOrders requires market or asset_id and sends the right body", async () => {
    const calls = installFetch({
      method: "DELETE",
      path: "/cancel-market-orders",
      json: { canceled: ["x"], not_canceled: {} },
    });
    const client = newClient();
    await expect(client.cancelMarketOrders({})).rejects.toThrow(/at least one of/);

    await client.cancelMarketOrders({ asset_id: "100" });
    const call = getCall(calls, 0);
    assertL2Headers(call, "/cancel-market-orders");
    expect(call.body).toBe('{"asset_id":"100"}');
  });
});

// ─── L2 auth — queries ───────────────────────────────────────────────────────

describe("order / trade queries", () => {
  it("openOrders forwards filters + next_cursor and signs the path only", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/orders",
      json: {
        limit: 100,
        count: 1,
        next_cursor: "LTE=",
        data: [
          {
            id: "snowflake-1",
            status: "ORDER_STATUS_LIVE",
            maker_address: "0xabc",
            market: "0xcondition",
            asset_id: "100",
            side: "BUY",
            original_size: "10",
            size_matched: "0",
            price: "0.34",
            associate_trades: null,
          },
        ],
      },
    });
    const page = await newClient().openOrders({ market: "0xcondition", asset_id: "100" }, "LTE=");
    expect(page.count).toBe(1);
    expect(isPageEnd(page)).toBe(true);
    expect(page.data[0]?.id).toBe("snowflake-1");
    // null associate_trades -> [] (Rust null_as_empty_vec parity).
    expect(page.data[0]?.associate_trades).toEqual([]);

    const call = getCall(calls, 0);
    const q = call.url.searchParams;
    expect(q.get("market")).toBe("0xcondition");
    expect(q.get("asset_id")).toBe("100");
    expect(q.get("next_cursor")).toBe("LTE=");
    expect(q.get("id")).toBeNull();
    expect(q.get("status")).toBeNull();
    // The HMAC covers /orders only — recomputing without the query must match.
    assertL2Headers(call, "/orders");
  });

  it("openOrder GETs /order/{id} and signs the full path", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/order/snowflake-1",
      json: { id: "snowflake-1", status: "ORDER_STATUS_LIVE" },
    });
    const order = await newClient().openOrder("snowflake-1");
    expect(order.id).toBe("snowflake-1");
    assertL2Headers(getCall(calls, 0), "/order/snowflake-1");
  });

  it("trades injects fundingAddress as maker_address and forwards from_id / limit", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/trades",
      json: { limit: 100, count: 0, next_cursor: "LTE=", data: null },
    });
    const page = await newClient().trades({ from_id: 42, limit: 50 }, "abc=");
    expect(isPageEnd(page)).toBe(true);
    expect(page.data).toEqual([]);

    const call = getCall(calls, 0);
    const q = call.url.searchParams;
    expect(q.get("maker_address")).toBe(SAFE);
    expect(q.get("from_id")).toBe("42");
    expect(q.get("limit")).toBe("50");
    expect(q.get("next_cursor")).toBe("abc=");
    assertL2Headers(call, "/trades");
  });

  it("builderTrades does not inject maker_address", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/builder/trades",
      json: { limit: 100, count: 0, next_cursor: "LTE=", data: [] },
    });
    await newClient().builderTrades({ market: "0xcondition" });
    const call = getCall(calls, 0);
    expect(call.url.searchParams.get("maker_address")).toBeNull();
    expect(call.url.searchParams.get("market")).toBe("0xcondition");
    assertL2Headers(call, "/builder/trades");
  });

  it("orderScoring queries order_id; ordersScoring aggregates per id", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/order-scoring",
      json: { scoring: true },
    });
    const client = newClient();
    expect((await client.orderScoring("snowflake-1")).scoring).toBe(true);
    expect(getCall(calls, 0).url.searchParams.get("order_id")).toBe("snowflake-1");
    assertL2Headers(getCall(calls, 0), "/order-scoring");

    const map = await client.ordersScoring(["a", "b"]);
    expect(map).toEqual({ a: true, b: true });
    expect(calls).toHaveLength(3);
  });

  it("heartbeat POSTs an empty JSON object", async () => {
    const calls = installFetch({
      method: "POST",
      path: "/heartbeats",
      json: { status: "ok" },
    });
    expect((await newClient().heartbeat()).status).toBe("ok");
    const call = getCall(calls, 0);
    expect(call.body).toBe("{}");
    assertL2Headers(call, "/heartbeats");
  });
});

describe("balance-allowance", () => {
  it("COLLATERAL sends asset_type only and decodes the response", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/balance-allowance",
      json: {
        balance: "11000000",
        allowances: {
          "0x017641abfa4264121237023f9fe678bf00f60de8":
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        },
        virtual_available: "10000000",
        locked: "1000000",
      },
    });
    const out = await newClient().balanceAllowance("COLLATERAL");
    expect(out.balance).toBe("11000000");
    expect(out.virtual_available).toBe("10000000");
    expect(out.locked).toBe("1000000");
    expect(Object.keys(out.allowances)).toHaveLength(1);

    const call = getCall(calls, 0);
    expect(call.url.searchParams.get("asset_type")).toBe("COLLATERAL");
    expect(call.url.searchParams.get("token_id")).toBeNull();
    assertL2Headers(call, "/balance-allowance");
  });

  it("CONDITIONAL requires token_id; COLLATERAL forbids it", async () => {
    installFetch();
    const client = newClient();
    await expect(client.balanceAllowance("CONDITIONAL")).rejects.toThrow(ValidationError);
    await expect(client.balanceAllowance("COLLATERAL", "100")).rejects.toThrow(ValidationError);
  });

  it("updateBalanceAllowance hits /balance-allowance/update with token_id", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/balance-allowance/update",
      json: { balance: "0", allowances: {} },
    });
    await newClient().updateBalanceAllowance("CONDITIONAL", "100");
    const call = getCall(calls, 0);
    expect(call.url.searchParams.get("asset_type")).toBe("CONDITIONAL");
    expect(call.url.searchParams.get("token_id")).toBe("100");
    assertL2Headers(call, "/balance-allowance/update");
  });

  it("apiKeys decodes the proxyWallet alias", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/auth/api-keys",
      json: { apiKeys: ["k1", "k2"], address: GOLDEN_ADDR, proxyWallet: SAFE },
    });
    const info = await newClient().apiKeys();
    expect(info.apiKeys).toEqual(["k1", "k2"]);
    expect(info.proxy_wallet).toBe(SAFE);
    assertL2Headers(getCall(calls, 0), "/auth/api-keys");
  });
});

// ─── convenience helpers ─────────────────────────────────────────────────────

describe("limitOrder / marketOrder convenience", () => {
  const marketDataRoutes: Route[] = [
    { method: "GET", path: "/tick-size", json: { minimum_tick_size: "0.01" } },
    { method: "GET", path: "/fee-rate", json: { base_fee: 100 } },
  ];

  it("limitOrder fetches tick size + fee rate, defaults maker to fundingAddress, posts", async () => {
    const calls = installFetch(...marketDataRoutes, {
      method: "POST",
      path: "/order",
      json: { success: true, orderID: "snowflake-9", status: "live" },
    });
    const resp = await newClient().limitOrder({
      tokenId: "100",
      side: "BUY",
      price: "0.34",
      size: "100",
      salt: 12345n,
    });
    expect(resp.orderID).toBe("snowflake-9");

    const tickCall = calls.find((c) => c.url.pathname === "/tick-size");
    expect(tickCall?.url.searchParams.get("token_id")).toBe("100");
    const postCall = calls.find((c) => c.url.pathname === "/order");
    if (!postCall) throw new Error("no POST /order call");
    const body = JSON.parse(postCall.body) as {
      order: Record<string, string>;
      orderType: string;
    };
    expect(body.orderType).toBe("GTC");
    expect(body.order.maker).toBe(SAFE);
    expect(body.order.feeRateBps).toBe("100");
    expect(body.order.makerAmount).toBe("34000000");
    expect(body.order.takerAmount).toBe("100000000");
    expect(body.order.signatureType).toBe("2");
    // Same inputs as the golden order -> same deterministic signature.
    expect(body.order.signature).toBe(PINNED_ORDER_SIGNATURE);
    assertL2Headers(postCall, "/order");
  });

  it("limitOrder rejects a price finer than the fetched tick size before posting", async () => {
    const calls = installFetch(...marketDataRoutes);
    await expect(
      newClient().limitOrder({ tokenId: "100", side: "BUY", price: "0.345", size: "100" }),
    ).rejects.toThrow(ValidationError);
    expect(calls.some((c) => c.url.pathname === "/order")).toBe(false);
  });

  it("marketOrder converts usdw to shares and posts a FAK envelope", async () => {
    const calls = installFetch(...marketDataRoutes, {
      method: "POST",
      path: "/order",
      json: { success: true, orderID: "snowflake-10", status: "matched" },
    });
    const resp = await newClient().marketOrder({
      tokenId: "100",
      side: "BUY",
      price: "0.34",
      usdw: "34",
      salt: 12345n,
    });
    expect(resp.orderID).toBe("snowflake-10");
    const postCall = calls.find((c) => c.url.pathname === "/order");
    if (!postCall) throw new Error("no POST /order call");
    const body = JSON.parse(postCall.body) as { order: Record<string, string>; orderType: string };
    expect(body.orderType).toBe("FAK");
    // usdw 34 / price 0.34 -> 100 shares.
    expect(body.order.makerAmount).toBe("34000000");
    expect(body.order.takerAmount).toBe("100000000");
  });
});

// ─── wire helpers ────────────────────────────────────────────────────────────

describe("wire helpers", () => {
  it("signatureTypeToNumericWire maps names and passes numerics through", () => {
    expect(signatureTypeToNumericWire("EOA")).toBe("0");
    expect(signatureTypeToNumericWire("POLY_PROXY")).toBe("1");
    expect(signatureTypeToNumericWire("POLY_GNOSIS_SAFE")).toBe("2");
    expect(signatureTypeToNumericWire("2")).toBe("2");
    expect(() => signatureTypeToNumericWire("SAFE")).toThrow(ValidationError);
  });

  it("buildSendOrderRequest applies the serde skip rules", async () => {
    const signed = await goldenSignedOrder();
    const bare = buildSendOrderRequest(signed, "GTC");
    expect(bare.owner).toBeUndefined();
    expect(bare.postOnly).toBeUndefined();
    expect(bare.deferExec).toBeUndefined();
    expect(bare.order.signatureType).toBe("2");

    const full = buildSendOrderRequest(signed, "GTD", true, "owner-uuid");
    expect(full.owner).toBe("owner-uuid");
    expect(full.postOnly).toBe(true);
  });

  it("isPageEnd treats LTE= and empty cursors as end-of-stream", () => {
    expect(isPageEnd({ limit: 0, count: 0, next_cursor: "LTE=", data: [] })).toBe(true);
    expect(isPageEnd({ limit: 0, count: 0, next_cursor: "", data: [] })).toBe(true);
    expect(isPageEnd({ limit: 0, count: 0, next_cursor: "abc=", data: [] })).toBe(false);
  });
});

// ─── L2 precondition errors ──────────────────────────────────────────────────

describe("L2 preconditions", () => {
  it("rejects L2 calls without credentials", async () => {
    installFetch();
    const client = new ClobClient({ baseUrl: BASE, signer: newSigner() });
    await expect(client.cancelAll()).rejects.toThrow(/credentials/);
  });

  it("rejects L2 calls without a signer address", async () => {
    installFetch();
    const client = new ClobClient({ baseUrl: BASE, credentials: CREDS });
    await expect(client.cancelAll()).rejects.toThrow(/EOA address/);
  });

  it("setCredentials enables L2 calls after construction", async () => {
    installFetch({
      method: "DELETE",
      path: "/cancel-all",
      json: { canceled: [], not_canceled: {} },
    });
    const client = new ClobClient({ baseUrl: BASE, signer: newSigner() });
    client.setCredentials(CREDS);
    expect((await client.cancelAll()).canceled).toEqual([]);
  });
});
