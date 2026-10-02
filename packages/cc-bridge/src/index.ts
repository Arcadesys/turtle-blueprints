import type { Blueprint } from "@tb/blueprint";
import { toGadgetsJson } from "@tb/blueprint/gadgets";

/** A turtle's disk holds 1,000,000 bytes by default (CC:Tweaked computer_space_limit). */
export const TURTLE_DISK_BYTES = 1_000_000;

/** A cc-factory schema: a Building Gadgets 2 template, which cc-factory builds from and BG2 pastes. */
export interface CcSchema {
  text: string;
  warnings: string[];
}

export function exportSchema(bp: Blueprint): CcSchema {
  const text = toGadgetsJson(bp) + "\n";
  const warnings: string[] = [];
  if (bp.blocks.some((b) => b[3].includes("["))) warnings.push("blockstate is in the template but turtles ignore it today");
  if (text.length > TURTLE_DISK_BYTES) {
    warnings.push(`${Math.round(text.length / 1024)} KB is more than a turtle's default 1 MB disk; split the build or raise computer_space_limit`);
  }
  return { text, warnings };
}
