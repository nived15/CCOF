// Types for harness/classify-change.mjs (the parts imported by tests).
export interface TierRule {
  id: string;
  tier: string;
  include: string[];
  exclude?: string[];
  [key: string]: unknown;
}
export declare function globToRegExp(glob: string): RegExp;
export declare function rulesFor(file: string, tiers: { rules: TierRule[] }): TierRule[];
export declare function classify(files: string[], tiers: unknown, register: unknown): unknown;
export declare function changedFiles(options: { base: string; head?: string; worktree?: boolean }): string[];
