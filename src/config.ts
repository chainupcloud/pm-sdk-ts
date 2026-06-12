/**
 * Loader for the predict-cli `config.toml` (written by `predict-cli wallet create` /
 * `setup`, mode 0600). Lets the SDK share credentials with the CLI:
 *
 * ```toml
 * private_key = "0x..."
 * chain_id = 143
 * scope_id = "0x..."
 * signature_type = "gnosis-safe"
 * safe_address = "0x..."
 * network = "monad"
 * ```
 *
 * Only the flat key/value subset of TOML used by the CLI is supported. The private key is
 * never read from environment variables (it would leak via /proc/<pid>/environ).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "./errors.js";
import type { Address, ScopeId, SignatureType } from "./types.js";
import { normalizeAddress, SignatureType as SignatureTypeEnum, scopeIdFromHex } from "./types.js";

export interface PredictFileConfig {
  privateKey: string;
  chainId?: number;
  scopeId?: ScopeId;
  signatureType?: SignatureType;
  safeAddress?: Address;
  network?: string;
  tenant?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "predict", "config.toml");

function parseSignatureType(raw: string): SignatureType {
  switch (raw.toLowerCase().replace(/_/g, "-")) {
    case "eoa":
    case "0":
      return SignatureTypeEnum.EOA;
    case "poly-proxy":
    case "proxy":
    case "1":
      return SignatureTypeEnum.POLY_PROXY;
    case "gnosis-safe":
    case "poly-gnosis-safe":
    case "safe":
    case "2":
      return SignatureTypeEnum.POLY_GNOSIS_SAFE;
    default:
      throw new ValidationError(`unknown signature_type "${raw}" in config`);
  }
}

/** Parse the flat key = value TOML subset the CLI writes. */
export function parsePredictConfig(toml: string): PredictFileConfig {
  const values = new Map<string, string>();
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash >= 0 && !value.startsWith('"')) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  const privateKey = values.get("private_key");
  if (!privateKey) {
    throw new ValidationError("config is missing private_key");
  }
  const config: PredictFileConfig = { privateKey };
  const chainId = values.get("chain_id");
  if (chainId !== undefined) config.chainId = Number(chainId);
  const scopeId = values.get("scope_id");
  if (scopeId !== undefined) config.scopeId = scopeIdFromHex(scopeId);
  const signatureType = values.get("signature_type");
  if (signatureType !== undefined) config.signatureType = parseSignatureType(signatureType);
  const safeAddress = values.get("safe_address");
  if (safeAddress !== undefined) config.safeAddress = normalizeAddress(safeAddress);
  const network = values.get("network");
  if (network !== undefined) config.network = network;
  const tenant = values.get("tenant");
  if (tenant !== undefined) config.tenant = tenant;
  return config;
}

/**
 * Load `config.toml` from a predict config directory (default `~/.config/predict`).
 * Pass a directory (containing config.toml) or a full path to the file itself.
 */
export function loadPredictConfig(path?: string): PredictFileConfig {
  let file = path ?? DEFAULT_CONFIG_PATH;
  if (!file.endsWith(".toml")) {
    file = join(file, "config.toml");
  }
  return parsePredictConfig(readFileSync(file, "utf8"));
}
