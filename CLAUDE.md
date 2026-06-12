# CLAUDE.md — pm-sdk-ts

## Language policy

**All repository content must be in English** — code, comments, docs, commit messages,
PR descriptions. (Chat replies to the user may be Chinese; repo content may not.)

## Project scope

TypeScript SDK for the prediction market platform on Monad. Counterpart of `pm-sdk-go`
and `predict-rs/clob-client`; the three SDKs must stay wire-compatible.

## Hard constraints

1. **Golden-vector parity gates every signer change.** `tests/fixtures/golden-signer.json`
   and `golden-relayer.json` are copies of pm-sdk-go testdata. Any change to
   `src/crypto/` or `src/order-builder.ts` requires `pnpm test` green. Never edit the
   fixtures to make a test pass — sync them from pm-sdk-go only.
2. **Wire shapes come from predict-rs**, which is verified against the live deployment.
   When adding an endpoint, read the Rust source first
   (`/home/ubuntu/chainup/predict-rs/clob-client/src/`); do not guess from Polymarket
   docs (upstream V1 differs: `POLY_*` headers, URL-safe base64, no scopeId).
3. **Private keys never come from environment variables** — config file or explicit
   parameter only.
4. **No hardcoded endpoints/addresses outside `src/networks.ts`.** The SDK is
   multi-tenant: scopeId + endpoints are caller-configurable; the registry carries
   per-network defaults.
5. **Known deliberate divergences from the references** (do not "fix" back):
   - Neg-risk exchange auto-detection in `ClobClient` (go/rust lack it and fail on
     neg-risk markets).
   - `updateBalanceAllowance` falls back to a plain GET when `/update` returns an
     empty body (live behavior; rust still assumes a JSON body).
   - Market-order USDW→shares conversion floor-truncates to the 2-dp lot size (rust
     errors on repeating decimals).

## Commands

- `pnpm test` — offline suite (mocked fetch / in-process WS; safe anywhere)
- `pnpm test:live` — REAL trading on Monad (~2.4 USDW round-trip per run); needs
  `~/.config/predict/config.toml` with a funded Safe
- `pnpm typecheck` / `pnpm lint` / `pnpm build` — all must pass before commit
- `pnpm example examples/<name>.ts` — run an example (build first: examples import
  the built package via self-reference)

## Git workflow

Day-to-day changes land on `dev` (`git push origin dev`); merge to `main` via PR only.
