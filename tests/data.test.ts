/**
 * Offline tests for DataClient: URL paths, query-param names, and the `{data: [...]}`
 * envelope unwrapping. Wire expectations are pinned to predict-rs `data/client.rs`
 * (live-verified): `user=` for wallet endpoints except /user-pnl (`user_address=`),
 * `market=` for market endpoints including /v1/market-positions. fetch is mocked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DataClient } from "../src/data/client.js";
import type { Position } from "../src/data/types.js";
import { ApiError } from "../src/errors.js";

const BASE = "https://data-api.example.test";

interface RecordedCall {
  url: URL;
  method: string;
}

function installFetch(body: unknown, status = 200): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), method: init?.method ?? "GET" });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const POSITION: Position = {
  proxyWallet: "0x7e63",
  asset: "1234",
  conditionId: "0xcid",
  size: 5.0,
  avgPrice: 0.09,
  initialValue: 0.45,
  currentValue: 0.495,
  cashPnl: 0.045,
  percentPnl: 10.0,
  totalBought: 0.45,
  realizedPnl: 0.0,
  percentRealizedPnl: 0.0,
  curPrice: 0.099,
  redeemable: false,
  mergeable: true,
  title: "Q?",
  slug: "q",
  icon: "i",
  eventSlug: "e",
  outcome: "Yes",
  outcomeIndex: 0,
  oppositeOutcome: "No",
  oppositeAsset: "5678",
  endDate: "2026-12-31",
  negativeRisk: true,
};

describe("DataClient envelope endpoints", () => {
  it("positions unwraps {data: [...]} and sends user/limit/offset", async () => {
    const calls = installFetch({ data: [POSITION] });
    const out = await new DataClient(BASE).positions("0xabc", 25, 50);
    expect(out).toEqual([POSITION]);
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/positions");
    expect(url?.searchParams.get("user")).toBe("0xabc");
    expect(url?.searchParams.get("limit")).toBe("25");
    expect(url?.searchParams.get("offset")).toBe("50");
  });

  it("positions omits offset when not provided and tolerates a missing data key", async () => {
    const calls = installFetch({});
    const out = await new DataClient(BASE).positions("0xabc", 25);
    expect(out).toEqual([]);
    expect(calls[0]?.url.searchParams.has("offset")).toBe(false);
  });

  it("closedPositions and activity use the same envelope + pagination", async () => {
    const calls = installFetch({ data: [] });
    const data = new DataClient(BASE);
    await data.closedPositions("0xabc", 10);
    await data.activity("0xabc", 10, 20);
    expect(calls[0]?.url.pathname).toBe("/closed-positions");
    expect(calls[0]?.url.searchParams.get("user")).toBe("0xabc");
    expect(calls[1]?.url.pathname).toBe("/activity");
    expect(calls[1]?.url.searchParams.get("offset")).toBe("20");
  });

  it("marketPositions queries market=<conditionId> with the envelope", async () => {
    const calls = installFetch({
      data: [{ token: "111", conditionId: "0xc", positions: [] }],
    });
    const out = await new DataClient(BASE).marketPositions("0xc", 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.token).toBe("111");
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/v1/market-positions");
    expect(url?.searchParams.get("market")).toBe("0xc");
    expect(url?.searchParams.get("limit")).toBe("5");
    expect(url?.searchParams.has("conditionId")).toBe(false);
  });
});

describe("DataClient flat-array endpoints", () => {
  it("trades returns the flat array with the fee extension field", async () => {
    const trade = {
      proxyWallet: "0x",
      side: "BUY",
      asset: "1",
      conditionId: "0xc",
      size: 5.0,
      price: 0.09,
      timestamp: 1779243592,
      title: "Q",
      slug: "q",
      icon: "",
      eventSlug: "e",
      outcome: "Yes",
      outcomeIndex: 0,
      name: "",
      pseudonym: "Quick Kudu",
      bio: "",
      profileImage: "",
      profileImageOptimized: "",
      transactionHash: "0x5657",
      fee: 0.01,
    };
    const calls = installFetch([trade]);
    const out = await new DataClient(BASE).trades("0xabc", 25);
    expect(out[0]?.fee).toBe(0.01);
    expect(out[0]?.pseudonym).toBe("Quick Kudu");
    expect(calls[0]?.url.pathname).toBe("/trades");
    expect(calls[0]?.url.searchParams.get("user")).toBe("0xabc");
  });

  it("holders queries market= with optional limit", async () => {
    const calls = installFetch([{ token: "111", holders: [] }]);
    const data = new DataClient(BASE);
    await data.holders("0xc");
    expect(calls[0]?.url.pathname).toBe("/holders");
    expect(calls[0]?.url.searchParams.get("market")).toBe("0xc");
    expect(calls[0]?.url.searchParams.has("limit")).toBe(false);
    await data.holders("0xc", 7);
    expect(calls[1]?.url.searchParams.get("limit")).toBe("7");
  });

  it("oi / live-volume / traded / unwrap-requests use their dedicated params", async () => {
    const calls = installFetch([]);
    const data = new DataClient(BASE);

    await data.openInterest("0xc");
    expect(calls[0]?.url.pathname).toBe("/oi");
    expect(calls[0]?.url.searchParams.get("market")).toBe("0xc");

    await data.liveVolume("42");
    expect(calls[1]?.url.pathname).toBe("/live-volume");
    expect(calls[1]?.url.searchParams.get("id")).toBe("42");

    await data.unwrapRequests("0xsafe", true);
    expect(calls[2]?.url.pathname).toBe("/unwrap-requests");
    expect(calls[2]?.url.searchParams.get("safe")).toBe("0xsafe");
    expect(calls[2]?.url.searchParams.get("claimed")).toBe("true");

    await data.unwrapRequests("0xsafe");
    expect(calls[3]?.url.searchParams.has("claimed")).toBe(false);
  });

  it("traded decodes {traded, user}", async () => {
    const calls = installFetch({ traded: 12, user: "0xabc" });
    const out = await new DataClient(BASE).traded("0xabc");
    expect(out.traded).toBe(12);
    expect(calls[0]?.url.pathname).toBe("/traded");
    expect(calls[0]?.url.searchParams.get("user")).toBe("0xabc");
  });
});

describe("DataClient time-series and aggregate endpoints", () => {
  it("pricesHistory sends market/interval/fidelity", async () => {
    const calls = installFetch({ history: [{ t: 1779243592, p: 0.5 }] });
    const out = await new DataClient(BASE).pricesHistory("123", "1d", 3600);
    expect(out.history?.[0]?.p).toBe(0.5);
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/prices-history");
    expect(url?.searchParams.get("market")).toBe("123");
    expect(url?.searchParams.get("interval")).toBe("1d");
    expect(url?.searchParams.get("fidelity")).toBe("3600");
  });

  it("userPnl uses user_address= (not user=)", async () => {
    const calls = installFetch([{ t: 1, p: 2.5 }]);
    const out = await new DataClient(BASE).userPnl("0xabc", "1w", "12h");
    expect(out[0]?.p).toBe(2.5);
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/user-pnl");
    expect(url?.searchParams.get("user_address")).toBe("0xabc");
    expect(url?.searchParams.has("user")).toBe(false);
    expect(url?.searchParams.get("interval")).toBe("1w");
    expect(url?.searchParams.get("fidelity")).toBe("12h");
  });

  it("stats hits /stats with no query", async () => {
    const calls = installFetch({
      totalVolume: 1.0,
      volume24h: 0.5,
      totalTrades: 100,
      trades24h: 5,
      activeMarkets: 7,
      openInterest: 12.34,
    });
    const out = await new DataClient(BASE).stats();
    expect(out.activeMarkets).toBe(7);
    expect(calls[0]?.url.pathname).toBe("/stats");
    expect(calls[0]?.url.search).toBe("");
  });

  it("leaderboard sends timePeriod/orderBy/limit/offset and decodes the wrapped envelope", async () => {
    const calls = installFetch({
      data: [
        {
          rank: "1",
          proxyWallet: "0x1",
          userName: "alice",
          profileImage: "",
          xUsername: "",
          verifiedBadge: false,
          pnl: 1234.5,
          vol: 9876.0,
        },
      ],
      biggestWins: [
        {
          username: "alice",
          avatar: "",
          address: "0x1",
          title: "Q?",
          slug: "q",
          eventSlug: "e",
          entryValue: 1.0,
          exitValue: 50.0,
          profit: 49.0,
        },
      ],
    });
    const out = await new DataClient(BASE).leaderboard({
      timePeriod: "WEEK",
      orderBy: "VOL",
      limit: 10,
      offset: 20,
    });
    expect(out.data).toHaveLength(1);
    expect(out.biggestWins?.[0]?.profit).toBe(49.0);
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/v1/leaderboard");
    expect(url?.searchParams.get("timePeriod")).toBe("WEEK");
    expect(url?.searchParams.get("orderBy")).toBe("VOL");
    expect(url?.searchParams.get("limit")).toBe("10");
    expect(url?.searchParams.get("offset")).toBe("20");
  });
});

describe("DataClient error handling", () => {
  it("surfaces non-2xx responses as ApiError", async () => {
    installFetch({ error: "boom" }, 500);
    const err = await new DataClient(BASE)
      .stats()
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).path).toBe("/stats");
  });
});
