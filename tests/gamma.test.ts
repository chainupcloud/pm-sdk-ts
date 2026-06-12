/**
 * Offline tests for GammaClient: URL paths, query-param assembly, markets-information
 * body shapes, and the /auth/nonce → EIP-712 LoginMessage → /auth/login flow. Wire
 * expectations are pinned to predict-rs `gamma/client.rs` / `Client::jwt_login` and the
 * gamma-service handlers. fetch is mocked — nothing hits the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictSigner } from "../src/crypto/signer.js";
import { ApiError } from "../src/errors.js";
import { GammaClient } from "../src/gamma/client.js";
import type { LoginRequestBody, Market } from "../src/gamma/types.js";
import { marketClobTokenIds, parseJsonArrayString } from "../src/gamma/types.js";
import { scopeIdFromHex } from "../src/types.js";

const BASE = "https://gamma-api.example.test";

interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  bodyText: string | undefined;
}

type Responder = (call: RecordedCall) => { status?: number; json?: unknown; text?: string };

function installFetch(responder: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call: RecordedCall = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        bodyText: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      const out = responder(call);
      const body = out.text !== undefined ? out.text : JSON.stringify(out.json ?? {});
      return new Response(body, {
        status: out.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GammaClient metadata endpoints", () => {
  it("health and public-info hit root paths", async () => {
    const calls = installFetch((call) => {
      if (call.url.pathname === "/health") {
        return { json: { service: "gamma-api", status: "ok", timestamp: 1700000000000 } };
      }
      return {
        json: {
          brand: { title: "Demo", logo: "" },
          chain: { chainId: 143 },
          contracts: {
            exchangeAddress: "0x01",
            negRiskExchangeAddress: "0x02",
            ctfAddress: "0x03",
            collateralToken: "0x04",
          },
          loginStatement: "Welcome",
          walletConnectProjectId: "",
        },
      };
    });
    const gamma = new GammaClient(BASE);

    const health = await gamma.health();
    expect(health.status).toBe("ok");
    expect(calls[0]?.url.pathname).toBe("/health");

    const info = await gamma.publicInfo();
    expect(calls[1]?.url.pathname).toBe("/public-info");
    expect(info.contracts.exchangeAddress).toBe("0x01");
    expect(info.loginStatement).toBe("Welcome");
  });

  it("listEvents serializes filters with snake_case wire keys", async () => {
    const calls = installFetch(() => ({ json: [{ id: "1", title: "E" }] }));
    const gamma = new GammaClient(BASE);

    const events = await gamma.listEvents({
      limit: 5,
      offset: 10,
      order: "created_at",
      ascending: true,
      active: true,
      tagId: 42,
      startDateMin: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(events).toHaveLength(1);

    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/events");
    expect(url?.searchParams.get("limit")).toBe("5");
    expect(url?.searchParams.get("offset")).toBe("10");
    expect(url?.searchParams.get("order")).toBe("created_at");
    expect(url?.searchParams.get("ascending")).toBe("true");
    expect(url?.searchParams.get("active")).toBe("true");
    expect(url?.searchParams.get("tag_id")).toBe("42");
    expect(url?.searchParams.get("start_date_min")).toBe("2026-06-01T00:00:00.000Z");
    // Unset filters must not appear at all.
    expect(url?.searchParams.has("closed")).toBe(false);
    expect(url?.searchParams.has("featured")).toBe(false);
  });

  it("event and tag lookups use path parameters", async () => {
    const calls = installFetch(() => ({ json: { id: "7" } }));
    const gamma = new GammaClient(BASE);

    await gamma.getEvent("123");
    await gamma.getEventBySlug("world-cup-2026");
    await gamma.eventTags("9");
    await gamma.getTag("7");
    await gamma.getTagBySlug("sports");

    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/events/123",
      "/events/slug/world-cup-2026",
      "/events/9/tags",
      "/tags/7",
      "/tags/slug/sports",
    ]);
  });

  it("listTags passes pagination and is_carousel", async () => {
    const calls = installFetch(() => ({ json: [] }));
    await new GammaClient(BASE).listTags({ limit: 100, isCarousel: true });
    const url = calls[0]?.url;
    expect(url?.pathname).toBe("/tags");
    expect(url?.searchParams.get("limit")).toBe("100");
    expect(url?.searchParams.get("is_carousel")).toBe("true");
    expect(url?.searchParams.has("offset")).toBe(false);
  });

  it("getMarket adds include_tag=true only when requested", async () => {
    const calls = installFetch(() => ({
      json: { id: "55", conditionId: "0xabc", clobTokenIds: '["123","456"]' },
    }));
    const gamma = new GammaClient(BASE);

    const market = await gamma.getMarket("55", true);
    expect(calls[0]?.url.pathname).toBe("/markets/55");
    expect(calls[0]?.url.searchParams.get("include_tag")).toBe("true");
    expect(marketClobTokenIds(market)).toEqual(["123", "456"]);

    await gamma.getMarketBySlug("foo-bar");
    expect(calls[1]?.url.pathname).toBe("/markets/slug/foo-bar");
    expect(calls[1]?.url.search).toBe("");

    await gamma.marketTags("55");
    expect(calls[2]?.url.pathname).toBe("/markets/55/tags");
  });

  it("marketsInformation POSTs the filter body verbatim", async () => {
    const calls = installFetch(() => ({ json: [] }));
    await new GammaClient(BASE).marketsInformation({ clobTokenIds: ["1"] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/markets/information");
    expect(JSON.parse(calls[0]?.bodyText ?? "")).toEqual({ clobTokenIds: ["1"] });
  });

  it("getMarketByConditionId posts conditionIds and returns the first market", async () => {
    const calls = installFetch(() => ({
      json: [{ id: "9", conditionId: "0xcid" }],
    }));
    const gamma = new GammaClient(BASE);
    const market = await gamma.getMarketByConditionId("0xcid");
    expect(JSON.parse(calls[0]?.bodyText ?? "")).toEqual({ conditionIds: ["0xcid"] });
    expect(market?.id).toBe("9");
  });

  it("getMarketByConditionId returns null on empty result", async () => {
    installFetch(() => ({ json: [] }));
    const market = await new GammaClient(BASE).getMarketByConditionId("0xmissing");
    expect(market).toBeNull();
  });

  it("getMarketsByIds posts numeric ids and rejects non-numeric ones", async () => {
    const calls = installFetch(() => ({ json: [] }));
    const gamma = new GammaClient(BASE);
    await gamma.getMarketsByIds(["12", 34]);
    expect(JSON.parse(calls[0]?.bodyText ?? "")).toEqual({ id: [12, 34] });

    await expect(gamma.getMarketsByIds(["0xnot-numeric"])).rejects.toThrow("not numeric");
    expect(await gamma.getMarketsByIds([])).toEqual([]);
    // Empty input short-circuits without a request.
    expect(calls).toHaveLength(1);
  });

  it("getToken resolves outcome index and upstream ext id from clobTokenIds", async () => {
    const market: Market = {
      id: "55",
      conditionId: "0xc",
      clobTokenIds: '["111","222"]',
      upstreamTokenExtIds: '["up-yes","up-no"]',
    };
    const calls = installFetch(() => ({ json: [market] }));
    const gamma = new GammaClient(BASE);

    const token = await gamma.getToken("222");
    expect(JSON.parse(calls[0]?.bodyText ?? "")).toEqual({ clobTokenIds: ["222"] });
    expect(token).toEqual({
      tokenId: "222",
      marketId: "55",
      outcomeIndex: 1,
      upstreamTokenExtId: "up-no",
      market,
    });

    expect(await gamma.getToken("999")).toBeNull();
  });

  it("surfaces non-2xx responses as ApiError with status and path", async () => {
    installFetch(() => ({ status: 404, json: { code: 40400, message: "not found" } }));
    const err = await new GammaClient(BASE)
      .getTag("99999")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).path).toBe("/tags/99999");
  });
});

describe("GammaClient auth", () => {
  // Deterministic test key (no funds, test-only).
  const PRIVATE_KEY = `0x${"01".repeat(32)}`;
  const NONCE_RESPONSE = {
    nonce: "a1b2c3d4e5f60718293a4b5c",
    scopeId: `0x${"00".repeat(31)}2a`,
    issuedAt: "2026-06-12T08:00:00Z",
    chainId: 143,
    statement: "Welcome to the demo tenant",
  };

  it("getNonce lowercases the address query param", async () => {
    const calls = installFetch(() => ({ json: NONCE_RESPONSE }));
    const nonce = await new GammaClient(BASE).getNonce(
      "0xABCDEF0123456789abcdef0123456789ABCDEF01",
    );
    expect(calls[0]?.url.pathname).toBe("/auth/nonce");
    expect(calls[0]?.url.searchParams.get("address")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(nonce.nonce).toBe(NONCE_RESPONSE.nonce);
    expect(nonce.chainId).toBe(143);
  });

  it("login signs the LoginMessage from the nonce response and posts the exact body", async () => {
    const calls = installFetch((call) => {
      if (call.url.pathname === "/auth/nonce") return { json: NONCE_RESPONSE };
      return { json: { token: "jwt-token-value" } };
    });
    const signer = new PredictSigner(PRIVATE_KEY, { chainId: 143 });
    const gamma = new GammaClient(BASE);

    const out = await gamma.login(signer, "hermestrade.xyz", "https://hermestrade.xyz");
    expect(out.token).toBe("jwt-token-value");

    // Step 1: nonce fetched for the signer's lowercase address.
    expect(calls[0]?.url.pathname).toBe("/auth/nonce");
    expect(calls[0]?.url.searchParams.get("address")).toBe(signer.address);

    // Step 2/3: login body shape { signature, messageParams } per predict-rs jwt_login.
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url.pathname).toBe("/auth/login");
    const body = JSON.parse(calls[1]?.bodyText ?? "") as LoginRequestBody;
    expect(body.messageParams).toEqual({
      address: signer.address,
      nonce: NONCE_RESPONSE.nonce,
      scopeId: NONCE_RESPONSE.scopeId, // raw string from the nonce response, verbatim
      issuedAt: NONCE_RESPONSE.issuedAt,
      domain: "hermestrade.xyz",
      uri: "https://hermestrade.xyz",
      chainId: 143,
    });

    // The signature must match signer.signLoginMessage over the same params.
    const expected = await signer.signLoginMessage({
      wallet: signer.address,
      nonce: NONCE_RESPONSE.nonce,
      scopeId: scopeIdFromHex(NONCE_RESPONSE.scopeId),
      issuedAt: NONCE_RESPONSE.issuedAt,
      domain: "hermestrade.xyz",
      uri: "https://hermestrade.xyz",
      chainId: NONCE_RESPONSE.chainId,
    });
    expect(body.signature).toBe(expected);
    // 65-byte signature with v normalized to {27, 28}.
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const v = Number.parseInt(body.signature.slice(130, 132), 16);
    expect([27, 28]).toContain(v);
  });

  it("refreshToken posts the bearer header with no body", async () => {
    const calls = installFetch(() => ({ json: { token: "fresh" } }));
    const out = await new GammaClient(BASE).refreshToken("old-token");
    expect(out.token).toBe("fresh");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/auth/refresh");
    expect(calls[0]?.headers.authorization).toBe("Bearer old-token");
    expect(calls[0]?.bodyText).toBeUndefined();
  });

  it("profile endpoints: get by address, public profile, authed upsert", async () => {
    const calls = installFetch(() => ({ json: { id: "1", name: "alice" } }));
    const gamma = new GammaClient(BASE);

    const profile = await gamma.getProfile("0xabc");
    expect(calls[0]?.url.pathname).toBe("/profiles/user_address/0xabc");
    expect(profile.id).toBe("1");

    await gamma.getPublicProfile("0xabc");
    expect(calls[1]?.url.pathname).toBe("/public-profile");
    expect(calls[1]?.url.searchParams.get("address")).toBe("0xabc");

    await gamma.updateProfile("jwt", { name: "alice", bio: "hi" });
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.url.pathname).toBe("/profiles");
    expect(calls[2]?.headers.authorization).toBe("Bearer jwt");
    expect(JSON.parse(calls[2]?.bodyText ?? "")).toEqual({ name: "alice", bio: "hi" });
  });
});

describe("gamma JSON-array-string helpers", () => {
  it("parses well-formed arrays and tolerates garbage", () => {
    expect(parseJsonArrayString('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJsonArrayString("")).toEqual([]);
    expect(parseJsonArrayString(undefined)).toEqual([]);
    expect(parseJsonArrayString(null)).toEqual([]);
    expect(parseJsonArrayString("not json")).toEqual([]);
    expect(parseJsonArrayString('{"a":1}')).toEqual([]);
  });
});
