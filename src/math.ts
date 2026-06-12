/**
 * Exact decimal math for order amounts. No floating point: decimal inputs are parsed
 * into bigint mantissa/scale pairs.
 *
 * Parity targets:
 * - pm-sdk-go `toBaseUnits` = `Truncate(6).Shift(6).Truncate(0)` (floor truncation)
 * - predict-rs `order_builder.rs::compute_amounts` / `validate_*`
 */

import { ValidationError } from "./errors.js";
import { type Side, sideToUint8 } from "./types.js";

/** USDW / CTF outcome-token scale (10^6). */
export const COLLATERAL_DECIMALS = 6;

/** Maximum decimal places for order size (lot size). */
export const LOT_SIZE_SCALE = 2;

export type DecimalInput = string | number;

/** Arbitrary-precision decimal as mantissa × 10^-scale. */
export interface Dec {
  mantissa: bigint;
  scale: number;
}

/**
 * Parse a decimal string or number into an exact `Dec`. Rejects exponents out of
 * caution for prices/sizes (the wire never uses them), NaN, and infinities.
 */
export function parseDecimal(value: DecimalInput): Dec {
  const s = typeof value === "number" ? numberToDecimalString(value) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    throw new ValidationError(`invalid decimal value: "${value}"`);
  }
  const [, sign, intPart, fracPart = ""] = m;
  const mantissa = BigInt(`${sign}${intPart}${fracPart}` || "0");
  return { mantissa, scale: fracPart.length };
}

function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new ValidationError(`invalid decimal value: ${n}`);
  }
  const s = String(n);
  if (s.includes("e") || s.includes("E")) {
    // 20 significant digits is far beyond price/size precision needs.
    return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

export function decIsZero(d: Dec): boolean {
  return d.mantissa === 0n;
}

export function decIsNegative(d: Dec): boolean {
  return d.mantissa < 0n;
}

/** Number of significant decimal places (trailing zeros do not count). */
export function decEffectiveScale(d: Dec): number {
  let { mantissa, scale } = d;
  if (mantissa === 0n) return 0;
  while (scale > 0 && mantissa % 10n === 0n) {
    mantissa /= 10n;
    scale -= 1;
  }
  return scale;
}

export function decMul(a: Dec, b: Dec): Dec {
  return { mantissa: a.mantissa * b.mantissa, scale: a.scale + b.scale };
}

/** a / b truncated (floored toward zero) to `outScale` decimal places. */
export function decDivTrunc(a: Dec, b: Dec, outScale: number): Dec {
  if (b.mantissa === 0n) {
    throw new ValidationError("division by zero");
  }
  // a / b = a.m * 10^(b.s - a.s) / b.m ; scale numerator so the result has outScale places.
  const num = a.mantissa * 10n ** BigInt(b.scale + outScale);
  const mantissa = num / (b.mantissa * 10n ** BigInt(a.scale));
  return { mantissa, scale: outScale };
}

export function decCmp(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const am = a.mantissa * 10n ** BigInt(scale - a.scale);
  const bm = b.mantissa * 10n ** BigInt(scale - b.scale);
  return am === bm ? 0 : am < bm ? -1 : 1;
}

export const DEC_ZERO: Dec = { mantissa: 0n, scale: 0 };
export const DEC_ONE: Dec = { mantissa: 1n, scale: 0 };

export function decToString(d: Dec): string {
  const neg = d.mantissa < 0n;
  const abs = (neg ? -d.mantissa : d.mantissa).toString().padStart(d.scale + 1, "0");
  const intPart = abs.slice(0, abs.length - d.scale) || "0";
  const fracPart = d.scale > 0 ? `.${abs.slice(abs.length - d.scale)}` : "";
  return `${neg ? "-" : ""}${intPart}${fracPart}`.replace(/\.?0+$/, (m) =>
    m.startsWith(".") ? "" : m,
  );
}

/**
 * Truncate to 6 decimal places and shift by 10^6 — base units as bigint.
 * Floor truncation, never rounds. Negative input is rejected.
 */
export function toBaseUnits(value: DecimalInput): bigint {
  const d = parseDecimal(value);
  if (decIsNegative(d)) {
    throw new ValidationError(`amount ${decToString(d)} cannot be negative`);
  }
  return truncToBaseUnits(d);
}

function truncToBaseUnits(d: Dec): bigint {
  if (d.scale <= COLLATERAL_DECIMALS) {
    return d.mantissa * 10n ** BigInt(COLLATERAL_DECIMALS - d.scale);
  }
  return d.mantissa / 10n ** BigInt(d.scale - COLLATERAL_DECIMALS);
}

/**
 * Compute `(makerAmount, takerAmount)` in 6-decimal base units.
 *
 * - BUY:  makerAmount = price × size (USDW), takerAmount = size (shares)
 * - SELL: makerAmount = size (shares),       takerAmount = price × size (USDW)
 */
export function computeAmounts(
  side: Side,
  price: DecimalInput,
  size: DecimalInput,
): { makerAmount: bigint; takerAmount: bigint } {
  const p = parseDecimal(price);
  const s = parseDecimal(size);
  if (decIsNegative(p) || decIsNegative(s)) {
    throw new ValidationError("price and size cannot be negative");
  }
  const notional = decMul(p, s);
  const sizeUnits = truncToBaseUnits(s);
  const notionalUnits = truncToBaseUnits(notional);
  return sideToUint8(side) === 0
    ? { makerAmount: notionalUnits, takerAmount: sizeUnits }
    : { makerAmount: sizeUnits, takerAmount: notionalUnits };
}

/** Price must lie strictly inside (0, 1). */
export function validatePrice(price: DecimalInput): void {
  const p = parseDecimal(price);
  if (decIsNegative(p) || decIsZero(p)) {
    throw new ValidationError(`price must be strictly positive, got ${decToString(p)}`);
  }
  if (decCmp(p, DEC_ONE) >= 0) {
    throw new ValidationError(`price must lie in the open interval (0, 1), got ${decToString(p)}`);
  }
}

/** Size must be positive with at most LOT_SIZE_SCALE decimal places. */
export function validateSize(size: DecimalInput): void {
  const s = parseDecimal(size);
  if (decIsNegative(s) || decIsZero(s)) {
    throw new ValidationError(`size must be strictly positive, got ${decToString(s)}`);
  }
  const scale = decEffectiveScale(s);
  if (scale > LOT_SIZE_SCALE) {
    throw new ValidationError(
      `size ${decToString(s)} has ${scale} decimals; lot size is ${LOT_SIZE_SCALE}`,
    );
  }
}

/**
 * Tick-size enforcement: price decimals must not exceed the tick's, and price must lie in
 * the inner interval [tick, 1 - tick].
 */
export function validatePriceAgainstTick(price: DecimalInput, tick: DecimalInput): void {
  const p = parseDecimal(price);
  const t = parseDecimal(tick);
  const tickScale = decEffectiveScale(t);
  const priceScale = decEffectiveScale(p);
  if (priceScale > tickScale) {
    throw new ValidationError(
      `price ${decToString(p)} has ${priceScale} decimals; minimum_tick_size ${decToString(t)} has ${tickScale}`,
    );
  }
  const upper: Dec = {
    mantissa: 10n ** BigInt(t.scale) - t.mantissa,
    scale: t.scale,
  };
  if (decCmp(p, t) < 0 || decCmp(p, upper) > 0) {
    throw new ValidationError(
      `price ${decToString(p)} is outside the tick-aligned interval [${decToString(t)}, ${decToString(upper)}]`,
    );
  }
}
