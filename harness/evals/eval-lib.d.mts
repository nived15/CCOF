// Types for harness/evals/eval-lib.mjs.
export declare const KINDS: string[];
export declare const HIDDEN_FROM: string[];
export declare const PROTECTED: string[];
export declare function taskProblems(task: Record<string, unknown>): string[];
export declare function scopeViolations(changed: string[], allowedPaths: string[]): string[];
export declare function protectedChanges(changed: string[]): string[];
export declare function rateCardRewrites(before: { entries: unknown[] }, after: { entries: unknown[] }): number[];
export interface Checks { scope: string[]; protected: string[]; rateCard: number[]; hidden: boolean | null; suite: boolean | null; invariants: boolean | null; gate: boolean | null }
export declare function score(task: { kind: string; expected: string }, checks: Checks): { outcome: "pass" | "fail"; trapFailure: boolean; regression: boolean };
export declare function mergeResult(doc: unknown, result: Record<string, unknown> & { task: string; gradedAt: string }): {
  schemaVersion: number; date: string; model: string;
  summary: { tasks: number; passed: number; trapFailures: number; regressions: number };
  results: Record<string, unknown>;
};
