import fs from "fs";
import { compareText } from "./text";
import { SelectorCapture } from "../types";
import { logger } from "../logger";

export interface SelectorDiffEntry {
  index: number;
  selector: string;
  changedLineCount: number;
  diffSummary: string;
  matchedReference: boolean;
  matchedCurrent: boolean;
}

export interface SelectorDiffResult {
  entries: SelectorDiffEntry[];
  changedLineCount: number;
  changedPercent: number;
  diffSummary: string;
  warnings: string[];
}

export interface ReferenceSelectorRecord {
  selector: string;
  textPath: string;
  screenshotPath: string;
}

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export function compareSelectorCaptures(
  reference: ReferenceSelectorRecord[],
  current: SelectorCapture[],
): SelectorDiffResult {
  const entries: SelectorDiffEntry[] = [];
  const warnings: string[] = [];

  const len = Math.max(reference.length, current.length);
  let totalChangedLines = 0;
  let maxChangedPercent = 0;
  const diffParts: string[] = [];

  for (let i = 0; i < len; i++) {
    const ref = reference[i];
    const cur = current[i];
    const selector = cur?.selector ?? ref?.selector ?? `(index ${i})`;

    const refText = ref ? readIfExists(ref.textPath) : "";
    const curText = cur?.text ?? "";

    const matchedReference = refText.length > 0 || (ref != null && fs.existsSync(ref.textPath));
    const matchedCurrent = cur?.matched ?? false;

    if (cur && !cur.matched) {
      warnings.push(`Selector "${selector}" matched zero elements on current page`);
    }
    if (ref && !matchedReference && refText === "") {
      // ref file missing — treat as warning only if we expected one
    }

    const textDiff = compareText(refText, curText);
    totalChangedLines += textDiff.changedLineCount;

    const refLineCount = refText.split("\n").filter((l) => l.trim().length > 0).length || 1;
    const percent = (textDiff.changedLineCount / refLineCount) * 100;
    if (percent > maxChangedPercent) maxChangedPercent = percent;

    if (textDiff.diffSummary) {
      diffParts.push(`[${selector}]\n${textDiff.diffSummary}`);
    }

    entries.push({
      index: i,
      selector,
      changedLineCount: textDiff.changedLineCount,
      diffSummary: textDiff.diffSummary,
      matchedReference,
      matchedCurrent,
    });
  }

  const result: SelectorDiffResult = {
    entries,
    changedLineCount: totalChangedLines,
    changedPercent: maxChangedPercent,
    diffSummary: diffParts.slice(0, 100).join("\n\n"),
    warnings,
  };

  logger.debug(
    `Selector diff: ${entries.length} selector(s), ${totalChangedLines} line(s) changed, max ${maxChangedPercent.toFixed(1)}%`,
  );

  return result;
}
