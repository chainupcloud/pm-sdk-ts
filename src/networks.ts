/**
 * Built-in network registry. One entry per supported deployment; `monad` is the default.
 *
 * Source of truth: predict-rs `cli/src/networks/monad.yaml` (sync when it changes) and
 * `GET https://gamma-api.hermestrade.xyz/public-info`.
 */

import type { Endpoints } from "./endpoints.js";
import { ValidationError } from "./errors.js";
import type { Address } from "./types.js";

export interface NetworkContracts {
  conditionalTokens: Address;
  ctfExchange: Address;
  negRiskCtfExchange: Address;
  negRiskAdapter: Address;
  feeModule: Address;
  negRiskFeeModule: Address;
  safeProxyFactory: Address;
  multiSend: Address;
  usdw: Address;
  /** Underlying USDC pulled by `USDWrapper.wrap()` — the deposit asset, not the collateral. */
  usdwUnderlying: Address;
  usdWrapper: Address;
}

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  gasToken: string;
  /** Tenant root domain (Host header discriminates tenants on shared backends). */
  tenant: string;
  endpoints: Required<Endpoints>;
  contracts: NetworkContracts;
  /** Collateral (USDW) and CTF outcome-token decimals. */
  collateralDecimals: number;
}

export const MONAD: NetworkConfig = {
  name: "monad",
  chainId: 143,
  rpcUrl: "https://rpc.monad.xyz",
  gasToken: "MON",
  tenant: "hermestrade.xyz",
  endpoints: {
    clob: "https://clob-api.hermestrade.xyz",
    gamma: "https://gamma-api.hermestrade.xyz",
    ws: "wss://clob-ws.hermestrade.xyz",
    data: "https://data-api.hermestrade.xyz",
    relayer: "https://relayer.hermestrade.xyz",
  },
  contracts: {
    conditionalTokens: "0xd77d550092aB455bd1b9071E4185eCbB6E8d6a2A",
    ctfExchange: "0x017641abFa4264121237023f9Fe678BF00F60De8",
    negRiskCtfExchange: "0x50b7B00EE75F8bFb5cDa892883aFb3867851c738",
    negRiskAdapter: "0x4c3Ba1A5A6BEaF4CDA6E1Dca75fF9e889A076bE8",
    feeModule: "0x383f0Bf1Ad2970A981eE5c96a892285035F59D35",
    negRiskFeeModule: "0xD1Be9D63D5cC3882e1a7a4eF0cc2213Cee1D7457",
    safeProxyFactory: "0xE401CdA9643788cb660DeB49Bd44a6401a1e6bE9",
    multiSend: "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761",
    usdw: "0xb7bD080Df56FA76ce6CA4fA737d47815f7F8e746",
    usdwUnderlying: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    usdWrapper: "0x119ED2fa6179052F04b89C7507E0681dc417D2c1",
  },
  collateralDecimals: 6,
};

const REGISTRY: Record<string, NetworkConfig> = {
  monad: MONAD,
};

export function getNetwork(name = "monad"): NetworkConfig {
  const net = REGISTRY[name];
  if (!net) {
    throw new ValidationError(
      `unknown network "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`,
    );
  }
  return net;
}
