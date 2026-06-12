/**
 * Gnosis Safe transaction primitives — SafeTx builders, calldata encoders for the
 * platform's write flows (ERC-20 approve, ERC-1155 setApprovalForAll, CTF
 * split / merge / redeem), the MultiSend packed encoder, and the CREATE2 proxy-address
 * prediction.
 *
 * Ports of predict-rs `clob-client/src/safe/{mod.rs,multisend.rs}` and the predict-cli
 * call sites (`approve_commands.rs`, `ctf_commands.rs`). Function selectors are computed
 * from the exact signature strings the Rust code uses.
 *
 * All wire formats match Gnosis Safe v1.3.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  maxUint256,
  toFunctionSelector,
} from "viem";
import type { SafeTransaction } from "../crypto/eip712.js";
import { ValidationError } from "../errors.js";
import type { Address, Hex, ScopeId } from "../types.js";
import { normalizeAddress, ZERO_ADDRESS } from "../types.js";

export type { SafeTransaction } from "../crypto/eip712.js";

/** Zero bytes32 — the default `parentCollectionId` for top-level CTF conditions. */
export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/** Operation flavour for a Safe transaction (`Safe.execTransaction` `operation`). */
export const SafeOperation = {
  /** Standard contract call — direct ops like `USDW.approve`. */
  CALL: 0,
  /** Required when `to == multiSendAddress` so batched ops execute as the Safe. */
  DELEGATE_CALL: 1,
} as const;
export type SafeOperation = (typeof SafeOperation)[keyof typeof SafeOperation];

/**
 * Single-call SafeTx with zero gas params (relayer-pays mode — relayer-service ignores
 * the gas fields and uses its own gas-key pool). Mirrors Rust `SafeTransaction::call`.
 */
export function safeCall(to: Address, data: Hex, nonce: bigint): SafeTransaction {
  return {
    to: normalizeAddress(to),
    value: 0n,
    data,
    operation: SafeOperation.CALL,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

/**
 * DelegateCall SafeTx — needed for MultiSend-batched ops. Mirrors Rust
 * `SafeTransaction::delegate_call`.
 */
export function safeDelegateCall(
  multiSendAddress: Address,
  packedData: Hex,
  nonce: bigint,
): SafeTransaction {
  return {
    ...safeCall(multiSendAddress, packedData, nonce),
    operation: SafeOperation.DELEGATE_CALL,
  };
}

// ─── selectors (computed from the exact Rust signature strings) ────────────

/** `keccak256("approve(address,uint256)")[..4]`. */
export const ERC20_APPROVE_SELECTOR: Hex = toFunctionSelector("approve(address,uint256)");
/** `keccak256("setApprovalForAll(address,bool)")[..4]`. */
export const ERC1155_SET_APPROVAL_FOR_ALL_SELECTOR: Hex = toFunctionSelector(
  "setApprovalForAll(address,bool)",
);
/** `keccak256("multiSend(bytes)")[..4]` — `0x8d80ff0a`. */
export const MULTISEND_SELECTOR: Hex = "0x8d80ff0a";
export const SPLIT_POSITION_SELECTOR: Hex = toFunctionSelector(
  "splitPosition(address,bytes32,bytes32,uint256[],uint256)",
);
export const MERGE_POSITIONS_SELECTOR: Hex = toFunctionSelector(
  "mergePositions(address,bytes32,bytes32,uint256[],uint256)",
);
export const REDEEM_POSITIONS_SELECTOR: Hex = toFunctionSelector(
  "redeemPositions(address,bytes32,bytes32,uint256[])",
);

// ─── calldata builders ──────────────────────────────────────────────────────

/**
 * `IERC20.approve(spender, amount)` calldata. Default amount is `uint256::MAX`
 * (the platform's standard unlimited approval).
 */
export function erc20Approve(spender: Address, amount: bigint = maxUint256): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "approve",
    args: [normalizeAddress(spender), amount],
  });
}

