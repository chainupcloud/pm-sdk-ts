/**
 * Stream live order-book updates for a token over the market WebSocket channel.
 *
 * usage: stream-book.ts <token_id>
 */

import { getNetwork, PredictWsClient } from "pm-sdk-ts";

const tokenId = process.argv[2];
if (!tokenId) throw new Error("usage: stream-book.ts <token_id>");

const ws = new PredictWsClient(getNetwork("monad").endpoints.ws);
const sub = ws.subscribeMarket([tokenId]);

process.on("SIGINT", () => sub.close());

for await (const item of sub) {
  if (item.kind === "reset") {
    console.log("[reset] resync required (reconnect or sequence gap)");
    continue;
  }
  if (item.kind === "reconnecting" || item.kind === "error") {
    console.warn(`[${item.kind}]`);
    continue;
  }
  const event = item.event;
  switch (event.eventType) {
    case "book":
      console.log(
        `[book] bids=${event.data.bids.length} asks=${event.data.asks.length} ts=${event.data.timestamp}`,
      );
      break;
    case "price_change":
      for (const change of event.data.price_changes ?? []) {
        console.log(`[delta] ${change.side} ${change.price} x ${change.size}`);
      }
      break;
    default:
      console.log(`[${event.eventType}]`);
  }
}
