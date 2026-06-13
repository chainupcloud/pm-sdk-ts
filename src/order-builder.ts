/**
 * Order construction. Port of predict-rs `clob/order_builder.rs`.
 *
 * Builds a signable order from human-readable inputs (price / size / amount) plus the
 * chain-level context owned by `PredictSigner`, then signs it into the wire-ready JSON
 * shape (`SignedOrderWire`).
 *
 * Amount math: see `math.ts`. Signature: the EIP-712 signature is normalized to
 * v ∈ {27, 28} on the wire (on-chain `ECDSA.recover` convention).
 */

import { randomBytes } from "node:crypto";
import type { OrderForSigning } from "./crypto/eip712.js";
import { normalizeEcdsaV, type PredictSigner } from "./crypto/signer.js";
import { ValidationError } from "./errors.js";
import {
  computeAmounts,
  type DecimalInput,
  decDivTrunc,
  decIsZero,
  decToString,
  parseDecimal,
  validatePrice,
  validatePriceAgainstTick,
  validateSize,
} from "./math.js";
import {
  type Address,
  isMarketOrderType,
  normalizeAddress,
  type OrderType,
  OrderType as OrderTypeEnum,
  type Side,
  type SignatureType,
  SignatureType as SignatureTypeEnum,
  scopeIdToWire,
  sideToUint8,
  ZERO_ADDRESS,
} from "./types.js";

/** Wire-ready signed order (exact JSON field names the CLOB expects). */
export interface SignedOrderWire {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenID: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: Side;
  signatureType: string;
  signature: string;
  /** Omitted from JSON when empty (zero scope). */
  scopeId?: string;
}

/** A built (validated, amounts computed) but not yet signed order + envelope details. */
export interface BuiltOrder {
  order: OrderForSigning;
  orderType: OrderType;
  postOnly: boolean;
  owner: string;
}

interface CommonOrderArgs {
  tokenId: string | bigint;
  side: Side;
  /** Per-event fee rate in basis points — the server rejects orders below the event minimum. */
  feeRateBps: number | bigint;
  /** Maker address. Required for POLY_GNOSIS_SAFE (the Safe); defaults to the signer for EOA. */
  maker?: Address;
  taker?: Address;
  /** Default POLY_GNOSIS_SAFE (2) — the platform's standard wallet setup. */
  signatureType?: SignatureType;
  /** Unix seconds; only valid (and required) for GTD. */
  expiration?: number | bigint;
  /** Server-side rotation nonce (defaults to 0). Distinct from the API-key nonce. */
  nonce?: number | bigint;
  /** Pin the salt for reproducible signatures (tests). Defaults to 53-bit ns timestamp. */
  salt?: bigint;
  /** Optional owner UUID forwarded on the outer envelope. */
  owner?: string;
  /** When set, price is validated against this tick (decimals + [tick, 1-tick] bounds). */
  minimumTickSize?: DecimalInput;
}

export interface LimitOrderArgs extends CommonOrderArgs {
  price: DecimalInput;
  size: DecimalInput;
  /** GTC (default) or GTD; FOK/FAK are market types. */
  orderType?: OrderType;
  postOnly?: boolean;
}

export interface MarketOrderArgs extends CommonOrderArgs {
  /**
   * Anchor price — the server runs the actual book walk; the signed order still carries
   * makerAmount/takerAmount anchored at this price.
   */
  price: DecimalInput;
  /** Amount in shares. Exactly one of `shares` / `usdw` must be set. */
  shares?: DecimalInput;
  /** Amount in USDW (BUY only); converted to shares via amount / price, truncated to lot size. */
  usdw?: DecimalInput;
  /** FAK (default) or FOK. */
  orderType?: OrderType;
}

/**
 * Default per-order salt: millisecond clock in the high bits + 64 bits of CSPRNG
 * entropy in the low bits.
 *
 * `salt` is the Order struct's only distinguishing field when every other field
 * is identical, so two same-maker orders with the same params (e.g. a
 * `postOrders` batch that splits one order into equal chunks, all built in the
 * same tick) MUST get different salts — otherwise they hash to the same order id
 * and the server rejects the second as a duplicate. The previous
 * `Date.now() * 1e6` scheme carried no sub-millisecond entropy and collided in
 * exactly that case. The value is serialized as a decimal uint256 string on the
 * wire, so it is intentionally not bounded to 2^53.
 */
export function generateSalt(): bigint {
  return (BigInt(Date.now()) << 64n) | BigInt(`0x${randomBytes(8).toString("hex")}`);
}

