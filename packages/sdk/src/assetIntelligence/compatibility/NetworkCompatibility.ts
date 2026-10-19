/**
 * Network Compatibility
 * Network-specific compatibility rules
 */

import { Asset, Network, CompatibilityResult, CompatibilityContext } from '../core/types';

export interface NetworkRule {
  network: Network;
  allowedOperations: string[];
  blockedIssuers: string[];
  requiredFeatures: string[];
}

export class NetworkCompatibility {
  private rules: Map<Network, NetworkRule>;

  constructor() {
    this.rules = new Map();
    this.initializeRules();
  }

  /**
   * Initialize network rules
   */
  private initializeRules(): void {
    // Public network rules
    this.rules.set('public', {
      network: 'public',
      allowedOperations: ['payment', 'create_account', 'manage_sell_offer', 'manage_buy_offer', 'set_trustline', 'change_trust'],
      blockedIssuers: [],
      requiredFeatures: ['auth_required'],
    });

    // Testnet rules
    this.rules.set('testnet', {
      network: 'testnet',
      allowedOperations: ['payment', 'create_account', 'manage_sell_offer', 'manage_buy_offer', 'set_trustline', 'change_trust'],
      blockedIssuers: [],
      requiredFeatures: [],
    });

    // Futurenet rules
    this.rules.set('futurenet', {
      network: 'futurenet',
      allowedOperations: ['payment', 'create_account', 'manage_sell_offer', 'manage_buy_offer', 'set_trustline', 'change_trust'],
      blockedIssuers: [],
      requiredFeatures: [],
    });

    // Standalone rules
    this.rules.set('standalone', {
      network: 'standalone',
      allowedOperations: ['payment', 'create_account', 'manage_sell_offer', 'manage_buy_offer', 'set_trustline', 'change_trust'],
      blockedIssuers: [],
      requiredFeatures: [],
    });
  }

  /**
   * Check network compatibility
   */
  async checkCompatibility(asset: Asset, context: CompatibilityContext): Promise<CompatibilityResult> {
    const rule = this.rules.get(context.network);
    
    if (!rule) {
      return {
        compatible: false,
        reasons: [`Network ${context.network} not supported`],
        warnings: [],
        lastChecked: Date.now(),
      };
    }

    const reasons: string[] = [];
    const warnings: string[] = [];

    // ── Blocking checks ─────────────────────────────────────────────────────
    // These make the asset unusable for the requested operation, so they belong
    // in `reasons`.
    if (asset.network !== context.network) {
      reasons.push(`Asset network ${asset.network} does not match context network ${context.network}`);
    }

    if (context.operation && !rule.allowedOperations.includes(context.operation)) {
      reasons.push(`Operation ${context.operation} not allowed on network ${context.network}`);
    }

    if (asset.issuer && rule.blockedIssuers.includes(asset.issuer)) {
      reasons.push(`Issuer ${asset.issuer} is blocked on network ${context.network}`);
    }

    // ── Advisory checks (#1039) ─────────────────────────────────────────────
    // Diagnostics that a caller may want to surface but that do not make the
    // asset incompatible. Before this split, every signal was pushed into
    // `reasons` and `warnings` stayed permanently empty, so a caller could not
    // tell an advisory from a hard failure.
    if (!asset.issuer) {
      warnings.push('Asset has no issuer; treating it as a native asset');
    } else if (asset.code.length > 12) {
      warnings.push(`Asset code "${asset.code}" is longer than the 12-character convention`);
    }

    // Check required features (would need metadata)
    // TODO: Implement feature checking when metadata is available

    // Only blocking reasons decide compatibility; warnings are diagnostics.
    const compatible = reasons.length === 0;

    return {
      compatible,
      reasons,
      warnings,
      lastChecked: Date.now(),
    };
  }

  /**
   * Add network rule
   */
  addRule(rule: NetworkRule): void {
    this.rules.set(rule.network, rule);
  }

  /**
   * Update network rule
   */
  updateRule(network: Network, updates: Partial<NetworkRule>): void {
    const existing = this.rules.get(network);
    if (existing) {
      this.rules.set(network, { ...existing, ...updates });
    }
  }

  /**
   * Remove network rule
   */
  removeRule(network: Network): void {
    this.rules.delete(network);
  }

  /**
   * Get network rule
   */
  getRule(network: Network): NetworkRule | undefined {
    return this.rules.get(network);
  }

  /**
   * Get all network rules
   */
  getAllRules(): NetworkRule[] {
    return Array.from(this.rules.values());
  }
}
