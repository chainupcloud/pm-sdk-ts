import { expect, it } from "vitest";
import { PredictClient } from "../../src/client.js";
import { loadPredictConfig } from "../../src/config.js";
import { ApiError } from "../../src/errors.js";

const NEG_RISK_TOKEN =
  "44082075851614032423193952289810091085098502931597083968632295535328819694183";

it("neg-risk order signs against NEG_RISK_EXCHANGE", async () => {
  // No explicit exchange override: ClobClient must auto-detect neg_risk from /book
  // and switch the signing domain to the network's negRiskCtfExchange.
  const client = PredictClient.fromConfig(loadPredictConfig());
  await client.ensureApiKey();
  try {
    const res = await client.clob.limitOrder({
      tokenId: NEG_RISK_TOKEN,
      price: "0.1",
      size: "5",
      side: "BUY",
      maker: client.fundingAddress,
      signatureType: client.signatureType,
    });
    console.log("neg-risk resting order:", JSON.stringify(res));
    expect(res.success).toBe(true);
    if (res.orderID) {
      const c = await client.clob.cancelOrder(res.orderID);
      console.log("canceled:", JSON.stringify(c));
    }
  } catch (e) {
    if (e instanceof ApiError) {
      throw new Error(`neg-risk order rejected: ${e.status} ${e.body}`);
    }
    throw e;
  }
}, 60000);
