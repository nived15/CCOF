// Types for harness/run-checks.mjs.
export interface Check { id: string; tier: string; run: string }
export interface Classification {
  tier: string;
  invariants: string[];
  checks: { required: Check[]; pending?: Check[]; manual?: { id: string; tier: string; manual?: string }[] };
  [key: string]: unknown;
}
export interface PlannedRun extends Check { status?: number }
export declare function plannedRuns(classification: Classification): PlannedRun[];
export declare function summaryMarkdown(classification: Classification, results: PlannedRun[]): string;
