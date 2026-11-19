// Types for harness/pseudonymize-fixture.mjs (imported by tests/harness-fixture-clean.test.ts).
export interface FixtureFile { name: string; text: string }
export interface MapEntry { kind: string; n: number; fake: string }
export declare const FIXTURE_ROOT: string;
export declare const OUTPUT_DIR: string;
export declare const PUBLIC_HOSTS: Set<string>;
export declare function isAllowedGuid(guid: string): boolean;
export declare function scanForLeaks(text: string): string[];
export declare function findOriginals(files: FixtureFile[]): Map<string, { value: string; kind: string }>;
export declare function pseudonymize(files: FixtureFile[], existingMap?: Record<string, MapEntry>): {
  files: FixtureFile[];
  map: Record<string, MapEntry>;
  problems: string[];
};
export declare function main(argv: string[]): number;
