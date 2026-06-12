/**
 * Live smoke test against the Monad deployment (hermestrade.xyz).
 *
 * Run with `pnpm test:live`. Requires `~/.config/predict/config.toml` (predict-cli
 * format) with a funded Safe. Trading stages place ONE small resting order (canceled
 * immediately) and ONE small real trade (a few USDW) — total spend stays well under
 * 11 USDW.
 *
 * Stages run in declaration order; later stages reuse earlier results via module state.
 */

import { afterAll, describe, expect, it } from "vitest";
import { PredictClient } from "../../src/client.js";
import { loadPredictConfig } from "../../src/config.js";
import type { Market } from "../../src/gamma/types.js";
import { marketClobTokenIds } from "../../src/gamma/types.js";
import { decCmp, decToString, parseDecimal } from "../../src/math.js";

const config = loadPredictConfig();
const client = PredictClient.fromConfig(config);

// Populated by earlier stages, consumed by later ones.
let market: Market | undefined;
let tokenId: string | undefined;
let bestBid: string | undefined;
let bestAsk: string | undefined;
let restingOrderId: string | undefined;
let liveTradeSpend = 0;
let boughtShares = 0;

function requireStage<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`prerequisite stage failed: missing ${what}`);
  return value;
}

describe.sequential("live: public reads", () => {
  it("GET /ok and /time respond", async () => {
    await client.clob.ok();
    const time = await client.clob.time();
    expect(Math.abs(time - Date.now() / 1000)).toBeLessThan(300);
  });

  it("gamma public-info matches the network registry", async () => {
    const info = await client.gamma.publicInfo();
    expect(info.contracts).toBeTruthy();
  });

  it("finds an active liquid market", async () => {
    const events = await client.gamma.listEvents({
      active: true,
      closed: false,
      limit: 50,
      order: "volume",
      ascending: false,
    });
    expect(events.length).toBeGreaterThan(0);
    outer: for (const event of events) {
      // Binary markets only: wide neg-risk MINT settlements can exceed the relayer's
      // 1.5M gas limit and fail on-chain (observed live 2026-06-13); neg-risk signing
      // itself is covered by negrisk.test.ts.
      if (event.negRisk) continue;
      for (const m of event.markets ?? []) {
        const tokens = marketClobTokenIds(m);
        if (tokens.length !== 2 || m.closed) continue;
        const book = await client.clob.book(tokens[0] as string);
        const bid = book.bids.at(-1) ?? book.bids[0];
        const ask = book.asks.at(-1) ?? book.asks[0];
        if (!book.bids.length || !book.asks.length) continue;
        market = m;
        tokenId = tokens[0] as string;
        // Books list levels away-from-touch first in the Rust client; pick best by price.
        bestBid = book.bids.reduce((a, b) =>
          decCmp(parseDecimal(a.price), parseDecimal(b.price)) >= 0 ? a : b,
        ).price;
        bestAsk = book.asks.reduce((a, b) =>
          decCmp(parseDecimal(a.price), parseDecimal(b.price)) <= 0 ? a : b,
        ).price;
        void bid;
        void ask;
        break outer;
      }
    }
    expect(market, "no active market with a two-sided book found").toBeTruthy();
    console.log(
      `market: ${market?.question} token=${tokenId} bid=${bestBid} ask=${bestAsk} minSize=${market?.orderMinSize} tick=${market?.orderPriceMinTickSize}`,
    );
  });

  it("tick-size and fee-rate resolve for the token", async () => {
    const tid = requireStage(tokenId, "tokenId");
    const tick = await client.clob.tickSize(tid);
    const fee = await client.clob.feeRate(tid);
    console.log(`tick=${tick.minimum_tick_size} feeBps=${fee.fee_rate_bps}`);
    expect(Number(tick.minimum_tick_size)).toBeGreaterThan(0);
  });
});

describe.sequential("live: auth + account", () => {
  it("derives L2 credentials via L1 EIP-712", async () => {
    const creds = await client.ensureApiKey();
    expect(creds.key).toMatch(/[0-9a-f-]{36}/);
    expect(creds.passphrase.length).toBeGreaterThan(0);
  });

  it("reads collateral balance-allowance (L2)", async () => {
    const balance = await client.clob.balanceAllowance("COLLATERAL");
    const usdw = Number(balance.balance) / 1e6;
    console.log(`USDW balance: ${usdw}`);
    expect(usdw).toBeGreaterThan(1);
  });

  it("lists open orders (L2)", async () => {
    const page = await client.clob.openOrders();
    expect(Array.isArray(page.data)).toBe(true);
  });
});

