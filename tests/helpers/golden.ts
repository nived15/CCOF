// Golden files (BUILD-PLAN P4). A golden is rewritten only with CCOF_UPDATE_GOLDEN=1; a golden change needs a stated
// reason in the pull request and the `golden-change` label (.github/copilot-instructions.md rule 4).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GOLDEN_DIR = path.resolve(import.meta.dirname, "..", "golden");
export const updating = process.env.CCOF_UPDATE_GOLDEN === "1";

const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n*$/, "\n");

export function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, name);
}

// Returns the committed golden text, writing `actual` first when updating.
export function readGolden(name: string, actual?: string): string {
  const file = goldenPath(name);
  if (updating && actual !== undefined) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, normalize(actual));
  }
  if (!existsSync(file)) throw new Error(`golden ${name} is missing: create it with CCOF_UPDATE_GOLDEN=1 and review it`);
  return normalize(readFileSync(file, "utf8"));
}

export function readGoldenJson<T>(name: string, actual?: T): T {
  return JSON.parse(readGolden(name, actual === undefined ? undefined : `${JSON.stringify(actual, null, 2)}\n`)) as T;
}

export { normalize as normalizeGoldenText };