/** `IERC1155.setApprovalForAll(operator, approved)` calldata (CTF outcome tokens). */
export function ctfSetApprovalForAll(operator: Address, approved = true): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "setApprovalForAll",
        stateMutability: "nonpayable",
        inputs: [
          { name: "operator", type: "address" },
          { name: "approved", type: "bool" },
        ],
        outputs: [],
      },
    ],
    functionName: "setApprovalForAll",
    args: [normalizeAddress(operator), approved],
  });
}

function assertBytes32(value: Hex, what: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ValidationError(`${what} must be 0x-prefixed 32-byte hex, got "${value}"`);
  }
  return value;
}

/**
 * `ConditionalTokens.splitPosition(collateral, parentCollectionId, conditionId,
 * partition, amount)` calldata. Splits `amount` collateral into a full outcome set.
 * Partition for a full binary split: `[1n, 2n]`.
 *
 * NOTE: the CT contract pulls collateral via `transferFrom(msg.sender, ...)`, so the
 * Safe must hold a USDW allowance for the ConditionalTokens contract itself — the
 * default exchange approval targets do NOT cover it.
 */
export function splitPosition(
  collateral: Address,
  parentCollectionId: Hex,
  conditionId: Hex,
  partition: bigint[],
  amount: bigint,
): Hex {
  return encodeSplitOrMerge(
    "splitPosition",
    collateral,
    parentCollectionId,
    conditionId,
    partition,
    amount,
  );
}

/**
 * `ConditionalTokens.mergePositions(...)` calldata — merge a full outcome set back into
 * collateral. Same argument shape as {@link splitPosition}.
 */
export function mergePositions(
  collateral: Address,
  parentCollectionId: Hex,
  conditionId: Hex,
  partition: bigint[],
  amount: bigint,
): Hex {
  return encodeSplitOrMerge(
    "mergePositions",
    collateral,
    parentCollectionId,
    conditionId,
    partition,
    amount,
  );
}

function encodeSplitOrMerge(
  functionName: "splitPosition" | "mergePositions",
  collateral: Address,
  parentCollectionId: Hex,
  conditionId: Hex,
  partition: bigint[],
  amount: bigint,
): Hex {
  if (partition.length === 0) {
    throw new ValidationError(`${functionName}: partition must not be empty`);
  }
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: functionName,
        stateMutability: "nonpayable",
        inputs: [
          { name: "collateralToken", type: "address" },
          { name: "parentCollectionId", type: "bytes32" },
          { name: "conditionId", type: "bytes32" },
          { name: "partition", type: "uint256[]" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
    ],
    functionName,
    args: [
      normalizeAddress(collateral),
      assertBytes32(parentCollectionId, "parentCollectionId"),
      assertBytes32(conditionId, "conditionId"),
      partition,
      amount,
    ],
  });
}

/**
 * `ConditionalTokens.redeemPositions(collateral, parentCollectionId, conditionId,
 * indexSets)` calldata — claim payout for resolved outcomes. Binary "Yes" = `[1n]`,
 * "No" = `[2n]`.
 */
export function redeemPositions(
  collateral: Address,
  parentCollectionId: Hex,
  conditionId: Hex,
  indexSets: bigint[],
): Hex {
  if (indexSets.length === 0) {
    throw new ValidationError("redeemPositions: indexSets must not be empty");
  }
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "redeemPositions",
        stateMutability: "nonpayable",
        inputs: [
          { name: "collateralToken", type: "address" },
          { name: "parentCollectionId", type: "bytes32" },
          { name: "conditionId", type: "bytes32" },
          { name: "indexSets", type: "uint256[]" },
        ],
        outputs: [],
      },
    ],
    functionName: "redeemPositions",
    args: [
      normalizeAddress(collateral),
      assertBytes32(parentCollectionId, "parentCollectionId"),
      assertBytes32(conditionId, "conditionId"),
      indexSets,
    ],
  });
}

// ─── MultiSend packed encoder (port of safe/multisend.rs) ──────────────────

