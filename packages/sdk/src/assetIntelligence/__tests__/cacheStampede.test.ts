import { AssetIntelligence } from '../core/AssetIntelligence';
import type { Asset, AssetIntelligenceConfig, TrustScore } from '../core/types';

const asset: Asset = { code: 'USDC', issuer: 'GISSUER', network: 'testnet' };

function makeConfig(): AssetIntelligenceConfig {
  return {
    cache: {
      memory: { maxSize: 100, ttl: 60_000 },
      persistent: { enabled: false, path: '', ttl: 60_000 },
    } as never,
    providers: {
      metadata: { horizonUrl: 'https://horizon-testnet.stellar.org' },
      price: { sources: [], updateInterval: 60_000 },
      trust: { sources: [], weights: {} },
    },
    invalidation: { priceChangeThreshold: 50, maxAge: 3_600_000 },
    compatibility: { networks: {}, version: { min: '1.0.0', max: '2.0.0' } },
  } as unknown as AssetIntelligenceConfig;
}

function makeTrustScore(overall: number): TrustScore {
  return {
    overall,
    signals: [],
    verificationStatus: 'verified',
    lastUpdated: Date.now(),
  };
}

/**
 * #1041 — concurrent cache misses used to trigger one provider call per caller.
 * These tests pin the coalescing: one call per (asset, operation) in flight, and
 * a fresh attempt after a failure (a failed load must not be cached).
 */
describe('AssetIntelligence in-flight coalescing (#1041)', () => {
  it('calls the trust provider once for concurrent misses', async () => {
    const ai = new AssetIntelligence(makeConfig());
    const scorer = (ai as unknown as { trustScorer: { calculateTrustScore: jest.Mock } }).trustScorer;

    let calls = 0;
    scorer.calculateTrustScore = jest.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return makeTrustScore(90);
    });

    const [a, b, c] = await Promise.all([
      ai.getTrustScore(asset),
      ai.getTrustScore(asset),
      ai.getTrustScore(asset),
    ]);

    expect(calls).toBe(1);
    expect(a.overall).toBe(90);
    expect(b.overall).toBe(90);
    expect(c.overall).toBe(90);
  });

  it('coalesces per asset, not globally', async () => {
    const ai = new AssetIntelligence(makeConfig());
    const scorer = (ai as unknown as { trustScorer: { calculateTrustScore: jest.Mock } }).trustScorer;
    scorer.calculateTrustScore = jest.fn(async () => makeTrustScore(70));

    const other: Asset = { ...asset, code: 'EURC' };
    await Promise.all([ai.getTrustScore(asset), ai.getTrustScore(other)]);

    // Two distinct assets must not share one in-flight entry.
    expect(scorer.calculateTrustScore).toHaveBeenCalledTimes(2);
  });

  it('serves the second wave from cache after the first completes', async () => {
    const ai = new AssetIntelligence(makeConfig());
    const scorer = (ai as unknown as { trustScorer: { calculateTrustScore: jest.Mock } }).trustScorer;
    scorer.calculateTrustScore = jest.fn(async () => makeTrustScore(80));

    await ai.getTrustScore(asset);
    await ai.getTrustScore(asset);

    expect(scorer.calculateTrustScore).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load: the next caller retries', async () => {
    const ai = new AssetIntelligence(makeConfig());
    const scorer = (ai as unknown as { trustScorer: { calculateTrustScore: jest.Mock } }).trustScorer;

    scorer.calculateTrustScore = jest
      .fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce(makeTrustScore(60));

    await expect(ai.getTrustScore(asset)).rejects.toThrow();
    const second = await ai.getTrustScore(asset);

    expect(scorer.calculateTrustScore).toHaveBeenCalledTimes(2);
    expect(second.overall).toBe(60);
  });

  it('does not coalesce different operations on one asset', async () => {
    const ai = new AssetIntelligence(makeConfig());
    const scorer = (ai as unknown as { trustScorer: { calculateTrustScore: jest.Mock } }).trustScorer;
    scorer.calculateTrustScore = jest.fn(async () => makeTrustScore(50));

    await Promise.all([ai.getTrustScore(asset), ai.getAssetPrice(asset)]);

    // Price has its own key; the trust provider still runs exactly once.
    expect(scorer.calculateTrustScore).toHaveBeenCalledTimes(1);
  });
});
