import { diffLines, Change } from "diff";
import { logger } from "../logger";

export interface TextDiffResult {
  changedLineCount: number;
  diffSummary: string;
  changes: Change[];
}

// Lines that are expected to change and should be ignored
const IGNORE_PATTERNS = [
  /^\d{1,2}:\d{2}/,                       // timestamps
  /^\d{4}-\d{2}-\d{2}/,                   // dates
  /cart\s*\(\d+\)/i,                       // cart badge counts
  /cookie/i,                               // cookie consent
  /data-section-id/,                       // Shopify dynamic IDs
  /session[_-]?id/i,                       // session tokens
  /csrf/i,                                 // CSRF tokens
  /nonce/i,                                // nonces
];

function isIgnoredChange(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return IGNORE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function compareText(referenceText: string, currentText: string): TextDiffResult {
  const changes = diffLines(referenceText, currentText);

  let changedLineCount = 0;
  const diffParts: string[] = [];

  for (const change of changes) {
    if (change.added || change.removed) {
      const lines = change.value.split("\n").filter((l) => l.trim());
      const meaningfulLines = lines.filter((l) => !isIgnoredChange(l));

      if (meaningfulLines.length > 0) {
        changedLineCount += meaningfulLines.length;
        const prefix = change.added ? "+" : "-";
        for (const line of meaningfulLines) {
          diffParts.push(`${prefix} ${line}`);
        }
      }
    }
  }

  const diffSummary = diffParts.slice(0, 100).join("\n"); // cap diff output for AI prompt

  logger.debug(`Text diff: ${changedLineCount} meaningful line(s) changed`);

  return { changedLineCount, diffSummary, changes };
}
