/**
 * High-level relayer flows: gasless Safe deployment (SAFE-CREATE), Safe meta-tx
 * execution (SAFE), and the production approval / CTF convenience operations.
 *
 * Mirrors pm-sdk-go `pkg/relayer/service.go` and the predict-cli call sites
 * (`safe_create.rs`, `safe_exec.rs`, `approve_commands.rs`, `ctf_commands.rs`):
 *
 * - SAFE-CREATE: `GET /deployed` (predicted address) → sign EIP-712 `CreateProxy`
 *   (v ∈ {27,28}) → `POST /submit` with `SafeCreateParams` → poll. `data` is `"0x"` and
 *   `nonce` is omitted — the relayer rebuilds `createProxy` calldata itself.
 * - SAFE: `GET /nonce` → sign EIP-712 `SafeTx` (v ∈ {27,28}) → `POST /submit` with
 *   zero-gas `SafeTxParams` (relayer-pays) → poll.
 */

import type { PredictSigner } from "../crypto/signer.js";
import { ValidationError } from "../errors.js";
import { getNetwork, type NetworkConfig } from "../networks.js";
import {
  ctfSetApprovalForAll,
  encodeMultiSend,
  erc20Approve,
  mergePositions as mergePositionsCalldata,
  redeemPositions as redeemPositionsCalldata,
  SafeOperation,
  type SafeSubOp,
  safeCall,
  safeDelegateCall,
  splitPosition as splitPositionCalldata,
  ZERO_BYTES32,
} from "../safe/index.js";
import type { Address, Hex, ScopeId } from "../types.js";
import { isZeroScopeId, normalizeAddress, ZERO_ADDRESS } from "../types.js";
import type { RelayerClient } from "./client.js";
import {
  type RelayerTransaction,
  relayerPaysParams,
  type SafeCreateParams,
  type SubmitRequest,
  SubmitType,
  type TransactionState,
} from "./types.js";

export interface RelayerServiceOptions {
  client: RelayerClient;
  /** EOA signer (Safe owner). Its `chainId` must match the network's. */
  signer: PredictSigner;
  /** Network registry entry supplying the contract addresses. Default: monad. */
  network?: NetworkConfig;
  /** Poll interval for terminal-state waits (ms). Default 2000. */
  pollIntervalMs?: number;
  /** Maximum polls per wait. Default 120 (~4 min at the default interval). */
  pollMaxAttempts?: number;
}

/** Result of a confirmed SAFE submission. */
export interface RelayerExecResult {
  transactionId: string;
  transactionHash: string;
  state: TransactionState;
  transaction: RelayerTransaction;
}

export interface DeploySafeResult {
  /** The (deployed or predicted-and-now-deployed) Safe address, lowercase. */
  safeAddress: Address;
  /** True when the Safe already existed — nothing was submitted (idempotent success). */
  alreadyDeployed: boolean;
  transactionId?: string;
  transaction?: RelayerTransaction;
}

export interface ExecSafeTxOptions {
  /** 0 = CALL (default), 1 = DELEGATECALL (MultiSend batches). */
  operation?: SafeOperation;
  /** Native value forwarded by the Safe. Default 0. */
  value?: bigint;
  /** Pin the Safe nonce; defaults to `GET /nonce` from the relayer. */
  nonce?: bigint;
  /** Audit-log tag (`approve` / `ctf-split` / ...). */
  metadata?: string;
  /** Override the signer's scope id for this call. */
  scopeId?: ScopeId;
}

interface CtfCommonArgs {
  conditionId: Hex;
  /** Defaults to the zero collection (top-level condition). */
  parentCollectionId?: Hex;
  /** Defaults to the network's USDW. */
  collateral?: Address;
  /** Target contract; defaults to the network's ConditionalTokens. */
  contract?: Address;
}

export interface SplitMergeArgs extends CtfCommonArgs {
  /** Full binary split/merge: `[1n, 2n]`. Must cover the condition's outcome slots. */
  partition: bigint[];
  /** Collateral / outcome-token amount in raw base units (USDW: 6 decimals). */
  amount: bigint;
}

export interface RedeemArgs extends CtfCommonArgs {
  /** Winning index sets — binary "Yes" = `[1n]`, "No" = `[2n]`. */
  indexSets: bigint[];
}

export class RelayerService {
  readonly client: RelayerClient;
  readonly signer: PredictSigner;
  readonly network: NetworkConfig;
  private readonly pollIntervalMs: number;
  private readonly pollMaxAttempts: number;

