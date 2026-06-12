/**
 * Execute a marketable order (REAL MONEY) and watch it settle.
 *
 * usage: market-order.ts <token_id> <BUY|SELL> <shares> <anchor_price>
 */

import { loadPredictConfig, PredictClient } from "pm-sdk-ts";

const [tokenId, side, shares, price] = process.argv.slice(2);
if (!tokenId || !side || !shares || !price) {
  throw new Error("usage: market-order.ts <token_id> <BUY|SELL> <shares> <anchor_price>");
}

const client = PredictClient.fromConfig(loadPredictConfig());
await client.ensureApiKey();

const res = await client.clob.marketOrder({
  tokenId,
  price, // anchor price; the server walks the book
  shares,
  side: side as "BUY" | "SELL",
  maker: client.fundingAddress,
  signatureType: client.signatureType,
});
console.log(`order=${res.orderID} taking=${res.takingAmount} making=${res.makingAmount}`);

// Trades progress MATCHED -> MINED -> CONFIRMED as settlement lands on Monad.
for (let i = 0; i < 20; i++) {
  const page = await client.clob.trades({ asset_id: tokenId, limit: 1 });
  const trade = page.data[0];
  if (trade) {
    console.log(`trade ${trade.id}: ${trade.status}`);
    if (trade.status.includes("CONFIRMED") || trade.status.includes("FAILED")) break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
