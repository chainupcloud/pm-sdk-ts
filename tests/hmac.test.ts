/** L2 HMAC parity with predict-rs `auth.rs` known vectors. */

import { describe, expect, it } from "vitest";
import { buildL2Headers } from "../src/auth.js";
import { computeL2Hmac } from "../src/crypto/hmac.js";

describe("computeL2Hmac", () => {
  it("matches the rs-clob-client reference vector (standard base64 alphabet)", () => {
    const sig = computeL2Hmac(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "1000000",
      "test-sign",
      "/orders",
      '{"hash":"0x123"}',
    );
    expect(sig).toBe("4gJVbox+R6XlDK4nlaicig0/ANVL1qdcahiL8CXfXLM=");
  });

  it("produces 44-char standard base64 with padding", () => {
    const sig = computeL2Hmac(
      "c2VjcmV0LXRlc3Qta2V5LWFhYWFhYWFhYWFhYWFhYWFhYWE=",
      "1700000000",
      "GET",
      "/orders",
      "",
    );
    expect(sig).toHaveLength(44);
    expect(sig.endsWith("=")).toBe(true);
  });

  it("falls back to raw bytes for non-base64 secrets", () => {
    // Not valid base64 (odd length + invalid chars) — must not throw.
    const sig = computeL2Hmac("not!!base64", "1", "GET", "/x", "");
    expect(sig).toHaveLength(44);
  });
});

describe("buildL2Headers", () => {
  it("sets the five PRED_* headers", () => {
    const headers = buildL2Headers(
      {
        key: "00000000-0000-0000-0000-000000000000",
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        passphrase: "pp-test",
      },
      "0xabababababababababababababababababababab",
      "1700000000",
      "GET",
      "/balance-allowance",
      "",
    );
    expect(headers.PRED_API_KEY).toBe("00000000-0000-0000-0000-000000000000");
    expect(headers.PRED_PASSPHRASE).toBe("pp-test");
    expect(headers.PRED_TIMESTAMP).toBe("1700000000");
    expect(headers.PRED_ADDRESS).toBe("0xabababababababababababababababababababab");
    expect(headers.PRED_SIGNATURE).toBe(
      computeL2Hmac(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "1700000000",
        "GET",
        "/balance-allowance",
        "",
      ),
    );
  });
});
