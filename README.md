# pm-sdk-ts

TypeScript SDK for the prediction market platform on Monad (hermestrade.xyz and other
tenants) — CLOB trading, Gamma metadata, Data API, WebSocket streams, and gasless Safe
operations over the relayer.

Counterpart of [pm-sdk-go](https://github.com/chainupcloud/pm-sdk-go) and
[predict-rs](https://github.com/chainupcloud/predict-rs). Every signing primitive is
byte-identical with both (verified against the shared golden vectors), and the full
surface is verified live on Monad: real orders placed, matched, settled on-chain, and
sold back by the test suite in `tests/live/`.

## Features

- **CLOB trading** — limit/market orders (GTC/GTD/FOK/FAK), batch place (≤15) / cancel
  (≤3000) / replace, cancel-all, market-wide cancel, open orders + trades with cursor
  pagination, balance-allowance, heartbeats, order scoring.
- **Order signing** — EIP-712 `Order` (13 fields incl. `scopeId`) under the
  `"Prediction Market Protocol"` domain; EOA and Gnosis Safe (`POLY_GNOSIS_SAFE`)
  signature types; exact 6-decimal floor-truncation amount math.
- **Neg-risk markets** — auto-detects multi-outcome (neg-risk) tokens via `GET /book`
  and signs against the neg-risk exchange contract. Neither pm-sdk-go nor predict-rs
  supports this; both fail with `INVALID_SIGNATURE` on neg-risk markets.
- **Authentication** — L1 (EIP-712 `ClobAuth`) for API-key CRUD, L2 (HMAC-SHA256,
  standard base64) for trading, gamma JWT login (EIP-712 `LoginMessage`) for the
  relayer, all with the `PRED_*` header scheme and multi-tenant `scopeId` support.
- **Gamma + Data** — events, markets, tags, `markets/information` batch lookup,
  public-info (chain + contract registry), profiles; positions, activity, holders,
  leaderboards.
- **WebSocket** — market channel (book / price_change / last_trade_price /
  tick_size_change / best_bid_ask / new_market / market_resolved) and authenticated
  user channel (order / trade with the MATCHED → MINED → CONFIRMED lifecycle), with
  reconnect, sequence-guard RESETs, and PING/PONG keepalive.
- **Relayer / Safe** — gasless `SAFE-CREATE` deploys and `SAFE` meta-transactions:
  USDW/CTF approvals, CTF split / merge / redeem, MultiSend batching, transaction
  polling to terminal state.
- **Network registry** — built-in `monad` network (chain 143) with endpoints and all
  contract addresses; everything overridable for other tenants/deployments.

## Install

```sh
npm install pm-sdk-ts        # or pnpm add / yarn add
```

Node >= 20. Ships ESM + CJS with full type definitions. Dependencies: `viem`, `ws`.

## Quickstart

```ts
import { PredictClient, loadPredictConfig } from "pm-sdk-ts";

// Reuses the predict-cli config file (~/.config/predict/config.toml):
//   private_key, safe_address, scope_id, signature_type, network
const client = PredictClient.fromConfig(loadPredictConfig());

// One-time per wallet: derive (or create) the L2 API key via an L1 EIP-712 signature.
await client.ensureApiKey();

// Place a limit order. Tick size and fee rate are fetched automatically; neg-risk
// markets are detected and signed against the correct exchange.
const res = await client.clob.limitOrder({
  tokenId: "1234…",            // ERC-1155 outcome token id (uint256 decimal string)
  price: "0.45",
  size: "10",
  side: "BUY",
  maker: client.fundingAddress, // the Safe
  signatureType: client.signatureType,
});
console.log(res.orderID, res.status);

await client.clob.cancelOrder(res.orderID);
```

Or configure explicitly without the CLI config file:

```ts
import { PredictClient, SignatureType } from "pm-sdk-ts";

const client = new PredictClient({
  privateKey: "0x…",                       // never read from env by the SDK
  network: "monad",                        // built-in registry (chain 143)
  safeAddress: "0x…",                      // maker for POLY_GNOSIS_SAFE
  scopeId: "0x…",                          // tenant scope (optional)
  signatureType: SignatureType.POLY_GNOSIS_SAFE,
});
```

### Market data (no wallet)

```ts
import { ClobClient, GammaClient, getNetwork, marketClobTokenIds } from "pm-sdk-ts";

const net = getNetwork("monad");
const gamma = new GammaClient(net.endpoints.gamma);
const clob = new ClobClient({ baseUrl: net.endpoints.clob });

const events = await gamma.listEvents({ active: true, closed: false, limit: 10 });
const [yesToken] = marketClobTokenIds(events[0].markets![0]);
const book = await clob.book(yesToken);
```

### WebSocket streams

```ts
const sub = client.ws.subscribeMarket([tokenId]);
for await (const item of sub) {
  if (item.kind === "event" && item.event.eventType === "book") {
    console.log(item.event.data.bids, item.event.data.asks);
  }
}
```

### Safe setup over the relayer (gasless)

```ts
await client.loginRelayer();                                   // gamma JWT -> relayer
await client.relayerService.deploySafe(client.signer.scopeId); // idempotent
await client.relayerService.approveAll(client.fundingAddress, {
  includeSplitAllowance: true, // ConditionalTokens needs its own USDW allowance for split
});
```

See [examples/](./examples) for runnable scripts (`pnpm example examples/list-markets.ts`).

## Architecture

| Module | Purpose |
|---|---|
| `PredictClient` | Facade wiring one wallet + network to every service client |
| `ClobClient` | CLOB REST: market data, API keys (L1), trading (L2) |
| `GammaClient` | Events / markets / tags metadata, public-info, JWT auth, profiles |
| `DataClient` | Positions, activity, holders, leaderboards |
| `PredictWsClient` | Market + user WebSocket channels |
| `RelayerClient` / `RelayerService` | Gasless Safe deploy + meta-transactions |
| `PredictSigner` | EIP-712 signing (ClobAuth / Order / SafeTx / CreateProxy / LoginMessage) |
| `order-builder` | Validation + amount math + wire serialization |
| `networks` | Built-in network registry (monad default) |

### Wire-format invariants (parity with pm-sdk-go / predict-rs)

- `ClobAuth` domain is short-form (no `verifyingContract`); `Order` domain is
  `"Prediction Market Protocol"` v1 with the exchange as `verifyingContract`.
- ClobAuth/Order signatures carry `v ∈ {0,1}` at the signer level (golden-vector
  convention); the order wire format normalizes to `v ∈ {27,28}`.
- Signed-order JSON uses `tokenID` (mixed case), numeric-string `signatureType`
  (`"0" | "1" | "2"`), and omits `scopeId` when zero.
- L2 HMAC: SHA-256 over `timestamp + method + path + body` (path without query string),
  secret decoded as **standard** base64, output standard base64.
- Amounts: floor-truncate to 6 decimals (`Truncate(6).Shift(6)`); BUY
  `maker = price×size`, `taker = size`; SELL inverted. Size lot = 2 decimals.

## Testing

```sh
pnpm test        # offline suite (161+ tests), incl. golden-vector parity with
                 # pm-sdk-go/pkg/signer and pkg/relayer fixtures
pnpm test:live   # live verification on Monad — requires a funded config.toml.
                 # Places real orders and ONE small real trade (a few USDW),
                 # then sells the position back.
```

The golden fixtures in `tests/fixtures/` are copies of the pm-sdk-go testdata; re-sync
them when the upstream Go fixtures change.

## Platform notes

- Trades progress `MATCHED → MINED → CONFIRMED` (the same trade id is re-pushed with
  each status); on-chain settlement on Monad typically lands in 10–60 s.
- Fees on this platform are charged in shares on BUY fills (a 5-share fill at 60 bps
  credits 4.97 shares).
- Wide neg-risk MINT settlements can exceed the relayer's 1.5M gas limit and fail
  on-chain after matching (`TRADE_STATUS_FAILED`, funds returned). Observed live
  2026-06-13 on a 7-outcome market; binary and small neg-risk markets settle fine.
- `GET /balance-allowance/update` returns an empty body on the live deployment; the
  SDK transparently falls back to `GET /balance-allowance`.

## License

MIT
