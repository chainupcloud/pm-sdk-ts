/**
 * Top-level facade wiring every service client to one wallet + network context.
 *
 * ```ts
 * const client = PredictClient.fromConfig(loadPredictConfig());
 * await client.ensureApiKey();
 * const order = await client.clob.limitOrder({ tokenId, price: "0.5", size: "10", side: "BUY" });
 * ```
 */

import { ClobClient } from "./clob/client.js";
import type { PredictFileConfig } from "./config.js";
import { PredictSigner } from "./crypto/signer.js";
import { DataClient } from "./data/client.js";
import type { Endpoints } from "./endpoints.js";
import { ValidationError } from "./errors.js";
import { GammaClient } from "./gamma/client.js";
import type { NetworkConfig } from "./networks.js";
import { getNetwork } from "./networks.js";
import { RelayerClient } from "./relayer/client.js";
import { RelayerService } from "./relayer/service.js";
import type { Address, ApiCredentials, ScopeId, SignatureType } from "./types.js";
import { SignatureType as SignatureTypeEnum } from "./types.js";
import { PredictWsClient } from "./ws/client.js";

export interface PredictClientConfig {
  /** 32-byte hex EOA private key. Never read from env by the SDK. */
  privateKey: string;
  /** Built-in network name or a full NetworkConfig. Default "monad". */
  network?: string | NetworkConfig;
  /** Tenant scope id (bytes32 hex). Default zero (unscoped). */
  scopeId?: ScopeId;
  /** Safe (smart wallet) address — the maker for POLY_GNOSIS_SAFE orders. */
  safeAddress?: Address;
  /** Default POLY_GNOSIS_SAFE when safeAddress is set, EOA otherwise. */
  signatureType?: SignatureType;
  /** Override the network's chain id. */
  chainId?: number;
  /** Override the network's CTF exchange address (EIP-712 verifyingContract). */
  exchange?: Address;
  /** Override individual service endpoints. */
  endpoints?: Partial<Endpoints>;
  /** Pre-existing L2 credentials (otherwise call `ensureApiKey()`). */
  credentials?: ApiCredentials;
}

export class PredictClient {
  readonly network: NetworkConfig;
  readonly signer: PredictSigner;
  readonly signatureType: SignatureType;
  readonly safeAddress: Address | undefined;
  readonly clob: ClobClient;
  readonly gamma: GammaClient;
  readonly data: DataClient;
  readonly ws: PredictWsClient;
  readonly relayer: RelayerClient;
  readonly relayerService: RelayerService;

  constructor(config: PredictClientConfig) {
    this.network = typeof config.network === "object" ? config.network : getNetwork(config.network);
    const endpoints = { ...this.network.endpoints, ...config.endpoints };
    const chainId = config.chainId ?? this.network.chainId;
    const exchange = config.exchange ?? this.network.contracts.ctfExchange;

    const signerOptions: { chainId: number; exchange: Address; scopeId?: ScopeId } = {
      chainId,
      exchange,
    };
    if (config.scopeId) signerOptions.scopeId = config.scopeId;
    this.signer = new PredictSigner(config.privateKey, signerOptions);

    this.signatureType =
      config.signatureType ??
      (config.safeAddress ? SignatureTypeEnum.POLY_GNOSIS_SAFE : SignatureTypeEnum.EOA);
    this.safeAddress = config.safeAddress;
    if (this.signatureType === SignatureTypeEnum.POLY_GNOSIS_SAFE && !this.safeAddress) {
      throw new ValidationError("signatureType POLY_GNOSIS_SAFE requires safeAddress");
    }

    const fundingAddress = this.safeAddress ?? this.signer.address;
    this.clob = new ClobClient({
      baseUrl: endpoints.clob,
      signer: this.signer,
      fundingAddress,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
    if (!endpoints.gamma || !endpoints.data || !endpoints.ws || !endpoints.relayer) {
      throw new ValidationError("network endpoints must include gamma, data, ws, and relayer");
    }
    this.gamma = new GammaClient(endpoints.gamma);
    this.data = new DataClient(endpoints.data);
    this.ws = new PredictWsClient(endpoints.ws);
    this.relayer = new RelayerClient({ baseUrl: endpoints.relayer });
    this.relayerService = new RelayerService({
      client: this.relayer,
      signer: this.signer,
      network: this.network,
    });
  }

  /** Build from a predict-cli `config.toml` (see `loadPredictConfig`). */
  static fromConfig(
    file: PredictFileConfig,
    overrides: Partial<PredictClientConfig> = {},
  ): PredictClient {
    const config: PredictClientConfig = { privateKey: file.privateKey };
    if (file.network !== undefined) config.network = file.network;
    if (file.scopeId !== undefined) config.scopeId = file.scopeId;
    if (file.safeAddress !== undefined) config.safeAddress = file.safeAddress;
    if (file.signatureType !== undefined) config.signatureType = file.signatureType;
    if (file.chainId !== undefined) config.chainId = file.chainId;
    return new PredictClient({ ...config, ...overrides });
  }

  /** EOA address derived from the private key. */
  get address(): Address {
    return this.signer.address;
  }

  /** The maker address used for orders (the Safe when configured, else the EOA). */
  get fundingAddress(): Address {
    return this.safeAddress ?? this.signer.address;
  }

  /**
   * Create-or-derive an L2 API key and install it on the CLOB client.
   * Idempotent: re-running derives the existing key.
   */
  async ensureApiKey(nonce?: number): Promise<ApiCredentials> {
    const creds = await this.clob.createOrDeriveApiKey(nonce);
    this.clob.setCredentials(creds);
    return creds;
  }

  /**
   * Log into the gamma service (EIP-712 LoginMessage -> JWT) and install the Bearer
   * token on the relayer client. Returns the JWT.
   */
  async loginRelayer(): Promise<string> {
    const domain = this.network.tenant;
    const uri = `https://${this.network.tenant}`;
    const { token } = await this.gamma.login(this.signer, domain, uri);
    this.relayer.setAuth({ bearerJwt: token });
    return token;
  }
}
