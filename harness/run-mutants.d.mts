// Types for harness/run-mutants.mjs.
export interface Mutant {
  id: string;
  invariant: string;
  area: string;
  file: string;
  original: string;
  replacement: string;
  description: string;
  equivalentReason?: string;
}
export interface MutantsDocument {
  schemaVersion: number;
  description: string;
  suites: Record<string, string[]>;
  excludedSuites: string[];
  mutants: Mutant[];
}
export interface MutantResult {
  id: string;
  status: "killed" | "survived";
  equivalent: boolean;
  [key: string]: unknown;
}
export interface MutantSummary {
  total: number;
  killed: number;
  survived: string[];
  equivalent: string[];
  equivalentKilled: string[];
  pass: boolean;
}
export declare function loadMutants(file: string): MutantsDocument;
export declare function applyMutant(text: string, mutant: Pick<Mutant, "id" | "file" | "original" | "replacement">): string;
export declare function expandSuites(root: string, patterns: string[], excluded?: string[]): string[];
export declare function summarize(results: MutantResult[]): MutantSummary;
