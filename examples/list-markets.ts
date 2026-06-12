/**
 * List active events and inspect one market's order book. Public endpoints — no wallet.
 *
 * Run with `pnpm example examples/list-markets.ts` (or any TS runner).
 */

import { ClobClient, GammaClient, getNetwork, marketClobTokenIds } from "pm-sdk-ts";

const network = getNetwork("monad");
const gamma = new GammaClient(network.endpoints.gamma);
const clob = new ClobClient({ baseUrl: network.endpoints.clob });

const events = await gamma.listEvents({
  active: true,
  closed: false,
  limit: 5,
  order: "volume",
  ascending: false,
});

for (const event of events) {
  console.log(`\n${event.title}  (negRisk=${event.negRisk ?? false})`);
  for (const market of event.markets ?? []) {
    const [yesToken] = marketClobTokenIds(market);
    if (!yesToken) continue;
    console.log(
      `  ${market.question}  minSize=${market.orderMinSize} tick=${market.orderPriceMinTickSize}`,
    );
    const book = await clob.book(yesToken);
    const bestBid = book.bids.at(-1)?.price ?? "-";
    const bestAsk = book.asks.at(-1)?.price ?? "-";
    console.log(`    YES ${yesToken.slice(0, 16)}…  bid=${bestBid} ask=${bestAsk}`);
  }
}
