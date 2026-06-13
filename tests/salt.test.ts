import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSalt } from "../src/order-builder.js";

describe("generateSalt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unique even within a single frozen millisecond", () => {
    // Regression: the old `Date.now() * 1e6` salt had no sub-millisecond entropy,
    // so a same-maker postOrders batch built in one tick produced identical order
    // hashes the server rejected as duplicates. With the clock pinned, all
    // uniqueness must come from the CSPRNG low bits.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const salts = new Set<bigint>();
    for (let i = 0; i < 2000; i++) salts.add(generateSalt());
    expect(salts.size).toBe(2000);
  });

  it("produces positive uint256-range values", () => {
    const s = generateSalt();
    expect(s > 0n).toBe(true);
    expect(s < 1n << 256n).toBe(true);
  });

  it("keeps the millisecond clock in the high bits (roughly monotonic across ms)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const a = generateSalt();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.001Z"));
    const b = generateSalt();
    expect(b >> 64n).toBeGreaterThan(a >> 64n);
  });
});
