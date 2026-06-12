/**
 * pm-sdk-ts — TypeScript SDK for the prediction market platform on Monad.
 *
 * Wire-level parity with predict-rs (Rust) and pm-sdk-go (Go); golden-vector tested.
 */

export * from "./auth.js";
// Top-level facade
export { PredictClient, type PredictClientConfig } from "./client.js";
// Service clients (classes + option types flat; wire types namespaced to avoid collisions)
export {
  ClobClient,
  type ClobClientOptions,
  type ClobLimitOrderArgs,
  type ClobMarketOrderArgs,
} from "./clob/client.js";
export * as ClobTypes from "./clob/types.js";
export * from "./config.js";
// Crypto (EIP-712 + signer + HMAC)
export * from "./crypto/eip712.js";
export { computeL2Hmac } from "./crypto/hmac.js";
export * from "./crypto/signer.js";
export { DataClient } from "./data/client.js";
export * as DataTypes from "./data/types.js";
export * from "./endpoints.js";
export * from "./errors.js";
export { GammaClient } from "./gamma/client.js";
export * as GammaTypes from "./gamma/types.js";
export * from "./http.js";
export * from "./math.js";
export * from "./networks.js";
export * from "./order-builder.js";
export {
  type RelayerAuth,
  RelayerClient,
  type RelayerClientOptions,
  type SafeLookup,
  type WaitForTransactionOptions,
} from "./relayer/client.js";
export {
  type DeploySafeResult,
  type ExecSafeTxOptions,
  type RelayerExecResult,
  RelayerService,
  type RelayerServiceOptions,
} from "./relayer/service.js";
export * as RelayerTypes from "./relayer/types.js";
export * from "./safe/index.js";
// Foundation
export * from "./types.js";
export {
  type MarketStreamItem,
  type MarketSubscribeOptions,
  MarketSubscription,
  PredictWsClient,
  type PredictWsOptions,
  type UserStreamItem,
  type UserSubscribeOptions,
  UserSubscription,
  type WsStreamItem,
} from "./ws/client.js";
export * as WsTypes from "./ws/types.js";
