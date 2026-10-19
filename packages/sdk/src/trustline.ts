import { Horizon, Asset, Operation, xdr } from "@stellar/stellar-sdk";
import * as StellarSdk from "@stellar/stellar-sdk";
import { parseScaledAmount } from "./fixedAmount";
import type { AbortSignalLike } from "./types";
import {
  combineSignals,
  throwIfAborted,
  isAbortError,
} from "./abort";

export interface TrustlineCheckResult {
  exists: boolean;
  authorized: boolean;
  details?: Record<string, unknown>;
}

/**
 * Error thrown when an asset transfer is attempted against an account whose
 * trustline for the asset is missing or not authorized (e.g. frozen by the
 * issuer). Fail-closed: any transfer path that checks trustlines must reject
 * with this error instead of submitting a transaction that the network would
 * reject anyway (or worse, allow a frozen asset to move).
 */
export class TrustlineUnauthorizedError extends Error {
  readonly assetCode: string;
  readonly assetIssuer?: string;
  readonly reason: "missing" | "unauthorized" | "account_not_found";

  constructor(
    assetCode: string,
    assetIssuer: string | undefined,
    reason: "missing" | "unauthorized" | "account_not_found",
    message?: string
  ) {
    const defaultMessage =
      reason === "missing"
        ? `Trustline for ${assetCode} does not exist on the account`
        : reason === "unauthorized"
          ? `Trustline for ${assetCode} is not authorized (frozen or unauthorized by issuer)`
          : `Source account not found for trustline check (${assetCode})`;
    super(message || defaultMessage);
    this.name = "TrustlineUnauthorizedError";
    this.assetCode = assetCode;
    this.assetIssuer = assetIssuer;
    this.reason = reason;
  }
}

export interface TrustlinePreview {
  operations: xdr.Operation[];
  transactionXdr: string;
}

export interface TrustlineValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface TrustlineResourceEstimate {
  baseFee: number;
  totalCost: string;
  trustlinesCreated: number;
  trustlinesRemoved: number;
  reservesRequired: string;
}

export interface TrustlineInfo {
  assetCode: string;
  assetIssuer: string;
  balance: string;
}

export interface AssetToTrust {
  assetCode: string;
  assetIssuer: string;
  limit?: string;
}

export interface TrustlineWorkflowConfig {
  horizonUrl?: string;
  networkPassphrase?: string;
  sourceSecret?: string;
  source?: string;
}

export enum TrustlineWorkflowStep {
  IDLE = "idle",
  PREVIEWING = "previewing",
  VALIDATING = "validating",
  ESTIMATING = "estimating",
  BUILDING = "building",
  READY = "ready",
}

export interface TrustlineWorkflowPreview {
  assetsToTrust: AssetToTrust[];
  existingTrustlines: TrustlineInfo[];
  operations: xdr.Operation[];
  transactionXdr: string;
  sourceAccount?: string;
  trustlinesToRemove?: TrustlineInfo[];
}

export interface TrustlineWorkflowValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  accountExists: boolean;
  missingTrustlines: AssetToTrust[];
  existingTrustlines: TrustlineInfo[];
}

export interface TrustlineWorkflowResourceEstimate {
  baseFee: number;
  totalCost: string;
  trustlinesCreated: number;
  trustlinesRemoved: number;
  reservesRequired: string;
  operationCount: number;
}

export interface TrustlineWorkflowResult {
  transactionXdr: string;
  signedTransactionXdr?: string;
  operations: xdr.Operation[];
  resourceEstimate: TrustlineWorkflowResourceEstimate;
}

