/**
 * Offline tests for the relayer client + Safe service.
 *
 * 1. Golden parity with pm-sdk-go `pkg/relayer`: the inputs in
 *    `testdata/gen_golden.go` are reconstructed here and the resulting
 *    SafeTx / CreateProxy digests + signatures must match
 *    `fixtures/golden-relayer.json`. The golden signatures carry v ∈ {0, 1}
 *    (raw go `crypto.Sign` output); our signSafeTx / signCreateProxy return the wire
 *    convention v ∈ {27, 28}, so r||s is compared directly and v is mapped (+27).
 * 2. Mocked-fetch wire tests: submit body shapes (SAFE + SAFE-CREATE), query params,
 *    auth headers, and terminal-state polling.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256 } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxyDigest, safeTxDigest } from "../src/crypto/eip712.js";
import { PredictSigner } from "../src/crypto/signer.js";
import { RelayerTxError, ValidationError } from "../src/errors.js";
import { getNetwork } from "../src/networks.js";
import { RelayerClient } from "../src/relayer/client.js";
import { RelayerService } from "../src/relayer/service.js";
import {
  decodeRelayerTransaction,
  isFailureState,
  isTerminalState,
  relayerPaysParams,
  SubmitType,
} from "../src/relayer/types.js";
import {
  computeProxySalt,
  ctfSetApprovalForAll,
  ERC20_APPROVE_SELECTOR,
  encodeMultiSend,
  erc20Approve,
  MERGE_POSITIONS_SELECTOR,
  MULTISEND_SELECTOR,
  REDEEM_POSITIONS_SELECTOR,
  SPLIT_POSITION_SELECTOR,
  safeCall,
  ZERO_BYTES32,
} from "../src/safe/index.js";
import { type Address, type Hex, scopeIdFromHex, ZERO_ADDRESS } from "../src/types.js";

// ─── gen_golden.go inputs, reconstructed ────────────────────────────────────

const GOLDEN_KEY = "0x4646464646464646464646464646464646464646464646464646464646464646";
const GOLDEN_SIGNER = "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F";
const GOLDEN_CHAIN_ID = 11155420; // OP Sepolia
const GOLDEN_FACTORY: Address = "0x4BEb566a2bBb875b203D11192D04bB2EEF8d9041";
const GOLDEN_SCOPE = scopeIdFromHex(
  "0x083ff7c1bc4972eef065542fc562d42e91b706719b313a95bf59eb0338a97fe7",
);
// gen_golden.go writes these via common.HexToAddress (case-insensitive); they are kept
// lowercase here because viem rejects non-EIP-55 mixed case. Case never enters digests.
const GOLDEN_USDC: Address = "0x508a62bd6a37b03db215c6aab82fc1683e95abf4";
const GOLDEN_EXCHANGE: Address = "0xc6e9081ecad84afb3a772933fb865ab8a9c317d9";
const GOLDEN_SAFE: Address = "0x2100186071afd66c5d4f5108cf2bb47b13c08946";

interface GoldenVector {
  name: string;
  digest: string;
  signature: string;
  signer: string;
  notes: string;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "golden-relayer.json"), "utf8"),
) as GoldenVector[];

function vector(name: string): GoldenVector {
  const v = vectors.find((entry) => entry.name === name);
  if (!v) throw new Error(`missing golden vector ${name}`);
  return v;
}

function rs(sig: string): string {
  return sig.slice(0, 130);
}

function vByte(sig: string): number {
  return Number.parseInt(sig.slice(130, 132), 16);
}

function goldenSigner(): PredictSigner {
  return new PredictSigner(GOLDEN_KEY, { chainId: GOLDEN_CHAIN_ID, scopeId: GOLDEN_SCOPE });
}

describe("golden parity with pm-sdk-go pkg/relayer", () => {
  it("fixture key derives the fixture signer address", () => {
    expect(goldenSigner().checksumAddress).toBe(GOLDEN_SIGNER);
    for (const v of vectors) {
      expect(v.signer).toBe(GOLDEN_SIGNER);
    }
  });

  it("safe_create_zero_payment: digest + signature (v mapped 0/1 -> 27/28)", async () => {
    const v = vector("safe_create_zero_payment");
    const digest = createProxyDigest(
      {
        paymentToken: ZERO_ADDRESS,
        payment: 0n,
        paymentReceiver: ZERO_ADDRESS,
        scopeId: GOLDEN_SCOPE,
      },
      GOLDEN_FACTORY,
      GOLDEN_CHAIN_ID,
    );
    expect(digest).toBe(v.digest);

    const sig = await goldenSigner().signCreateProxy(GOLDEN_FACTORY, {
      paymentToken: ZERO_ADDRESS,
      payment: 0n,
      paymentReceiver: ZERO_ADDRESS,
      scopeId: GOLDEN_SCOPE,
    });
    expect(rs(sig)).toBe(rs(v.signature));
    expect(vByte(v.signature)).toBeLessThan(2); // raw go crypto.Sign recovery id
    expect(vByte(sig)).toBe(vByte(v.signature) + 27); // wire flows use 27/28
  });

  it("safe_tx_usdc_approve_nonce0: erc20Approve calldata + digest + signature", async () => {
    const v = vector("safe_tx_usdc_approve_nonce0");
    // gen_golden.go builds approve(exchange, MaxUint256) by hand; erc20Approve must
    // produce the identical bytes (selector 0x095ea7b3, padded address, 32 bytes 0xff).
    const calldata = erc20Approve(GOLDEN_EXCHANGE);
    expect(calldata).toBe(
      `${ERC20_APPROVE_SELECTOR}000000000000000000000000${GOLDEN_EXCHANGE.slice(2).toLowerCase()}${"ff".repeat(32)}`,
    );

    const tx = safeCall(GOLDEN_USDC, calldata, 0n);
    expect(safeTxDigest(tx, GOLDEN_SAFE, GOLDEN_CHAIN_ID)).toBe(v.digest);

    const sig = await goldenSigner().signSafeTx(GOLDEN_SAFE, tx);
    expect(rs(sig)).toBe(rs(v.signature));
    expect(vByte(sig)).toBe(vByte(v.signature) + 27);
  });

  it("safe_tx_usdc_mint_nonce7: digest + signature", async () => {
    const v = vector("safe_tx_usdc_mint_nonce7");
    const mintCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "mint",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
        },
      ],
      functionName: "mint",
      args: [GOLDEN_SAFE, 1_000_000n * 1_000_000n],
    });
    expect(mintCalldata.startsWith("0x40c10f19")).toBe(true);

    const tx = safeCall(GOLDEN_USDC, mintCalldata, 7n);
    expect(safeTxDigest(tx, GOLDEN_SAFE, GOLDEN_CHAIN_ID)).toBe(v.digest);

    const sig = await goldenSigner().signSafeTx(GOLDEN_SAFE, tx);
    expect(rs(sig)).toBe(rs(v.signature));
    expect(vByte(sig)).toBe(vByte(v.signature) + 27);
  });
});

// ─── wire types ─────────────────────────────────────────────────────────────

describe("relayer wire types", () => {
  it("SubmitType serializes with a dash", () => {
    expect(SubmitType.SAFE).toBe("SAFE");
    expect(SubmitType.SAFE_CREATE).toBe("SAFE-CREATE");
  });

  it("relayerPaysParams uses the server's safeTxnGas spelling", () => {
    const json = JSON.stringify(relayerPaysParams(true));
    expect(json).toContain('"safeTxnGas":"0"');
    expect(json).not.toContain('"safeTxGas"');
    expect(json).toContain('"operation":"1"');
    expect(JSON.stringify(relayerPaysParams(false))).toContain('"operation":"0"');
    expect(json).toContain('"gasToken":"0x0000000000000000000000000000000000000000"');
    expect(json).toContain('"refundReceiver":"0x0000000000000000000000000000000000000000"');
  });

  it("terminal / failure state classification", () => {
    expect(isTerminalState("STATE_CONFIRMED")).toBe(true);
    expect(isTerminalState("STATE_FAILED")).toBe(true);
    expect(isTerminalState("STATE_DROPPED")).toBe(true);
    expect(isTerminalState("STATE_INVALID")).toBe(true);
    expect(isTerminalState("STATE_NEW")).toBe(false);
    expect(isTerminalState("STATE_QUEUED")).toBe(false);
    expect(isTerminalState("STATE_SENT")).toBe(false);
    expect(isTerminalState("STATE_MINED")).toBe(false);
    expect(isTerminalState("STATE_EXECUTED")).toBe(false);
    expect(isFailureState("STATE_CONFIRMED")).toBe(false);
    expect(isFailureState("STATE_INVALID")).toBe(true);
  });

  it("decodeRelayerTransaction applies serde defaults and Go-field fallbacks", () => {
    const tx = decodeRelayerTransaction({
      transactionID: "tx-9",
      state: "STATE_FAILED",
      proxyAddress: "0xSafe", // pm-sdk-go field name
      errorMessage: "boom", // pm-sdk-go field name
    });
    expect(tx.transactionHash).toBe("");
    expect(tx.proxyWallet).toBe("0xSafe");
    expect(tx.error).toBe("boom");
    expect(() => decodeRelayerTransaction({ state: "STATE_NEW" })).toThrow(ValidationError);
  });
});

// ─── MultiSend packed encoding (parity with safe/multisend.rs) ─────────────

describe("encodeMultiSend", () => {
  const USDW: Address = "0xb7bD080Df56FA76ce6CA4fA737d47815f7F8e746";
  const NEG_CTF: Address = "0x50b7B00EE75F8bFb5cDa892883aFb3867851c738";

  it("rejects empty ops", () => {
    expect(() => encodeMultiSend([])).toThrow(ValidationError);
  });

  it("single approve op matches the Rust packed layout", () => {
    const approve = erc20Approve(NEG_CTF); // 68 bytes
    const encoded = encodeMultiSend([{ to: USDW, data: approve }]);
    const bytesHex = encoded.slice(2);

    // Selector.
    expect(encoded.startsWith(MULTISEND_SELECTOR)).toBe(true);
    // ABI offset word = 0x20.
    expect(bytesHex.slice(8, 72)).toBe("20".padStart(64, "0"));
    // Packed length = 1 + 20 + 32 + 32 + 68 = 153 (0x99).
    expect(BigInt(`0x${bytesHex.slice(72, 136)}`)).toBe(153n);
    // operation byte = 0 (Call), then the 20-byte to-address.
    expect(bytesHex.slice(136, 138)).toBe("00");
    expect(bytesHex.slice(138, 178)).toBe(USDW.slice(2).toLowerCase());
    // value = 0, dataLen = 68, then the calldata itself.
    expect(BigInt(`0x${bytesHex.slice(178, 242)}`)).toBe(0n);
    expect(BigInt(`0x${bytesHex.slice(242, 306)}`)).toBe(68n);
    expect(bytesHex.slice(306, 306 + 136)).toBe(approve.slice(2).toLowerCase());
    // Padded to a 32-byte boundary: 4 + 32 + 32 + 153 + 7 = 228 bytes.
    expect(bytesHex.length / 2).toBe(228);
    expect(bytesHex.endsWith("00".repeat(7))).toBe(true);
  });

  it("seven-op batch packs 7 x 153 bytes", () => {
    const ops = Array.from({ length: 7 }, () => ({
      to: USDW,
      data: erc20Approve(NEG_CTF),
    }));
    const encoded = encodeMultiSend(ops);
    expect(BigInt(`0x${encoded.slice(2).slice(72, 136)}`)).toBe(BigInt(7 * 153));
  });
});

describe("computeProxySalt", () => {
  it("is keccak256(abi.encode(user, scopeId)) with user first", () => {
    const user: Address = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
    const manual = keccak256(
      `0x${"000000000000000000000000"}${user.slice(2)}${GOLDEN_SCOPE.slice(2)}` as Hex,
    );
    expect(computeProxySalt(user, GOLDEN_SCOPE)).toBe(manual);
  });
});

// ─── mocked fetch plumbing ──────────────────────────────────────────────────

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
  /** Responses consumed in order on repeated hits (last one repeats). */
  sequence?: unknown[];
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
      let payload = route.json;
      if (route.sequence) {
        payload = route.sequence.length > 1 ? route.sequence.shift() : route.sequence[0];
      }
      return new Response(JSON.stringify(payload), { status: route.status ?? 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function getCall(calls: Recorded[], index: number): Recorded {
  const call = calls[index];
  if (!call) throw new Error(`no recorded call at index ${index}`);
  return call;
}

const BASE = "https://relayer.test.example";

// ─── RelayerClient ──────────────────────────────────────────────────────────

describe("RelayerClient", () => {
  it("bearer auth sets Authorization on every request", async () => {
    const calls = installFetch({ method: "GET", path: "/nonce", json: { nonce: "5" } });
    const client = new RelayerClient({ baseUrl: BASE, auth: { bearerJwt: "jwt-123" } });
    expect(await client.getNonce({ safe: "0x2100186071afd66c5d4f5108cf2bb47b13c08946" })).toBe(5n);
    const call = getCall(calls, 0);
    expect(call.headers.Authorization).toBe("Bearer jwt-123");
    expect(call.url.searchParams.get("address")).toBe("0x2100186071afd66c5d4f5108cf2bb47b13c08946");
  });

  it("api-key auth sets RELAYER_API_KEY (+ optional address header)", async () => {
    const calls = installFetch({ method: "GET", path: "/nonce", json: { nonce: "" } });
    const client = new RelayerClient({
      baseUrl: BASE,
      auth: { apiKey: "k-1", apiKeyAddress: "0xabc" },
    });
    // Empty nonce string decodes to 0 (Go parity: Safe not yet deployed).
    expect(
      await client.getNonce({
        signer: "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f",
        scopeId: GOLDEN_SCOPE,
      }),
    ).toBe(0n);
    const call = getCall(calls, 0);
    expect(call.headers.RELAYER_API_KEY).toBe("k-1");
    expect(call.headers.RELAYER_API_KEY_ADDRESS).toBe("0xabc");
    expect(call.headers.Authorization).toBeUndefined();
    expect(call.url.searchParams.get("signer")).toBe("0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f");
    expect(call.url.searchParams.get("scopeId")).toBe(GOLDEN_SCOPE);
    expect(call.url.searchParams.get("address")).toBeNull();
  });

  it("getNonce / getDeployed require a lookup selector", async () => {
    installFetch();
    const client = new RelayerClient({ baseUrl: BASE });
    await expect(client.getNonce({})).rejects.toThrow(ValidationError);
    await expect(client.getDeployed({})).rejects.toThrow(ValidationError);
  });

  it("getDeployed decodes deployed flag + address", async () => {
    installFetch({
      method: "GET",
      path: "/deployed",
      json: { deployed: false, address: GOLDEN_SAFE },
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const res = await client.getDeployed({ signer: "0xeoa" as Address, scopeId: GOLDEN_SCOPE });
    expect(res).toEqual({ deployed: false, address: GOLDEN_SAFE });
  });

  it("getTransaction queries by id and rejects empty ids", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/transaction",
      json: { transactionID: "tx-1", transactionHash: "0xh", state: "STATE_MINED" },
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const tx = await client.getTransaction("tx-1");
    expect(tx.state).toBe("STATE_MINED");
    expect(getCall(calls, 0).url.searchParams.get("id")).toBe("tx-1");
    await expect(client.getTransaction("")).rejects.toThrow(ValidationError);
  });

  it("getTransactions passes limit/offset and decodes the array", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/transactions",
      json: [{ transactionID: "tx-1", state: "STATE_CONFIRMED" }],
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const txs = await client.getTransactions({ limit: 10, offset: 20 });
    expect(txs).toHaveLength(1);
    const call = getCall(calls, 0);
    expect(call.url.searchParams.get("limit")).toBe("10");
    expect(call.url.searchParams.get("offset")).toBe("20");
  });

  it("getRelayPayload passes scopeId only when set", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/relay-payload",
      json: { address: "0xgas", nonce: 41 },
    });
    const client = new RelayerClient({ baseUrl: BASE });
    expect(await client.getRelayPayload(GOLDEN_SCOPE)).toEqual({ address: "0xgas", nonce: 41 });
    expect(await client.getRelayPayload()).toEqual({ address: "0xgas", nonce: 41 });
    expect(getCall(calls, 0).url.searchParams.get("scopeId")).toBe(GOLDEN_SCOPE);
    expect(getCall(calls, 1).url.search).toBe("");
  });

  it("waitForTransaction polls until STATE_CONFIRMED", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/transaction",
      sequence: [
        { transactionID: "tx-1", state: "STATE_SENT" },
        { transactionID: "tx-1", state: "STATE_MINED" },
        { transactionID: "tx-1", transactionHash: "0xfinal", state: "STATE_CONFIRMED" },
      ],
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const tx = await client.waitForTransaction("tx-1", { intervalMs: 1 });
    expect(tx.transactionHash).toBe("0xfinal");
    expect(calls).toHaveLength(3);
  });

  it("waitForTransaction throws RelayerTxError on STATE_FAILED with the server error", async () => {
    installFetch({
      method: "GET",
      path: "/transaction",
      json: { transactionID: "tx-2", state: "STATE_FAILED", error: "execution reverted" },
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const err = await client.waitForTransaction("tx-2", { intervalMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayerTxError);
    expect((err as RelayerTxError).state).toBe("STATE_FAILED");
    expect((err as RelayerTxError).message).toContain("execution reverted");
  });

  it("waitForTransaction throws RelayerTxError on STATE_DROPPED and STATE_INVALID", async () => {
    for (const state of ["STATE_DROPPED", "STATE_INVALID"]) {
      installFetch({
        method: "GET",
        path: "/transaction",
        json: { transactionID: "tx-3", state },
      });
      const client = new RelayerClient({ baseUrl: BASE });
      const err = await client.waitForTransaction("tx-3", { intervalMs: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(RelayerTxError);
      expect((err as RelayerTxError).state).toBe(state);
      vi.unstubAllGlobals();
    }
  });

  it("waitForTransaction gives up after maxAttempts with the last state", async () => {
    installFetch({
      method: "GET",
      path: "/transaction",
      json: { transactionID: "tx-4", state: "STATE_SENT" },
    });
    const client = new RelayerClient({ baseUrl: BASE });
    const err = await client
      .waitForTransaction("tx-4", { intervalMs: 1, maxAttempts: 2 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RelayerTxError);
    expect((err as RelayerTxError).message).toContain("not terminal after 2 polls");
  });
});

// ─── RelayerService ─────────────────────────────────────────────────────────

const MONAD = getNetwork("monad");

function monadSigner(): PredictSigner {
  return new PredictSigner(GOLDEN_KEY, { chainId: MONAD.chainId, scopeId: GOLDEN_SCOPE });
}

function newService(): RelayerService {
  return new RelayerService({
    client: new RelayerClient({ baseUrl: BASE, auth: { bearerJwt: "jwt-x" } }),
    signer: monadSigner(),
    network: MONAD,
    pollIntervalMs: 1,
  });
}

const SAFE_ADDR: Address = "0x2100186071afd66c5d4f5108cf2bb47b13c08946";

function safeFlowRoutes(): Recorded[] {
  return installFetch(
    { method: "GET", path: "/nonce", json: { nonce: "3" } },
    {
      method: "POST",
      path: "/submit",
      json: { transactionID: "tx-1", transactionHash: "", state: "STATE_NEW" },
    },
    {
      method: "GET",
      path: "/transaction",
      json: { transactionID: "tx-1", transactionHash: "0xhash", state: "STATE_CONFIRMED" },
    },
  );
}

describe("RelayerService — SAFE flow", () => {
  it("rejects a signer whose chainId mismatches the network", () => {
    const signer = new PredictSigner(GOLDEN_KEY, { chainId: 1 });
    expect(
      () =>
        new RelayerService({
          client: new RelayerClient({ baseUrl: BASE }),
          signer,
          network: MONAD,
        }),
    ).toThrow(ValidationError);
  });

  it("approveUsdwForExchange (single spender) submits the exact SAFE body", async () => {
    const calls = safeFlowRoutes();
    const service = newService();
    const signer = monadSigner();
    const spender = MONAD.contracts.ctfExchange;
    const result = await service.approveUsdwForExchange(SAFE_ADDR, { spenders: [spender] });

    expect(result.transactionId).toBe("tx-1");
    expect(result.transactionHash).toBe("0xhash");
    expect(result.state).toBe("STATE_CONFIRMED");

    // 1) GET /nonce in EOA + scopeId mode (pm-sdk-go ExecuteSafeTx parity).
    const nonceCall = getCall(calls, 0);
    expect(nonceCall.url.pathname).toBe("/nonce");
    expect(nonceCall.url.searchParams.get("signer")).toBe(signer.address);
    expect(nonceCall.url.searchParams.get("scopeId")).toBe(GOLDEN_SCOPE);
    expect(nonceCall.url.searchParams.get("address")).toBeNull();

    // 2) POST /submit with the wire-exact body.
    const submit = getCall(calls, 1);
    expect(submit.headers.Authorization).toBe("Bearer jwt-x");
    const body = JSON.parse(submit.body) as Record<string, unknown>;
    const usdw = MONAD.contracts.usdw.toLowerCase();
    const calldata = erc20Approve(spender);
    const expectedSig = await signer.signSafeTx(SAFE_ADDR, safeCall(usdw as Address, calldata, 3n));
    expect(body).toEqual({
      from: signer.address,
      to: usdw,
      proxyWallet: SAFE_ADDR,
      data: calldata,
      nonce: "3",
      signature: expectedSig,
      signatureParams: {
        gasPrice: "0",
        operation: "0",
        safeTxnGas: "0",
        baseGas: "0",
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
      },
      type: "SAFE",
      scopeId: GOLDEN_SCOPE,
      metadata: "approve",
    });
    const v = vByte(String(body.signature));
    expect(v === 27 || v === 28).toBe(true);

    // 3) Poll by transactionID.
    expect(getCall(calls, 2).url.searchParams.get("id")).toBe("tx-1");
  });

  it("approveAll batches through MultiSend with DELEGATECALL params", async () => {
    const calls = safeFlowRoutes();
    const service = newService();
    await service.approveAll(SAFE_ADDR, { includeSplitAllowance: true });

    const body = JSON.parse(getCall(calls, 1).body) as Record<string, unknown>;
    expect(body.to).toBe(MONAD.contracts.multiSend.toLowerCase());
    expect((body.signatureParams as Record<string, unknown>).operation).toBe("1");
    const data = String(body.data);
    expect(data.startsWith(MULTISEND_SELECTOR)).toBe(true);
    // 4 USDW.approve ops (3 exchange targets + ConditionalTokens for split) +
    // 3 CTF.setApprovalForAll ops.
    const approveHits = data.split(ERC20_APPROVE_SELECTOR.slice(2)).length - 1;
    const setApprovalHits = data.split(ctfSetApprovalForAll(SAFE_ADDR).slice(2, 10)).length - 1;
    expect(approveHits).toBe(4);
    expect(setApprovalHits).toBe(3);
  });

  it("splitPosition targets ConditionalTokens with ctf-split metadata", async () => {
    const calls = safeFlowRoutes();
    const service = newService();
    const conditionId = `0x${"aa".repeat(32)}` as Hex;
    await service.splitPosition(SAFE_ADDR, {
      conditionId,
      partition: [1n, 2n],
      amount: 1_000_000n,
    });

    const body = JSON.parse(getCall(calls, 1).body) as Record<string, unknown>;
    expect(body.to).toBe(MONAD.contracts.conditionalTokens.toLowerCase());
    expect(body.metadata).toBe("ctf-split");
    const data = String(body.data);
    expect(data.startsWith(SPLIT_POSITION_SELECTOR)).toBe(true);
    // args: collateral | parent (zero) | conditionId | offset | amount | len | 1 | 2
    expect(data).toContain(MONAD.contracts.usdw.slice(2).toLowerCase());
    expect(data).toContain("aa".repeat(32));
    expect(data).toContain(ZERO_BYTES32.slice(2));
  });

  it("mergePositions / redeemPositions use their selectors and metadata", async () => {
    const conditionId = `0x${"bb".repeat(32)}` as Hex;
    {
      const calls = safeFlowRoutes();
      await newService().mergePositions(SAFE_ADDR, {
        conditionId,
        partition: [1n, 2n],
        amount: 5n,
      });
      const body = JSON.parse(getCall(calls, 1).body) as Record<string, unknown>;
      expect(String(body.data).startsWith(MERGE_POSITIONS_SELECTOR)).toBe(true);
      expect(body.metadata).toBe("ctf-merge");
      vi.unstubAllGlobals();
    }
    {
      const calls = safeFlowRoutes();
      await newService().redeemPositions(SAFE_ADDR, { conditionId, indexSets: [1n] });
      const body = JSON.parse(getCall(calls, 1).body) as Record<string, unknown>;
      expect(String(body.data).startsWith(REDEEM_POSITIONS_SELECTOR)).toBe(true);
      expect(body.metadata).toBe("ctf-redeem");
    }
  });
});

describe("RelayerService — SAFE-CREATE flow", () => {
  it("deploySafe submits the exact SAFE-CREATE body (no nonce, data 0x)", async () => {
    const calls = installFetch(
      {
        method: "GET",
        path: "/deployed",
        json: { deployed: false, address: GOLDEN_SAFE },
      },
      {
        method: "POST",
        path: "/submit",
        json: { transactionID: "tx-c", transactionHash: "", state: "STATE_NEW" },
      },
      {
        method: "GET",
        path: "/transaction",
        json: { transactionID: "tx-c", transactionHash: "0xdeploy", state: "STATE_CONFIRMED" },
      },
    );
    const service = newService();
    const signer = monadSigner();
    const result = await service.deploySafe();

    expect(result.alreadyDeployed).toBe(false);
    expect(result.safeAddress).toBe(GOLDEN_SAFE.toLowerCase());
    expect(result.transactionId).toBe("tx-c");
    expect(result.transaction?.transactionHash).toBe("0xdeploy");

    // 1) Predicted address lookup by signer + scopeId.
    const deployedCall = getCall(calls, 0);
    expect(deployedCall.url.searchParams.get("signer")).toBe(signer.address);
    expect(deployedCall.url.searchParams.get("scopeId")).toBe(GOLDEN_SCOPE);

    // 2) SAFE-CREATE submit body.
    const body = JSON.parse(getCall(calls, 1).body) as Record<string, unknown>;
    const factory = MONAD.contracts.safeProxyFactory.toLowerCase() as Address;
    const expectedSig = await signer.signCreateProxy(factory, {
      paymentToken: ZERO_ADDRESS,
      payment: 0n,
      paymentReceiver: ZERO_ADDRESS,
      scopeId: GOLDEN_SCOPE,
    });
    expect("nonce" in body).toBe(false);
    expect(body).toEqual({
      from: signer.address,
      to: factory,
      proxyWallet: GOLDEN_SAFE.toLowerCase(),
      data: "0x",
      signature: expectedSig,
      signatureParams: {
        paymentToken: ZERO_ADDRESS,
        payment: "0",
        paymentReceiver: ZERO_ADDRESS,
        scopeId: GOLDEN_SCOPE, // full 32-byte hex — required by the relayer's verifier
      },
      type: "SAFE-CREATE",
      scopeId: GOLDEN_SCOPE,
      metadata: "safe-create",
    });
    const v = vByte(String(body.signature));
    expect(v === 27 || v === 28).toBe(true);
  });

  it("deploySafe is idempotent when the Safe already exists", async () => {
    const calls = installFetch({
      method: "GET",
      path: "/deployed",
      json: { deployed: true, address: GOLDEN_SAFE },
    });
    const result = await newService().deploySafe();
    expect(result).toEqual({
      safeAddress: GOLDEN_SAFE.toLowerCase(),
      alreadyDeployed: true,
    });
    expect(calls).toHaveLength(1); // no POST /submit
  });

  it("deploySafe requires a non-zero scope id", async () => {
    installFetch();
    const service = new RelayerService({
      client: new RelayerClient({ baseUrl: BASE }),
      signer: new PredictSigner(GOLDEN_KEY, { chainId: MONAD.chainId }),
      network: MONAD,
    });
    await expect(service.deploySafe()).rejects.toThrow(ValidationError);
  });
});