function resolveCommon(
  args: CommonOrderArgs,
  orderType: OrderType,
  postOnly: boolean,
): {
  tokenId: bigint;
  feeRateBps: bigint;
  expiration: bigint;
  nonce: bigint;
  signatureType: SignatureType;
  maker: Address | undefined;
  taker: Address;
} {
  const expiration = BigInt(args.expiration ?? 0);
  if (orderType === OrderTypeEnum.GTD) {
    if (expiration === 0n) {
      throw new ValidationError("GTD orders require a non-zero expiration");
    }
  } else if (expiration !== 0n) {
    throw new ValidationError("only GTD orders may set a non-zero expiration");
  }
  if (postOnly && isMarketOrderType(orderType)) {
    throw new ValidationError("postOnly is incompatible with FAK / FOK market orders");
  }
  const signatureType = args.signatureType ?? SignatureTypeEnum.POLY_GNOSIS_SAFE;
  if (signatureType === SignatureTypeEnum.POLY_GNOSIS_SAFE && !args.maker) {
    throw new ValidationError(
      "signatureType=POLY_GNOSIS_SAFE requires maker (the Safe wallet address)",
    );
  }
  return {
    tokenId: BigInt(args.tokenId),
    feeRateBps: BigInt(args.feeRateBps),
    expiration,
    nonce: BigInt(args.nonce ?? 0),
    signatureType,
    maker: args.maker ? normalizeAddress(args.maker) : undefined,
    taker: args.taker ? normalizeAddress(args.taker) : ZERO_ADDRESS,
  };
}

function buildFromPriceSize(
  args: CommonOrderArgs,
  price: DecimalInput,
  size: DecimalInput,
  orderType: OrderType,
  postOnly: boolean,
  signer: PredictSigner,
): BuiltOrder {
  const common = resolveCommon(args, orderType, postOnly);
  validatePrice(price);
  validateSize(size);
  if (args.minimumTickSize !== undefined) {
    validatePriceAgainstTick(price, args.minimumTickSize);
  }
  const { makerAmount, takerAmount } = computeAmounts(args.side, price, size);

  const maker = common.maker ?? signer.address;
  if (common.signatureType === SignatureTypeEnum.EOA && maker !== signer.address) {
    throw new ValidationError(
      `EOA order requires maker == signer address (${maker} != ${signer.address})`,
    );
  }

  return {
    order: {
      salt: args.salt ?? generateSalt(),
      maker,
      signer: signer.address,
      taker: common.taker,
      tokenId: common.tokenId,
      makerAmount,
      takerAmount,
      expiration: common.expiration,
      nonce: common.nonce,
      feeRateBps: common.feeRateBps,
      side: sideToUint8(args.side),
      signatureType: common.signatureType,
      scopeId: signer.scopeId,
    },
    orderType,
    postOnly,
    owner: args.owner ?? "",
  };
}

/** Build (validate + compute amounts) a limit order. Does not sign. */
export function buildLimitOrder(args: LimitOrderArgs, signer: PredictSigner): BuiltOrder {
  const orderType = args.orderType ?? OrderTypeEnum.GTC;
  if (isMarketOrderType(orderType)) {
    throw new ValidationError(`limit orders cannot use market order type ${orderType}`);
  }
  return buildFromPriceSize(args, args.price, args.size, orderType, args.postOnly ?? false, signer);
}

/** Build (validate + compute amounts) a market order. Does not sign. */
export function buildMarketOrder(args: MarketOrderArgs, signer: PredictSigner): BuiltOrder {
  const orderType = args.orderType ?? OrderTypeEnum.FAK;
  if (!isMarketOrderType(orderType)) {
    throw new ValidationError(`market orders require FAK or FOK, got ${orderType}`);
  }
  if ((args.shares === undefined) === (args.usdw === undefined)) {
    throw new ValidationError("market orders require exactly one of shares / usdw");
  }
  let size: DecimalInput;
  if (args.usdw !== undefined) {
    if (args.side === "SELL") {
      throw new ValidationError("SELL market orders must specify the amount in shares");
    }
    const p = parseDecimal(args.price);
    if (decIsZero(p)) {
      throw new ValidationError("market price cannot be zero");
    }
    // shares = usdw / price, floor-truncated to the lot size (2 decimals).
    size = decToString(decDivTrunc(parseDecimal(args.usdw), p, 2));
  } else {
    size = args.shares as DecimalInput;
  }
  return buildFromPriceSize(args, args.price, size, orderType, false, signer);
}

/** Serialize an order + 65-byte signature (v already in {27,28}) to the wire shape. */
export function toWireOrder(order: OrderForSigning, signature: string): SignedOrderWire {
  const wire: SignedOrderWire = {
    salt: order.salt.toString(),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenID: order.tokenId.toString(),
    makerAmount: order.makerAmount.toString(),
    takerAmount: order.takerAmount.toString(),
    expiration: order.expiration.toString(),
    nonce: order.nonce.toString(),
    feeRateBps: order.feeRateBps.toString(),
    side: order.side === 0 ? "BUY" : "SELL",
    // Wire format is the NUMERIC string ("0" | "1" | "2") — verified against the live
    // deployment by predict-rs signed_order_from and pm-sdk-go OrderSignatureType.
    signatureType: order.signatureType.toString(),
    signature,
  };
  const scope = scopeIdToWire(order.scopeId);
  if (scope !== "") {
    wire.scopeId = scope;
  }
  return wire;
}

/** Sign a built order and return the wire-ready shape (v normalized to {27,28}). */
export async function signBuiltOrder(
  built: BuiltOrder,
  signer: PredictSigner,
): Promise<SignedOrderWire> {
  const sig = await signer.signOrder(built.order);
  return toWireOrder(built.order, normalizeEcdsaV(sig));
}