/**
 * One sub-operation inside a MultiSend batch. Sub-ops are always `Call` (operation
 * byte = 0) inside MultiSend — the outer Safe transaction itself uses `DelegateCall`.
 */
export interface SafeSubOp {
  to: Address;
  /** Defaults to 0 (the common case for approvals / CTF ops). */
  value?: bigint;
  data: Hex;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function hexWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * Encode sub-ops into `MultiSend.multiSend(bytes)` calldata. Output layout (verified
 * against live Monad tx `0xca441323...` in predict-rs):
 *
 * 1. 4-byte selector (`0x8d80ff0a`)
 * 2. 32-byte ABI offset to the bytes data (`0x20`)
 * 3. 32-byte length of the packed sub-ops
 * 4. packed sub-ops: `operation(1) | to(20) | value(32 BE) | dataLen(32 BE) | data`
 * 5. zero-padding to a 32-byte boundary
 *
 * Empty input is rejected (the resulting `Safe.execTransaction` would be a no-op).
 */
export function encodeMultiSend(ops: SafeSubOp[]): Hex {
  if (ops.length === 0) {
    throw new ValidationError("encodeMultiSend: ops list is empty");
  }
  let packed = "";
  for (const op of ops) {
    const data = strip0x(op.data);
    if (data.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(data)) {
      throw new ValidationError(`encodeMultiSend: invalid data hex "${op.data}"`);
    }
    packed += "00"; // operation byte: always Call inside MultiSend
    packed += strip0x(normalizeAddress(op.to));
    packed += hexWord(op.value ?? 0n);
    packed += hexWord(BigInt(data.length / 2));
    packed += data.toLowerCase();
  }
  const packedLen = packed.length / 2;
  const pad = (32 - (packedLen % 32)) % 32;
  return `${MULTISEND_SELECTOR}${hexWord(0x20n)}${hexWord(BigInt(packedLen))}${packed}${"00".repeat(pad)}` as Hex;
}

// ─── CREATE2 proxy-address prediction ──────────────────────────────────────

/**
 * CREATE2 salt for the platform's SafeProxyFactory:
 * `keccak256(abi.encode(user, scopeId))` (both as 32-byte words, user first).
 */
export function computeProxySalt(user: Address, scopeId: ScopeId): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [normalizeAddress(user), scopeId],
    ),
  );
}

export interface ComputeProxyAddressArgs {
  /** SafeProxyFactory address (`networks.contracts.safeProxyFactory`). */
  factory: Address;
  /** Owner EOA. */
  user: Address;
  /** Full 32-byte tenant scope id. */
  scopeId: ScopeId;
  /** `factory.proxyCreationCode()` — must be read from the factory contract. */
  proxyCreationCode: Hex;
  /** `factory.masterCopy()` — the Safe singleton, abi-encoded as the constructor arg. */
  masterCopy: Address;
}

/**
 * Offline CREATE2 prediction of a user's Safe address:
 * `last20(keccak256(0xff ++ factory ++ salt ++ keccak256(proxyCreationCode ++ abi.encode(masterCopy))))`.
 *
 * Requires `proxyCreationCode` + `masterCopy`, which both Rust (`predict-cli wallet
 * deploy-safe` via the `computeProxyAddress(user, scopeId)` factory view) and pm-sdk-go
 * (relayer `GET /deployed`) read from the chain / server rather than hardcode. When you
 * don't have RPC access, prefer `RelayerClient.getDeployed({ signer, scopeId })` —
 * that is the verified production path and what `RelayerService.deploySafe` uses.
 */
export function computeProxyAddress(args: ComputeProxyAddressArgs): Address {
  const initCode =
    `${args.proxyCreationCode}${strip0x(encodeAbiParameters([{ type: "address" }], [normalizeAddress(args.masterCopy)]))}` as Hex;
  const predicted = getCreate2Address({
    from: normalizeAddress(args.factory),
    salt: computeProxySalt(args.user, args.scopeId),
    bytecodeHash: keccak256(initCode),
  });
  return normalizeAddress(predicted);
}
