/**
 * EIP-712 typed data for every signing surface of the platform. Byte-level parity with
 * pm-sdk-go `pkg/signer` / `pkg/relayer` and predict-rs `signer.rs` is enforced by the
 * golden tests in `tests/golden-signer.test.ts`.
 *
 * Domains:
 * - ClobAuth      — short form (name, version, chainId), name "ClobAuthDomain"
 * - Order         — full form (+ verifyingContract = exchange), name "Prediction Market Protocol"
 * - SafeTx        — Safe v1.3 form (chainId + verifyingContract = the Safe), no name/version
 * - CreateProxy   — name + chainId + verifyingContract = proxy factory, NO version field
 * - LoginMessage  — short form, name "PredictMarket" (gamma-service `/auth/login`)
 */

import { encodeAbiParameters, hashTypedData, keccak256, stringToBytes, toHex } from "viem";
import type { Address, Hex, ScopeId } from "../types.js";

export const CLOB_AUTH_DOMAIN_NAME = "ClobAuthDomain";
export const ORDER_DOMAIN_NAME = "Prediction Market Protocol";
export const CREATE_PROXY_DOMAIN_NAME = "Polymarket Contract Proxy Factory";
export const GAMMA_LOGIN_DOMAIN_NAME = "PredictMarket";
export const DOMAIN_VERSION = "1";
export const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

// ─── typed-data type definitions (viem shape) ────────────────────────────

export const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "scopeId", type: "bytes32" },
    { name: "message", type: "string" },
  ],
} as const;

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "scopeId", type: "bytes32" },
  ],
} as const;

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const CREATE_PROXY_TYPES = {
  CreateProxy: [
    { name: "paymentToken", type: "address" },
    { name: "payment", type: "uint256" },
    { name: "paymentReceiver", type: "address" },
    { name: "scopeId", type: "bytes32" },
  ],
} as const;

export const LOGIN_MESSAGE_TYPES = {
  LoginMessage: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "string" },
    { name: "scopeId", type: "uint256" },
    { name: "issuedAt", type: "string" },
    { name: "domain", type: "string" },
    { name: "uri", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

// ─── message payload shapes ──────────────────────────────────────────────

export interface ClobAuthMessage {
  address: Address;
  timestamp: string;
  nonce: bigint;
  scopeId: ScopeId;
}

export interface OrderForSigning {
  salt: bigint;
  maker: Address;
  signer: Address;
  taker: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  /** 0 = BUY, 1 = SELL */
  side: number;
  /** 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE */
  signatureType: number;
  scopeId: ScopeId;
}

export interface SafeTransaction {
  to: Address;
  value: bigint;
  data: Hex;
  /** 0 = CALL, 1 = DELEGATECALL */
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export interface CreateProxyArgs {
  paymentToken: Address;
  payment: bigint;
  paymentReceiver: Address;
  scopeId: ScopeId;
}

export interface LoginMessageParams {
  wallet: Address;
  nonce: string;
  scopeId: ScopeId;
  issuedAt: string;
  domain: string;
  uri: string;
  chainId: number;
}

// ─── domains ─────────────────────────────────────────────────────────────

export function clobAuthDomain(chainId: number) {
  return { name: CLOB_AUTH_DOMAIN_NAME, version: DOMAIN_VERSION, chainId: BigInt(chainId) };
}

export function orderDomain(chainId: number, exchange: Address) {
  return {
    name: ORDER_DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: exchange,
  };
}

export function safeTxDomain(chainId: number, safe: Address) {
  return { chainId: BigInt(chainId), verifyingContract: safe };
}

export function createProxyDomain(chainId: number, factory: Address) {
  return {
    name: CREATE_PROXY_DOMAIN_NAME,
    chainId: BigInt(chainId),
    verifyingContract: factory,
  };
}

export function loginMessageDomain(chainId: number) {
  return { name: GAMMA_LOGIN_DOMAIN_NAME, version: DOMAIN_VERSION, chainId: BigInt(chainId) };
}

// ─── digests (sign-ready 32-byte hashes) ─────────────────────────────────

export function clobAuthDigest(msg: ClobAuthMessage, chainId: number): Hex {
  return hashTypedData({
    domain: clobAuthDomain(chainId),
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: msg.address,
      timestamp: msg.timestamp,
      nonce: msg.nonce,
      scopeId: msg.scopeId,
      message: CLOB_AUTH_MESSAGE,
    },
  });
}

export function orderDigest(order: OrderForSigning, exchange: Address, chainId: number): Hex {
  return hashTypedData({
    domain: orderDomain(chainId, exchange),
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
}

export function safeTxDigest(tx: SafeTransaction, safe: Address, chainId: number): Hex {
  return hashTypedData({
    domain: safeTxDomain(chainId, safe),
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
}

export function createProxyDigest(args: CreateProxyArgs, factory: Address, chainId: number): Hex {
  return hashTypedData({
    domain: createProxyDomain(chainId, factory),
    types: CREATE_PROXY_TYPES,
    primaryType: "CreateProxy",
    message: {
      paymentToken: args.paymentToken,
      payment: args.payment,
      paymentReceiver: args.paymentReceiver,
      scopeId: args.scopeId,
    },
  });
}

export function loginMessageDigest(params: LoginMessageParams): Hex {
  return hashTypedData({
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
}

// ─── manual struct hashes / domain separators (golden-test cross-checks) ──

const EIP712_DOMAIN_SHORT = "EIP712Domain(string name,string version,uint256 chainId)";
const EIP712_DOMAIN_FULL =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

function hashString(s: string): Hex {
  return keccak256(toHex(stringToBytes(s)));
}

export const CLOB_AUTH_TYPE_HASH = hashString(
  "ClobAuth(address address,string timestamp,uint256 nonce,bytes32 scopeId,string message)",
);

export const ORDER_TYPE_HASH = hashString(
  "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType,bytes32 scopeId)",
);

export function clobAuthDomainSeparator(chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
      [
        hashString(EIP712_DOMAIN_SHORT),
        hashString(CLOB_AUTH_DOMAIN_NAME),
        hashString(DOMAIN_VERSION),
        BigInt(chainId),
      ],
    ),
  );
}

export function orderDomainSeparator(chainId: number, exchange: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        hashString(EIP712_DOMAIN_FULL),
        hashString(ORDER_DOMAIN_NAME),
        hashString(DOMAIN_VERSION),
        BigInt(chainId),
        exchange,
      ],
    ),
  );
}

export function clobAuthStructHash(msg: ClobAuthMessage): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        CLOB_AUTH_TYPE_HASH,
        msg.address,
        hashString(msg.timestamp),
        msg.nonce,
        msg.scopeId,
        hashString(CLOB_AUTH_MESSAGE),
      ],
    ),
  );
}

export function orderStructHash(order: OrderForSigning): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [
        ORDER_TYPE_HASH,
        order.salt,
        order.maker,
        order.signer,
        order.taker,
        order.tokenId,
        order.makerAmount,
        order.takerAmount,
        order.expiration,
        order.nonce,
        order.feeRateBps,
        order.side,
        order.signatureType,
        order.scopeId,
      ],
    ),
  );
}
