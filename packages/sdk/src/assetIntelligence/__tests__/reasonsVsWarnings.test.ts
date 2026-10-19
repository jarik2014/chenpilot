import {
  NetworkCompatibility,
  type NetworkRule,
} from '../compatibility/NetworkCompatibility';
import type { Asset, CompatibilityContext } from '../core/types';

const rule: NetworkRule = {
  network: 'testnet',
  allowedOperations: ['payment', 'manage_sell_offer'],
  blockedIssuers: ['GBLOCKED'],
  requiredFeatures: [],
};

const context: CompatibilityContext = { network: 'testnet', operation: 'payment' };

function makeChecker() {
  const checker = new NetworkCompatibility();
  checker.addRule(rule);
  return checker;
}

/**
 * #1039 — validation outcomes must land in the right collection: blocking
 * failures in `reasons`, advisory diagnostics in `warnings`. Before this split
 * everything was pushed into `reasons` and `warnings` was always empty, so a
 * caller could not tell an advisory from a hard failure.
 */
describe('NetworkCompatibility reasons vs warnings (#1039)', () => {
  it('reports a fully valid asset with no reasons and no warnings', async () => {
    const checker = makeChecker();
    const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'testnet' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps blocking failures in reasons', async () => {
    const checker = makeChecker();
    const asset: Asset = { code: 'USDC', issuer: 'GBLOCKED', network: 'testnet' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/blocked/i);
    expect(result.warnings).toEqual([]);
  });

  it('keeps a network mismatch blocking', async () => {
    const checker = makeChecker();
    const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'public' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/does not match/i);
  });

  it('puts a warning-only outcome in warnings and stays compatible', async () => {
    const checker = makeChecker();
    // No issuer: advisory (treated as a native asset), not a blocking failure.
    const asset: Asset = { code: 'XLM', network: 'testnet' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/no issuer/i);
  });

  it('flags an over-long asset code as a warning, not a reason', async () => {
    const checker = makeChecker();
    const asset: Asset = { code: 'THIRTEENCHARS', issuer: 'GISSUER', network: 'testnet' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/longer than the 12-character/i);
  });

  it('can report reasons and warnings at the same time', async () => {
    const checker = makeChecker();
    const asset: Asset = { code: 'THIRTEENCHARS', issuer: 'GBLOCKED', network: 'testnet' };

    const result = await checker.checkCompatibility(asset, context);

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/blocked/i);
    expect(result.warnings.join(' ')).toMatch(/12-character/i);
  });

  it('treats a network with no rule as a blocking reason', async () => {
    const checker = makeChecker();
    // Default rules are registered for the known networks; clear them so this
    // exercises the "no rule for this network" branch.
    (checker as unknown as { rules: Map<string, unknown> }).rules.clear();
    const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'futurenet' };

    const result = await checker.checkCompatibility(asset, {
      network: 'futurenet',
      operation: 'payment',
    });

    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/not supported/i);
  });
});
