/**
 * Multi-endpoint configuration. Mirrors predict-rs `Endpoints` / pm-sdk-go `WithEndpoints`.
 *
 * A platform tenant exposes up to five service hosts, conventionally as subdomains under
 * the tenant root: `clob-api.<host>`, `gamma-api.<host>`, `clob-ws.<host>`,
 * `data-api.<host>`, `relayer-api.<host>`.
 */

import { ValidationError } from "./errors.js";

export interface Endpoints {
  clob: string;
  gamma?: string;
  ws?: string;
  data?: string;
  relayer?: string;
}

function stripProtocol(raw: string): string {
  return raw.replace(/^(https?|wss?):\/\//, "").replace(/\/+$/, "");
}

/**
 * Derive all endpoints from a tenant root host using the canonical subdomain pattern.
 * `endpointsFromTenant("hermestrade.xyz")` resolves to `https://clob-api.hermestrade.xyz`,
 * `https://gamma-api.hermestrade.xyz`, `wss://clob-ws.hermestrade.xyz`,
 * `https://data-api.hermestrade.xyz`, `https://relayer-api.hermestrade.xyz`.
 *
 * Note: a specific deployment may override individual hosts (e.g. the Monad tenant's
 * relayer lives at `relayer.hermestrade.xyz`); the built-in network registry in
 * `networks.ts` carries the authoritative values.
 */
export function endpointsFromTenant(host: string): Required<Endpoints> {
  const bare = stripProtocol(host);
  if (bare === "") {
    throw new ValidationError("tenant host is empty");
  }
  return {
    clob: `https://clob-api.${bare}`,
    gamma: `https://gamma-api.${bare}`,
    ws: `wss://clob-ws.${bare}`,
    data: `https://data-api.${bare}`,
    relayer: `https://relayer-api.${bare}`,
  };
}