  constructor(options: RelayerServiceOptions) {
    this.client = options.client;
    this.signer = options.signer;
    this.network = options.network ?? getNetwork();
    if (this.signer.chainId !== this.network.chainId) {
      throw new ValidationError(
        `signer chainId ${this.signer.chainId} != network "${this.network.name}" chainId ${this.network.chainId}`,
      );
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.pollMaxAttempts = options.pollMaxAttempts ?? 120;
  }

  /**
   * Deploy the EOA's Safe via SAFE-CREATE (one-shot per `(eoa, scopeId)`; gasless —
   * the relayer pays). A non-zero scope id is required. Idempotent: when the Safe
   * already exists, returns it without submitting (the relayer would 409).
   */
  async deploySafe(scopeId?: ScopeId): Promise<DeploySafeResult> {
    const scope = scopeId ?? this.signer.scopeId;
    if (isZeroScopeId(scope)) {
      throw new ValidationError("deploySafe: SAFE-CREATE requires a non-zero scopeId");
    }
    const factory = normalizeAddress(this.network.contracts.safeProxyFactory);
    const eoa = this.signer.address;

    const { deployed, address } = await this.client.getDeployed({ signer: eoa, scopeId: scope });
    if (address === "") {
      throw new ValidationError("deploySafe: relayer returned no predicted address");
    }
    const safeAddress = normalizeAddress(address);
    if (deployed) {
      return { safeAddress, alreadyDeployed: true };
    }

    const signature = await this.signer.signCreateProxy(factory, {
      paymentToken: ZERO_ADDRESS,
      payment: 0n,
      paymentReceiver: ZERO_ADDRESS,
      scopeId: scope,
    });
    const params: SafeCreateParams = {
      paymentToken: ZERO_ADDRESS,
      payment: "0",
      paymentReceiver: ZERO_ADDRESS,
      scopeId: scope,
    };
    const request: SubmitRequest = {
      from: eoa,
      to: factory,
      proxyWallet: safeAddress,
      data: "0x",
      signature,
      signatureParams: params,
      type: SubmitType.SAFE_CREATE,
      scopeId: scope,
      metadata: "safe-create",
    };
    const submitted = await this.client.submit(request);
    const transaction = await this.wait(submitted.transactionID);
    return {
      safeAddress,
      alreadyDeployed: false,
      transactionId: submitted.transactionID,
      transaction,
    };
  }

  /**
   * Execute one Safe meta-tx end to end: resolve the Safe nonce, sign the EIP-712
   * `SafeTx` (zero gas params — relayer-pays), `POST /submit` type SAFE, and poll to
   * the terminal state. Throws `RelayerTxError` on FAILED / DROPPED / INVALID.
   */
  async execSafeTx(
    safe: Address,
    to: Address,
    data: Hex,
    options: ExecSafeTxOptions = {},
  ): Promise<RelayerExecResult> {
    const safeAddress = normalizeAddress(safe);
    const scope = options.scopeId ?? this.signer.scopeId;
    const operation = options.operation ?? SafeOperation.CALL;
    const nonce =
      options.nonce ??
      (isZeroScopeId(scope)
        ? await this.client.getNonce({ safe: safeAddress })
        : await this.client.getNonce({ signer: this.signer.address, scopeId: scope }));

    const safeTx =
      operation === SafeOperation.DELEGATE_CALL
        ? safeDelegateCall(to, data, nonce)
        : safeCall(to, data, nonce);
    if (options.value !== undefined) safeTx.value = options.value;
    const signature = await this.signer.signSafeTx(safeAddress, safeTx);

    const request: SubmitRequest = {
      from: this.signer.address,
      to: safeTx.to,
      proxyWallet: safeAddress,
      data,
      nonce: nonce.toString(),
      signature,
      signatureParams: relayerPaysParams(operation === SafeOperation.DELEGATE_CALL),
      type: SubmitType.SAFE,
    };
    if (!isZeroScopeId(scope)) request.scopeId = scope;
    if (options.metadata !== undefined) request.metadata = options.metadata;

    const submitted = await this.client.submit(request);
    const transaction = await this.wait(submitted.transactionID);
    return {
      transactionId: submitted.transactionID,
      transactionHash: transaction.transactionHash,
      state: transaction.state,
      transaction,
    };
  }

  /**
   * The standard exchange approval targets (predict-cli `approval_targets()`):
   * CtfExchange, NegRiskCtfExchange, NegRiskAdapter.
   */
  approvalTargets(): Address[] {
    const c = this.network.contracts;
    return [
      normalizeAddress(c.ctfExchange),
      normalizeAddress(c.negRiskCtfExchange),
      normalizeAddress(c.negRiskAdapter),
    ];
  }

  /**
   * `USDW.approve(spender, amount)` for each spender (default: the three exchange
   * targets; amount default `uint256::MAX`). One spender → direct call; several →
   * one MultiSend batch.
   */
  approveUsdwForExchange(
    safe: Address,
    options: { spenders?: Address[]; amount?: bigint } = {},
  ): Promise<RelayerExecResult> {
    const usdw = normalizeAddress(this.network.contracts.usdw);
    const spenders = options.spenders ?? this.approvalTargets();
    const ops: SafeSubOp[] = spenders.map((spender) => ({
      to: usdw,
      data: erc20Approve(spender, options.amount),
    }));
    return this.execOps(safe, ops, "approve");
  }

  /**
   * `ConditionalTokens.setApprovalForAll(operator, true)` for each operator (default:
   * the three exchange targets).
   */
  approveCtfForExchange(
    safe: Address,
    options: { operators?: Address[] } = {},
  ): Promise<RelayerExecResult> {
    const ctf = normalizeAddress(this.network.contracts.conditionalTokens);
    const operators = options.operators ?? this.approvalTargets();
    const ops: SafeSubOp[] = operators.map((operator) => ({
      to: ctf,
      data: ctfSetApprovalForAll(operator, true),
    }));
    return this.execOps(safe, ops, "approve");
  }

  /**
   * Fresh-wallet onboarding: USDW.approve(MAX) + CTF.setApprovalForAll(true) for every
   * exchange target, batched in one MultiSend (predict-cli `approve set --asset all`).
   *
   * `includeSplitAllowance` additionally approves USDW for the ConditionalTokens
   * contract itself — required before `splitPosition` (CT pulls collateral via
   * `transferFrom` and is NOT among the default targets).
   */
  approveAll(
    safe: Address,
    options: { includeSplitAllowance?: boolean } = {},
  ): Promise<RelayerExecResult> {
    const usdw = normalizeAddress(this.network.contracts.usdw);
    const ctf = normalizeAddress(this.network.contracts.conditionalTokens);
    const targets = this.approvalTargets();
    const ops: SafeSubOp[] = targets.map((spender) => ({
      to: usdw,
      data: erc20Approve(spender),
    }));
    if (options.includeSplitAllowance === true) {
      ops.push({ to: usdw, data: erc20Approve(ctf) });
    }
    for (const operator of targets) {
      ops.push({ to: ctf, data: ctfSetApprovalForAll(operator, true) });
    }
    return this.execOps(safe, ops, "approve");
  }

  /**
   * Split collateral into a full outcome set —
   * `CT.splitPosition(collateral, parent, condition, partition, amount)`.
   * Requires a USDW allowance for the CT contract (see {@link approveAll}).
   */
  splitPosition(safe: Address, args: SplitMergeArgs): Promise<RelayerExecResult> {
    const calldata = splitPositionCalldata(
      args.collateral ?? this.network.contracts.usdw,
      args.parentCollectionId ?? ZERO_BYTES32,
      args.conditionId,
      args.partition,
      args.amount,
    );
    return this.execSafeTx(safe, this.ctfContract(args), calldata, { metadata: "ctf-split" });
  }

  /** Merge a full outcome set back into collateral — `CT.mergePositions(...)`. */
  mergePositions(safe: Address, args: SplitMergeArgs): Promise<RelayerExecResult> {
    const calldata = mergePositionsCalldata(
      args.collateral ?? this.network.contracts.usdw,
      args.parentCollectionId ?? ZERO_BYTES32,
      args.conditionId,
      args.partition,
      args.amount,
    );
    return this.execSafeTx(safe, this.ctfContract(args), calldata, { metadata: "ctf-merge" });
  }

  /** Redeem resolved winning positions — `CT.redeemPositions(...)`. */
  redeemPositions(safe: Address, args: RedeemArgs): Promise<RelayerExecResult> {
    const calldata = redeemPositionsCalldata(
      args.collateral ?? this.network.contracts.usdw,
      args.parentCollectionId ?? ZERO_BYTES32,
      args.conditionId,
      args.indexSets,
    );
    return this.execSafeTx(safe, this.ctfContract(args), calldata, { metadata: "ctf-redeem" });
  }

  // ─── plumbing ──────────────────────────────────────────────────────────

  private ctfContract(args: CtfCommonArgs): Address {
    return normalizeAddress(args.contract ?? this.network.contracts.conditionalTokens);
  }

  /** Single op → direct CALL; several → DELEGATECALL into MultiSend (CLI behaviour). */
  private execOps(safe: Address, ops: SafeSubOp[], metadata: string): Promise<RelayerExecResult> {
    const first = ops[0];
    if (first === undefined) {
      throw new ValidationError("no operations to execute");
    }
    if (ops.length === 1) {
      return this.execSafeTx(safe, first.to, first.data, { metadata });
    }
    return this.execSafeTx(
      safe,
      normalizeAddress(this.network.contracts.multiSend),
      encodeMultiSend(ops),
      { operation: SafeOperation.DELEGATE_CALL, metadata },
    );
  }

  private wait(txId: string): Promise<RelayerTransaction> {
    return this.client.waitForTransaction(txId, {
      intervalMs: this.pollIntervalMs,
      maxAttempts: this.pollMaxAttempts,
    });
  }
}
