/**
 * High-level signer owning a private key plus chain-level context (chainId, scopeId,
 * optional exchange address).
 *
 * Signature v-byte conventions (parity with predict-rs `signer.rs`):
 * - ClobAuth / Order: v ∈ {0, 1} (go-ethereum `crypto.Sign` recovery-id convention).
 *   The order wire format then normalizes to {27, 28} via `normalizeEcdsaV`.
 * - SafeTx / CreateProxy / LoginMessage: v ∈ {27, 28} (Ethereum convention required by
 *   on-chain `ecrecover` and the gamma/relayer services).
 */

import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { SignerError } from "../errors.js";
import type { Address, Hex, ScopeId } from "../types.js";
import { normalizeAddress, ZERO_SCOPE_ID } from "../types.js";
import {
  CLOB_AUTH_MESSAGE,
  CLOB_AUTH_TYPES,
  CREATE_PROXY_TYPES,
  type CreateProxyArgs,
  clobAuthDomain,
  createProxyDomain,
  LOGIN_MESSAGE_TYPES,
  type LoginMessageParams,
  loginMessageDomain,
  ORDER_TYPES,
  type OrderForSigning,
  orderDomain,
  SAFE_TX_TYPES,
  type SafeTransaction,
  safeTxDomain,
} from "./eip712.js";

/** 65-byte r||s||v signature as 0x-hex (132 chars). */
export type Signature65 = Hex;

/** Shift v into the recovery-id convention {0, 1}. Idempotent. */
export function toRecoveryIdV(sig: Signature65): Signature65 {
  const v = Number.parseInt(sig.slice(130, 132), 16);
  if (v < 27) return sig;
  return `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}` as Signature65;
}

/**
 * Shift v into the Ethereum convention {27, 28}. Idempotent. Matches
 * pm-sdk-go `normalizeECDSAv` / predict-rs `normalize_ecdsa_v`.
 */
export function normalizeEcdsaV(sig: Signature65): Signature65 {
  const v = Number.parseInt(sig.slice(130, 132), 16);
  if (v >= 27) return sig;
  return `${sig.slice(0, 130)}${(v + 27).toString(16).padStart(2, "0")}` as Signature65;
}

function assertSignature65(sig: Hex): Signature65 {
  if (sig.length !== 132) {
    throw new SignerError(`expected 65-byte signature, got ${(sig.length - 2) / 2} bytes`);
  }
  return sig as Signature65;
}

export interface PredictSignerOptions {
  chainId: number;
  scopeId?: ScopeId;
  /** CTF exchange address — required only for `signOrder`. */
  exchange?: Address;
}

export class PredictSigner {
  readonly chainId: number;
  readonly scopeId: ScopeId;
  readonly exchange: Address | undefined;
  private readonly privateKey: Hex;
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: string, options: PredictSignerOptions) {
    const stripped = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
      throw new SignerError("private key must be 32 bytes of hex");
    }
    this.privateKey = `0x${stripped}` as Hex;
    try {
      this.account = privateKeyToAccount(this.privateKey);
    } catch (e) {
      throw new SignerError(`invalid private key: ${(e as Error).message}`);
    }
    this.chainId = options.chainId;
    this.scopeId = options.scopeId ?? ZERO_SCOPE_ID;
    this.exchange = options.exchange;
  }

  /** Lowercase 0x EOA address. */
  get address(): Address {
    return normalizeAddress(this.account.address);
  }

  /** EIP-55 checksummed EOA address. */
  get checksumAddress(): Address {
    return this.account.address as Address;
  }

  withScopeId(scopeId: ScopeId): PredictSigner {
    const options: PredictSignerOptions = { chainId: this.chainId, scopeId };
    if (this.exchange) options.exchange = this.exchange;
    return new PredictSigner(this.privateKey, options);
  }

  withExchange(exchange: Address): PredictSigner {
    return new PredictSigner(this.privateKey, {
      chainId: this.chainId,
      scopeId: this.scopeId,
      exchange,
    });
  }

  /** Sign the ClobAuth L1 challenge. Returns 65-byte hex with v ∈ {0, 1}. */
  async signClobAuth(timestamp: string, nonce: bigint | number): Promise<Signature65> {
    const sig = await this.account.signTypedData({
      domain: clobAuthDomain(this.chainId),
      types: CLOB_AUTH_TYPES,
      primaryType: "ClobAuth",
      message: {
        address: this.account.address,
        timestamp,
        nonce: BigInt(nonce),
        scopeId: this.scopeId,
        message: CLOB_AUTH_MESSAGE,
      },
    });
    return toRecoveryIdV(assertSignature65(sig));
  }

  /**
   * Sign an order. Returns 65-byte hex with v ∈ {0, 1} (matches the golden vectors);
   * callers building the wire order should pass the result through `normalizeEcdsaV`.
   * Requires `exchange` to be set.
   */
  async signOrder(order: OrderForSigning): Promise<Signature65> {
    if (!this.exchange) {
      throw new SignerError("exchange address required for signOrder");
    }
    const sig = await this.account.signTypedData({
      domain: orderDomain(this.chainId, this.exchange),
      types: ORDER_TYPES,
      primaryType: "Order",
      message: {
        salt: order.salt,
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        expiration: order.expiration,
        nonce: order.nonce,
        feeRateBps: order.feeRateBps,
        side: order.side,
        signatureType: order.signatureType,
        scopeId: order.scopeId,
      },
    });
    return toRecoveryIdV(assertSignature65(sig));
  }

  /**
   * Sign a Gnosis Safe transaction (the Safe address is the EIP-712 verifyingContract).
   * Returns 65-byte hex with v ∈ {27, 28}.
   */
  async signSafeTx(safe: Address, tx: SafeTransaction): Promise<Signature65> {
    const sig = await this.account.signTypedData({
      domain: safeTxDomain(this.chainId, safe),
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      message: {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas,
        baseGas: tx.baseGas,
        gasPrice: tx.gasPrice,
        gasToken: tx.gasToken,
        refundReceiver: tx.refundReceiver,
        nonce: tx.nonce,
      },
    });
    return normalizeEcdsaV(assertSignature65(sig));
  }

  /**
   * Sign a SAFE-CREATE (CreateProxy) request for the proxy factory.
   * Returns 65-byte hex with v ∈ {27, 28}.
   */
  async signCreateProxy(factory: Address, args: CreateProxyArgs): Promise<Signature65> {
    const sig = await this.account.signTypedData({
      domain: createProxyDomain(this.chainId, factory),
      types: CREATE_PROXY_TYPES,
      primaryType: "CreateProxy",
      message: {
        paymentToken: args.paymentToken,
        payment: args.payment,
        paymentReceiver: args.paymentReceiver,
        scopeId: args.scopeId,
      },
    });
    return normalizeEcdsaV(assertSignature65(sig));
  }

  /**
   * Sign a gamma-service login message. Returns 65-byte hex with v ∈ {27, 28}.
   */
  async signLoginMessage(params: LoginMessageParams): Promise<Signature65> {
    const sig = await this.account.signTypedData({
      domain: loginMessageDomain(params.chainId),
      types: LOGIN_MESSAGE_TYPES,
      primaryType: "LoginMessage",
      message: {
        wallet: params.wallet,
        nonce: params.nonce,
        scopeId: BigInt(params.scopeId),
        issuedAt: params.issuedAt,
        domain: params.domain,
        uri: params.uri,
        chainId: BigInt(params.chainId),
      },
    });
    return normalizeEcdsaV(assertSignature65(sig));
  }
}