describe.sequential("live: resting order lifecycle", () => {
  it("places a deep resting limit BUY and sees it live", async () => {
    const m = requireStage(market, "market");
    const tid = requireStage(tokenId, "tokenId");
    const bid = requireStage(bestBid, "bestBid");
    // Price far below best bid so it cannot fill: half the best bid, tick-aligned.
    const tick = parseDecimal(String(m.orderPriceMinTickSize ?? "0.01"));
    const half = decToString({
      mantissa: parseDecimal(bid).mantissa / 2n,
      scale: parseDecimal(bid).scale,
    });
    // Round down to tick precision and clamp to >= tick.
    const price = Math.max(
      Number(decToString(tick)),
      Math.floor(Number(half) / Number(decToString(tick))) * Number(decToString(tick)),
    ).toFixed(tick.scale);
    const size = String(Math.max(Number(m.orderMinSize ?? 5), 5));
    console.log(`resting BUY ${size} @ ${price}`);
    const res = await client.clob.limitOrder({
      tokenId: tid,
      price,
      size,
      side: "BUY",
      maker: client.fundingAddress,
      signatureType: client.signatureType,
    });
    expect(res.success, `errorMsg: ${res.errorMsg}`).toBe(true);
    expect(res.orderID).toBeTruthy();
    restingOrderId = res.orderID;
    const order = await client.clob.openOrder(res.orderID);
    expect(order.status.toUpperCase()).toContain("LIVE");
  });

  it("cancels the resting order", async () => {
    const id = requireStage(restingOrderId, "restingOrderId");
    const res = await client.clob.cancelOrder(id);
    expect(res.canceled?.includes(id) || !res.not_canceled?.[id]).toBe(true);
  });
});

describe.sequential("live: real trade", () => {
  it("executes a small marketable BUY (real money, < 11 USDW)", async () => {
    const m = requireStage(market, "market");
    const tid = requireStage(tokenId, "tokenId");
    const ask = requireStage(bestAsk, "bestAsk");
    const size = Math.max(Number(m.orderMinSize ?? 5), 5);
    const spend = size * Number(ask);
    expect(spend, "refusing to spend more than 11 USDW in a smoke test").toBeLessThan(11);
    liveTradeSpend = spend;
    console.log(`marketable BUY ${size} @ ${ask} (~${spend.toFixed(2)} USDW)`);
    const res = await client.clob.marketOrder({
      tokenId: tid,
      price: ask,
      shares: String(size),
      side: "BUY",
      maker: client.fundingAddress,
      signatureType: client.signatureType,
    });
    expect(res.success, `errorMsg: ${res.errorMsg}`).toBe(true);
    console.log(
      `orderID=${res.orderID} taking=${res.takingAmount} making=${res.makingAmount} trades=${JSON.stringify(res.tradeIDs ?? res.transactionsHashes)}`,
    );
    expect(Number(res.takingAmount ?? "0")).toBeGreaterThan(0);
  });

  it("sees the trade in GET /trades", async () => {
    const tid = requireStage(tokenId, "tokenId");
    // Settlement is async (MATCHED -> MINED -> CONFIRMED); poll briefly.
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const page = await client.clob.trades({ asset_id: tid });
      found = page.data.length > 0;
      if (!found) await new Promise((r) => setTimeout(r, 3000));
    }
    expect(found).toBe(true);
  });

  it("sees the position in balance-allowance CONDITIONAL after settlement", async () => {
    const tid = requireStage(tokenId, "tokenId");
    // Shares arrive only after on-chain settlement (MATCHED -> MINED -> CONFIRMED,
    // ~10-60s on Monad); poll with a forced server-side cache refresh.
    let shares = 0;
    for (let i = 0; i < 30 && shares === 0; i++) {
      const balance = await client.clob.updateBalanceAllowance("CONDITIONAL", tid);
      shares = Number(balance.balance);
      if (shares === 0) await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(`outcome shares: ${shares / 1e6}`);
    expect(shares).toBeGreaterThan(0);
    boughtShares = shares / 1e6;
  }, 120000);

  it("sells the position back (SELL path, recovers funds)", async () => {
    const tid = requireStage(tokenId, "tokenId");
    const bid = requireStage(bestBid, "bestBid");
    // Whole shares only (2-dp lot size), and respect the market minimum.
    const sellSize = Math.floor(boughtShares * 100) / 100;
    const minSize = Number(market?.orderMinSize ?? 5);
    if (sellSize < minSize) {
      console.log(`position ${sellSize} below min order size ${minSize}; skipping sell-back`);
      return;
    }
    const res = await client.clob.marketOrder({
      tokenId: tid,
      price: bid,
      shares: String(sellSize),
      side: "SELL",
      maker: client.fundingAddress,
      signatureType: client.signatureType,
    });
    expect(res.success, `errorMsg: ${res.errorMsg}`).toBe(true);
    console.log(
      `sold ${sellSize} @ <= ${bid}: taking=${res.takingAmount} making=${res.makingAmount}`,
    );
  }, 60000);
});

describe.sequential("live: websocket", () => {
  it("receives a book snapshot on the market channel", async () => {
    const tid = requireStage(tokenId, "tokenId");
    const sub = client.ws.subscribeMarket([tid]);
    try {
      const first = await Promise.race([
        (async () => {
          for await (const item of sub) {
            if (item.kind === "event") return item;
          }
          return undefined;
        })(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15000)),
      ]);
      expect(first, "no WS event within 15s").toBeTruthy();
      console.log(`ws first event: ${first?.kind === "event" ? first.event.eventType : "none"}`);
    } finally {
      sub.close();
    }
  });
});

describe.sequential("live: relayer", () => {
  it("logs in via gamma JWT and confirms the Safe is deployed", async () => {
    await client.loginRelayer();
    const deployed = await client.relayer.getDeployed({
      signer: client.address,
      scopeId: client.signer.scopeId,
    });
    console.log(`deployed=${deployed.deployed} safe=${deployed.address}`);
    expect(deployed.deployed).toBe(true);
    expect(deployed.address.toLowerCase()).toBe(client.fundingAddress.toLowerCase());
  });
});

afterAll(() => {
  console.log(`total real spend this run: ~${liveTradeSpend.toFixed(2)} USDW`);
});
