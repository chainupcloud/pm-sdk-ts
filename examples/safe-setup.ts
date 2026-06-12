/**
 * One-time Safe setup over the relayer (gasless): deploy the Safe (idempotent) and
 * grant the trading approvals (USDW -> exchanges, CTF -> exchanges, optional split
 * allowance for ConditionalTokens).
 */

import { loadPredictConfig, PredictClient } from "pm-sdk-ts";

const client = PredictClient.fromConfig(loadPredictConfig());

// The relayer accepts the gamma-service JWT (EIP-712 LoginMessage flow).
await client.loginRelayer();

const deployed = await client.relayerService.deploySafe(client.signer.scopeId);
console.log(
  `safe ${deployed.safeAddress} ${deployed.alreadyDeployed ? "(already deployed)" : "deployed"}`,
);

const result = await client.relayerService.approveAll(deployed.safeAddress, {
  includeSplitAllowance: true,
});
console.log(`approvals tx ${result.transactionId}: ${result.state}`);
