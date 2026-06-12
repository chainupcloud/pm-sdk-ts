/**
 * Byte-level parity with pm-sdk-go `pkg/signer` (and predict-rs `signer.rs`, which shares
 * the same fixture). Every domain separator, struct hash, digest, and signature in
 * `fixtures/golden-signer.json` must match exactly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clobAuthDigest,
  clobAuthDomainSeparator,
  clobAuthStructHash,
  type OrderForSigning,
  orderDigest,
  orderDomainSeparator,
  orderStructHash,
} from "../src/crypto/eip712.js";
import { PredictSigner } from "../src/crypto/signer.js";
import { type Address, scopeIdFromHex } from "../src/types.js";

interface ClobAuthVector {
  name: string;
  chain_id: number;
  address: Address;
  timestamp: string;
  nonce: number;
  scope_id_hex: string;
  domain_separator: string;
  struct_hash: string;
  digest: string;
  signature: string;
  recovered_address: string;
}

interface OrderVector {
  name: string;
  chain_id: number;
  exchange_address: Address;
  salt: string;
  maker: Address;
  signer: Address;
  taker: Address;
  token_id: string;
  maker_amount: string;
  taker_amount: string;
  expiration: number;
  nonce: number;
  fee_rate_bps: number;
  side: number;
  signature_type: number;
  scope_id_hex: string;
  domain_separator: string;
  struct_hash: string;
  digest: string;
  signature: string;
  recovered_address: string;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "golden-signer.json"), "utf8"),
) as {
  private_key: string;
  clob_auth: ClobAuthVector[];
  orders: OrderVector[];
};

describe("ClobAuth golden vectors", () => {
  for (const v of fixture.clob_auth) {
    it(v.name, async () => {
      const scopeId = scopeIdFromHex(v.scope_id_hex);
      const msg = {
        address: v.address,
        timestamp: v.timestamp,
        nonce: BigInt(v.nonce),
        scopeId,
      };
      expect(clobAuthDomainSeparator(v.chain_id)).toBe(v.domain_separator);
      expect(clobAuthStructHash(msg)).toBe(v.struct_hash);
      expect(clobAuthDigest(msg, v.chain_id)).toBe(v.digest);

      const signer = new PredictSigner(fixture.private_key, {
        chainId: v.chain_id,
        scopeId,
      });
      expect(signer.checksumAddress).toBe(v.address);
      expect(await signer.signClobAuth(v.timestamp, v.nonce)).toBe(v.signature);
    });
  }
});

describe("Order golden vectors", () => {
  for (const v of fixture.orders) {
    it(v.name, async () => {
      const scopeId = scopeIdFromHex(v.scope_id_hex);
      const order: OrderForSigning = {
        salt: BigInt(v.salt),
        maker: v.maker,
        signer: v.signer,
        taker: v.taker,
        tokenId: BigInt(v.token_id),
        makerAmount: BigInt(v.maker_amount),
        takerAmount: BigInt(v.taker_amount),
        expiration: BigInt(v.expiration),
        nonce: BigInt(v.nonce),
        feeRateBps: BigInt(v.fee_rate_bps),
        side: v.side,
        signatureType: v.signature_type,
        scopeId,
      };
      expect(orderDomainSeparator(v.chain_id, v.exchange_address)).toBe(v.domain_separator);
      expect(orderStructHash(order)).toBe(v.struct_hash);
      expect(orderDigest(order, v.exchange_address, v.chain_id)).toBe(v.digest);

      const signer = new PredictSigner(fixture.private_key, {
        chainId: v.chain_id,
        scopeId,
        exchange: v.exchange_address,
      });
      expect(await signer.signOrder(order)).toBe(v.signature);
    });
  }
});