export async function resolveIssuerFromDomain(
  domain: string,
  assetCode: string,
  timeout?: number,
  signal?: AbortSignalLike
): Promise<string | undefined> {
  try {
    const url = `https://${domain}/.well-known/stellar.toml`;
    const combined = combineSignals(timeout, signal);
    try {
      throwIfAborted(combined.signal);
      const response = await fetch(url, {
        signal: combined.signal as AbortSignal | undefined,
      });
      if (!response.ok) return undefined;

      const text = await response.text();
      const currenciesMatch = text.match(/\[\[CURRENCIES\]\]([\s\S]*?)(?=\[\[|$)/g);
      if (!currenciesMatch) return undefined;

      for (const currencyBlock of currenciesMatch) {
        const codeMatch = currencyBlock.match(/code\s*=\s*["'](.+?)["']/);
        const issuerMatch = currencyBlock.match(/issuer\s*=\s*["'](.+?)["']/);

        if (
          codeMatch &&
          codeMatch[1].toUpperCase() === assetCode.toUpperCase() &&
          issuerMatch
        ) {
          return issuerMatch[1];
        }
      }
      return undefined;
    } finally {
      combined.cleanup();
    }
  } catch (error) {
    // Cancellation must propagate unmasked.
    if (isAbortError(error)) {
      throw error;
    }
    console.error(`Error resolving issuer from domain ${domain}:`, error);
    return undefined;
  }
}

export async function hasValidStellarTrustline(
  horizonUrl: string | undefined,
  accountId: string,
  assetCode: string,
  assetIssuer?: string
): Promise<TrustlineCheckResult> {
  const server = new Horizon.Server(horizonUrl || "https://horizon.stellar.org");

  if (!assetCode || assetCode.toUpperCase() === "XLM") {
    return { exists: true, authorized: true };
  }

  let account: any;
  try {
    account = await server.accounts().accountId(accountId).call();
  } catch (err) {
    return {
      exists: false,
      authorized: false,
      details: { error: String(err) },
    };
  }

  const balances: Record<string, unknown>[] = (account.balances as unknown as Record<string, unknown>[]) || [];
  const match = balances.find((b) => {
    return (
      b['asset_code'] === assetCode &&
      (assetIssuer ? b['asset_issuer'] === assetIssuer : true)
    );
  });

  if (!match) {
    return { exists: false, authorized: false };
  }

  const authorized =
    (match.is_authorized as boolean) ??
    (match.authorized as boolean) ??
    (match.authorized_to_maintain_liabilities as boolean) ??
    true;

  return { exists: true, authorized, details: { balance: match } };
}

/** Asset roles a transfer can involve; every one of them must be authorized. */
export type TransferAssetRole = "source" | "destination" | "path";

function isNativeAsset(asset: unknown): boolean {
  if (typeof asset === "string") return asset.toUpperCase() === "XLM";
  const a = asset as { isNative?(): boolean; getCode?(): string };
  if (typeof a?.isNative === "function") return a.isNative();
  if (typeof a?.getCode === "function") {
    return a.getCode().toUpperCase() === "XLM";
  }
  return false;
}

function assetCodeOf(asset: unknown): string {
  if (typeof asset === "string") return asset;
  const a = asset as { getCode?(): string; code?: string };
  if (typeof a?.getCode === "function") return a.getCode();
  return a?.code ?? "UNKNOWN";
}

function assetIssuerOf(asset: unknown): string | undefined {
  if (typeof asset === "string") return undefined;
  const a = asset as { getIssuer?(): string; issuer?: string };
  if (typeof a?.getIssuer === "function") return a.getIssuer();
  return a?.issuer;
}

/**
 * Preflight check that the given account holds an authorized trustline for an
 * asset involved in a transfer. Native XLM is always authorized.
 *
 * @param horizonUrl - Horizon endpoint (falls back to the public network)
 * @param accountId - Account sending (or receiving, via explicit role) the asset
 * @param asset - Asset code string or a Stellar SDK Asset instance
 * @param role - Why the asset is involved (used in error messages)
 * @param assetIssuer - Optional issuer when passing a plain code string
 * @throws TrustlineUnauthorizedError when the trustline is missing/unauthorized
 */
export async function assertTrustlineAuthorized(
  horizonUrl: string | undefined,
  accountId: string,
  asset: string | { getCode?(): string; isNative?(): boolean; getIssuer?(): string; issuer?: string },
  role: TransferAssetRole = "source",
  assetIssuer?: string
): Promise<TrustlineCheckResult> {
  if (isNativeAsset(asset)) {
    return { exists: true, authorized: true };
  }

  const code = assetCodeOf(asset);
  const issuer = assetIssuer ?? assetIssuerOf(asset);
  const check = await hasValidStellarTrustline(horizonUrl, accountId, code, issuer);

  if (!check.exists) {
    throw new TrustlineUnauthorizedError(
      code,
      issuer,
      check.details?.error ? "account_not_found" : "missing",
      `Transfer blocked: ${role} asset ${code} has no trustline on account ${accountId}`
    );
  }
  if (!check.authorized) {
    throw new TrustlineUnauthorizedError(
      code,
      issuer,
      "unauthorized",
      `Transfer blocked: ${role} asset ${code} trustline is not authorized (frozen) on account ${accountId}`
    );
  }
  return check;
}

/**
 * Enforce trustline authorization for every asset involved in an asset
 * transfer against the given account, fail-closed.
 *
 * Transfer paths (payments, path payments, swaps) must call this before
 * building/signing the transaction so frozen or missing trustlines are
 * rejected deterministically instead of at submission time.
 *
 * @param horizonUrl - Horizon endpoint (falls back to the public network)
 * @param accountId - Account whose trustlines are checked (typically the sender)
 * @param assets - Assets involved in the transfer; duplicates are checked once
 * @throws TrustlineUnauthorizedError on the first unauthorized/missing trustline
 */
export async function assertTrustlinesForTransfer(
  horizonUrl: string | undefined,
  accountId: string,
  assets: Array<
    string | { getCode?(): string; isNative?(): boolean; getIssuer?(): string; issuer?: string }
  >
): Promise<TrustlineCheckResult[]> {
  const results: TrustlineCheckResult[] = [];
  const seen = new Set<string>();

  for (const asset of assets) {
    if (isNativeAsset(asset)) continue;
    const key = `${assetCodeOf(asset)}:${assetIssuerOf(asset) ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await assertTrustlineAuthorized(horizonUrl, accountId, asset));
  }
  return results;
}

export async function findZeroBalanceTrustlines(
  horizonUrl: string | undefined,
  accountId: string
): Promise<TrustlineInfo[]> {
  const server = new Horizon.Server(horizonUrl || "https://horizon.stellar.org");
  const account = await server.accounts().accountId(accountId).call();
  const balances: Record<string, unknown>[] = (account.balances as unknown as Record<string, unknown>[]) || [];

  return balances
    .filter((b) => b['asset_type'] !== "native" && parseScaledAmount(b['balance'] as string, 7) === 0n)
    .map((b) => ({
      assetCode: b['asset_code'] as string,
      assetIssuer: b['asset_issuer'] as string,
      balance: b['balance'] as string,
    }));
}

export function buildTrustlineRemovalOps(
  trustlines: TrustlineInfo[]
): xdr.Operation[] {
  return trustlines.map((t) =>
    Operation.changeTrust({
      asset: new Asset(t.assetCode, t.assetIssuer),
      limit: "0",
    })
  );
}

export interface AccountMergeBlocker {
  type: 'trustline' | 'data_entry' | 'offers' | 'signers';
  description: string;
  cleanupInstructions: string;
  affectedItems?: string[];
}

export interface AccountMergePreflightResult {
  canMerge: boolean;
  blockers: AccountMergeBlocker[];
}

export async function checkAccountMergeBlockers(
  horizonUrl: string | undefined,
  accountId: string
): Promise<AccountMergePreflightResult> {
  const server = new Horizon.Server(horizonUrl || "https://horizon.stellar.org");
  const blockers: AccountMergeBlocker[] = [];

  try {
    const account = await server.accounts().accountId(accountId).call();
    const balances: Record<string, unknown>[] = (account.balances as unknown as Record<string, unknown>[]) || [];

    // Check for non-zero balance trustlines
    const nonZeroTrustlines = balances
      .filter((b) => b['asset_type'] !== "native" && parseScaledAmount(b['balance'] as string, 7) !== 0n)
      .map((b) => `${b['asset_code']}:${b['asset_issuer']}`);

    if (nonZeroTrustlines.length > 0) {
      blockers.push({
        type: 'trustline',
        description: `${nonZeroTrustlines.length} trustline(s) with non-zero balance`,
        cleanupInstructions: 'Send all asset balances to another account or use payment operations to reduce balances to zero before merging',
        affectedItems: nonZeroTrustlines,
      });
    }

    // Check for zero-balance trustlines
    const zeroBalanceTrustlines = balances
      .filter((b) => b['asset_type'] !== "native" && parseScaledAmount(b['balance'] as string, 7) === 0n)
      .map((b) => `${b['asset_code']}:${b['asset_issuer']}`);

    if (zeroBalanceTrustlines.length > 0) {
      blockers.push({
        type: 'trustline',
        description: `${zeroBalanceTrustlines.length} zero-balance trustline(s) must be removed`,
        cleanupInstructions: 'Use changeTrust operations with limit "0" to remove these trustlines before merging',
        affectedItems: zeroBalanceTrustlines,
      });
    }

    // Check for data entries
    const dataEntries = Object.keys((account as any).data || {});
    if (dataEntries.length > 0) {
      blockers.push({
        type: 'data_entry',
        description: `${dataEntries.length} data entry/entries must be removed`,
        cleanupInstructions: 'Use manageData operations with null value to remove all data entries before merging',
        affectedItems: dataEntries,
      });
    }

    // Check for open offers
    const offersResponse = await server.offers().forAccount(accountId).limit(200).call();
    const offers = ((offersResponse.records || []) as unknown) as Array<Record<string, unknown>>;
    if (offers.length > 0) {
      blockers.push({
        type: 'offers',
        description: `${offers.length} open offer(s) must be cancelled`,
        cleanupInstructions: 'Use manageSellOffer or manageBuyOffer operations with amount "0" to cancel all open offers before merging',
        affectedItems: offers.map((o) => `Offer #${o['id']}`),
      });
    }

    // Check for additional signers
    const signers = ((account as any).signers || []) as Array<Record<string, unknown>>;
    const additionalSigners = signers.filter((s) => s['key'] !== accountId);
    if (additionalSigners.length > 0) {
      blockers.push({
        type: 'signers',
        description: `${additionalSigners.length} additional signer(s) must be removed`,
        cleanupInstructions: 'Use setOptions operations with weight 0 to remove all additional signers before merging',
        affectedItems: additionalSigners.map((s) => s['key'] as string),
      });
    }

  } catch (error) {
    throw new Error(`Failed to check account merge blockers: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    canMerge: blockers.length === 0,
    blockers,
  };
}

export async function createTrustlineOperation(
  assetCode: string,
  assetIssuer: string,
  limit?: string,
  timeout?: number,
  signal?: AbortSignalLike
): Promise<xdr.Operation> {
  let issuer = assetIssuer;

  if (assetIssuer.includes(".") && !assetIssuer.startsWith("G")) {
    const resolvedIssuer = await resolveIssuerFromDomain(
      assetIssuer,
      assetCode,
      timeout,
      signal
    );
    if (!resolvedIssuer) {
      throw new Error(
        `Could not resolve issuer for ${assetCode} from domain ${assetIssuer}`
      );
    }
    issuer = resolvedIssuer;
  }

  const asset = new Asset(assetCode, issuer);
  return Operation.changeTrust({
    asset,
    limit,
  });
}

export function validateDestinationReceivingCapacity(
  trustline: TrustlineRecord | null,
  amount: string
): boolean {
  if (!trustline || !trustline.authorized) return false;

  const balanceNum = parseFloat(trustline.balance);
  const limitNum = parseFloat(trustline.limit);
  const buyingLiabilitiesNum = parseFloat(trustline.buyingLiabilities || '0');
  const amountNum = parseFloat(amount);

  const availableCapacity = limitNum - (balanceNum + buyingLiabilitiesNum);
  return amountNum <= availableCapacity;
}

export class TrustlineWorkflowBuilder {
  private assets: AssetToTrust[] = [];
  private trustlinesToRemove: TrustlineInfo[] = [];
  private config: TrustlineWorkflowConfig;
  private step: TrustlineWorkflowStep = TrustlineWorkflowStep.IDLE;

  constructor(config: TrustlineWorkflowConfig = {}) {
    this.config = {
      horizonUrl: config.horizonUrl || "https://horizon.stellar.org",
      networkPassphrase: config.networkPassphrase || StellarSdk.Networks.PUBLIC,
      sourceSecret: config.sourceSecret ?? "",
      source: config.source ?? "",
    };
  }

  addTrustline(assetCode: string, assetIssuer: string, limit?: string): this {
    this.assets.push({ assetCode, assetIssuer, limit });
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  addTrustlines(assets: AssetToTrust[]): this {
    this.assets.push(...assets);
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  addTrustlineRemoval(assetCode: string, assetIssuer: string): this {
    this.trustlinesToRemove.push({ assetCode, assetIssuer, balance: "0" });
    this.step = TrustlineWorkflowStep.BUILDING;
    return this;
  }

  async preview(): Promise<TrustlineWorkflowPreview> {
    this.step = TrustlineWorkflowStep.PREVIEWING;

    const server = new Horizon.Server(
      this.config.horizonUrl || "https://horizon.stellar.org"
    );
    const existingTrustlines: TrustlineInfo[] = [];
    let sourceAccount: string | undefined;

    if (this.config.source) {
      try {
        const account = await server.accounts().accountId(this.config.source).call();
        const trustlines = (account.balances as unknown as Record<string, unknown>[])
          .filter((b) => b['asset_type'] !== "native")
          .map((b) => ({
            assetCode: b['asset_code'] as string,
            assetIssuer: b['asset_issuer'] as string,
            balance: b['balance'] as string,
          }));
        existingTrustlines.push(...trustlines);
        sourceAccount = this.config.source;
      } catch {
        // Account may not exist
      }
    }

    const resolvedAssets = await Promise.all(
      this.assets.map(async (a) => {
        if (a.assetIssuer.includes(".") && !a.assetIssuer.startsWith("G")) {
          const issuer = await resolveIssuerFromDomain(a.assetIssuer, a.assetCode);
          return issuer ? { ...a, assetIssuer: issuer } : a;
        }
        return a;
      })
    );

    const operations: xdr.Operation[] = [
      ...resolvedAssets.map((a) =>
        Operation.changeTrust({
          asset: new Asset(a.assetCode, a.assetIssuer),
          limit: a.limit,
        })
      ),
      ...this.trustlinesToRemove.map((t) =>
        Operation.changeTrust({
          asset: new Asset(t.assetCode, t.assetIssuer),
          limit: "0",
        })
      ),
    ];

    let transactionXdr = "";
    if (sourceAccount) {
      const tx = new StellarSdk.TransactionBuilder(
        new StellarSdk.Account(sourceAccount, "0"),
        {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        }
      );
      operations.forEach((op) => tx.addOperation(op));
      transactionXdr = tx.setTimeout(30).build().toXDR();
    }

    return {
      assetsToTrust: resolvedAssets,
      existingTrustlines,
      trustlinesToRemove: this.trustlinesToRemove,
      operations,
      transactionXdr,
      sourceAccount,
    };
  }

  async validate(): Promise<TrustlineWorkflowValidation> {
    this.step = TrustlineWorkflowStep.VALIDATING;

    const errors: string[] = [];
    const warnings: string[] = [];
    let accountExists = false;
    const existingTrustlines: TrustlineInfo[] = [];
    const server = new Horizon.Server(
      this.config.horizonUrl || "https://horizon.stellar.org"
    );

    if (this.config.source) {
      try {
        const account = await server.accounts().accountId(this.config.source).call();
        const trustlines = (account.balances as unknown as Record<string, unknown>[])
          .filter((b) => b['asset_type'] !== "native")
          .map((b) => ({
            assetCode: b['asset_code'] as string,
            assetIssuer: b['asset_issuer'] as string,
            balance: b['balance'] as string,
          }));
        existingTrustlines.push(...trustlines);
        accountExists = true;
      } catch {
        errors.push(`Source account ${this.config.source} not found`);
      }
    } else {
      errors.push("Source account is required for validation");
    }

    const resolvedAssets = await Promise.all(
      this.assets.map(async (a) => {
        if (a.assetIssuer.includes(".") && !a.assetIssuer.startsWith("G")) {
          const issuer = await resolveIssuerFromDomain(a.assetIssuer, a.assetCode);
          return issuer ? { ...a, assetIssuer: issuer } : a;
        }
        return a;
      })
    );

    resolvedAssets.forEach((a) => {
      const hasExisting = existingTrustlines.some(
        (t) => t.assetCode === a.assetCode && t.assetIssuer === a.assetIssuer
      );
      if (hasExisting) {
        warnings.push(
          `Trustline for ${a.assetCode} already exists on account`
        );
      }
    });

    const missingTrustlines = resolvedAssets.filter((a) => {
      return !existingTrustlines.some(
        (t) => t.assetCode === a.assetCode && t.assetIssuer === a.assetIssuer
      );
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      accountExists,
      missingTrustlines,
      existingTrustlines,
    };
  }

  estimate(previewResult?: TrustlineWorkflowPreview): TrustlineWorkflowResourceEstimate {
    this.step = TrustlineWorkflowStep.ESTIMATING;

    const preview = previewResult || { assetsToTrust: [], trustlinesToRemove: [] };
    const trustlinesToRemove = preview.trustlinesToRemove || [];
    const operationCount = preview.assetsToTrust.length + trustlinesToRemove.length;
    const trustlinesCreated = preview.assetsToTrust.length;
    const trustlinesRemoved = trustlinesToRemove.length;
    const reservesRequired = trustlinesCreated.toString();

    return {
      baseFee: 100,
      totalCost: operationCount.toString(),
      trustlinesCreated,
      trustlinesRemoved,
      reservesRequired,
      operationCount,
    };
  }
  async build(): Promise<TrustlineWorkflowResult> {
    const preview = await this.preview();
    const estimate = this.estimate(preview);

    return {
      transactionXdr: preview.transactionXdr,
      operations: preview.operations,
      resourceEstimate: estimate,
    };
  }

  getCurrentStep(): TrustlineWorkflowStep {
    return this.step;
  }
}

export default hasValidStellarTrustline;

