/** Amount math parity with predict-rs `order_builder.rs` unit tests. */

import { describe, expect, it } from "vitest";
import {
  computeAmounts,
  toBaseUnits,
  validatePrice,
  validatePriceAgainstTick,
  validateSize,
} from "../src/math.js";

describe("toBaseUnits", () => {
  it("truncates (never rounds) past 6 decimals", () => {
    expect(toBaseUnits("123.456")).toBe(123_456_000n);
    expect(toBaseUnits("123.456789")).toBe(123_456_789n);
    expect(toBaseUnits("123.4567899")).toBe(123_456_789n);
    expect(toBaseUnits("0")).toBe(0n);
  });

  it("accepts number inputs without float drift", () => {
    expect(toBaseUnits(0.1)).toBe(100_000n);
    expect(toBaseUnits(0.34)).toBe(340_000n);
  });

  it("rejects negative amounts", () => {
    expect(() => toBaseUnits("-1")).toThrow();
  });
});

describe("computeAmounts", () => {
  it("BUY 100 @ 0.34 -> maker 34_000_000, taker 100_000_000", () => {
    const { makerAmount, takerAmount } = computeAmounts("BUY", "0.34", "100");
    expect(makerAmount).toBe(34_000_000n);
    expect(takerAmount).toBe(100_000_000n);
  });

  it("SELL 100 @ 0.65 -> maker 100_000_000, taker 65_000_000", () => {
    const { makerAmount, takerAmount } = computeAmounts("SELL", "0.65", "100");
    expect(makerAmount).toBe(100_000_000n);
    expect(takerAmount).toBe(65_000_000n);
  });

  it("truncates the notional at 6 decimals", () => {
    const { makerAmount, takerAmount } = computeAmounts("BUY", "0.123456789", "1");
    expect(makerAmount).toBe(123_456n);
    expect(takerAmount).toBe(1_000_000n);
  });
});

describe("validatePrice", () => {
  it("requires the open interval (0, 1)", () => {
    expect(() => validatePrice("0")).toThrow();
    expect(() => validatePrice("1")).toThrow();
    expect(() => validatePrice("-0.01")).toThrow();
    expect(() => validatePrice("0.5")).not.toThrow();
  });
});

describe("validateSize", () => {
  it("caps size at 2 decimals (lot size)", () => {
    expect(() => validateSize("1.234")).toThrow();
    expect(() => validateSize("1.23")).not.toThrow();
  });

  it("ignores trailing zeros when counting decimals", () => {
    expect(() => validateSize("1.230000")).not.toThrow();
  });
});

describe("validatePriceAgainstTick", () => {
  it("tick 0.01 rejects higher-precision price", () => {
    expect(() => validatePriceAgainstTick("0.501", "0.01")).toThrow();
  });

  it("tick 0.01 accepts in-range prices", () => {
    expect(() => validatePriceAgainstTick("0.50", "0.01")).not.toThrow();
    expect(() => validatePriceAgainstTick("0.99", "0.01")).not.toThrow();
    expect(() => validatePriceAgainstTick("0.01", "0.01")).not.toThrow();
  });

  it("tick 0.001 accepts three decimals, rejects four", () => {
    expect(() => validatePriceAgainstTick("0.012", "0.001")).not.toThrow();
    expect(() => validatePriceAgainstTick("0.0123", "0.001")).toThrow();
  });

  it("tick 0.0001 accepts four decimals, rejects five", () => {
    expect(() => validatePriceAgainstTick("0.0123", "0.0001")).not.toThrow();
    expect(() => validatePriceAgainstTick("0.01234", "0.0001")).toThrow();
  });

  it("rejects prices outside [tick, 1 - tick]", () => {
    expect(() => validatePriceAgainstTick("0.005", "0.01")).toThrow();
    expect(() => validatePriceAgainstTick("0.995", "0.01")).toThrow();
  });
});
