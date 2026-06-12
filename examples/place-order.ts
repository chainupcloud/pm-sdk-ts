/**
 * Place a resting limit order and cancel it. Uses the predict-cli config file
 * (~/.config/predict/config.toml) for the wallet, Safe, and scope.
 */

import { loadPredictConfig, PredictClient } from "pm-sdk-ts";

const client = PredictClient.fromConfig(loadPredictConfig());
await client.ensureApiKey(); // L1 EIP-712 -> L2 credentials (idempotent derive)

const tokenId = process.argv[2];
if (!tokenId) throw new Error("usage: place-order.ts <token_id>");

// Tick size and fee rate are fetched automatically; maker defaults to the Safe.
// Neg-risk markets are auto-detected and signed against the neg-risk exchange.
const res = await client.clob.limitOrder({
  tokenId,
  price: "0.10", // deep bid — rests on the book
  size: "5",
  side: "BUY",
  maker: client.fundingAddress,
  signatureType: client.signatureType,
});
console.log(`order ${res.orderID} status=${res.status}`);

const canceled = await client.clob.cancelOrder(res.orderID);
console.log(`canceled: ${JSON.stringify(canceled.canceled)}`);
