#!/usr/bin/env node
/**
 * compare.mjs — Standalone Image A vs B Comparison CLI
 *
 * Compares two images using Claude Vision AI and reports a similarity
 * score (0-100%) plus a list of differences with CSS fix suggestions.
 *
 * Usage:
 *   node compare.mjs <reference.png> <actual.png>
 *                    [--criteria "focus on button styling"]
 *                    [--threshold 80]
 *
 * Exit codes:
 *   0 = PASS         — similarity >= threshold
 *   1 = FAIL         — similarity < threshold
 *   3 = SETUP_ERROR  — missing API key, missing files, bad args
 */

import { parseArgs } from "node:util";
import * as fs from "fs";
import * as path from "path";
import { compareImages } from "./vision-evaluator.mjs";

// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────
const { values: flags, positionals } = parseArgs({
  options: {
    criteria:  { type: "string" },
    threshold: { type: "string", default: "80" },
    help:      { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (flags.help || positionals.length === 0) {
  console.log(`
compare.mjs — Image A vs B comparison via Claude Vision

USAGE:
  node compare.mjs <reference.png> <actual.png> [options]

ARGUMENTS:
  reference   Path to the reference (target) image
  actual      Path to the actual (agent's output) image

OPTIONS:
  --criteria  Focus area, e.g. "button styling, ignore copy"
  --threshold Pass threshold 0-100 (default: 80)
  --help      Show this help

EXIT CODES:
  0 = PASS        similarity >= threshold
  1 = FAIL        similarity < threshold
  3 = SETUP_ERROR missing API key or files

EXAMPLES:
  # Compare two screenshots
  node compare.mjs ./design.png ./screenshot.png

  # With focus area + custom threshold
  node compare.mjs ./line-button.png ./my-button.png \\
    --criteria "button shape, color, padding" \\
    --threshold 90

REQUIREMENTS:
  ANTHROPIC_API_KEY env variable must be set.
`);
  process.exit(positionals.length === 0 && !flags.help ? 3 : 0);
}

if (positionals.length !== 2) {
  console.error("SETUP_ERROR: exactly 2 positional arguments required (reference + actual)");
  console.error("   Run with --help for usage");
  process.exit(3);
}

const [referenceArg, actualArg] = positionals;
const referencePath = path.resolve(referenceArg);
const actualPath = path.resolve(actualArg);

if (!fs.existsSync(referencePath)) {
  console.error(`SETUP_ERROR: reference image not found: ${referencePath}`);
  process.exit(3);
}
if (!fs.existsSync(actualPath)) {
  console.error(`SETUP_ERROR: actual image not found: ${actualPath}`);
  process.exit(3);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("SETUP_ERROR: ANTHROPIC_API_KEY environment variable required");
  console.error("   export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(3);
}

const threshold = parseInt(flags.threshold, 10);
if (isNaN(threshold) || threshold < 0 || threshold > 100) {
  console.error(`SETUP_ERROR: --threshold must be 0-100, got: ${flags.threshold}`);
  process.exit(3);
}

// ─────────────────────────────────────────────────────────────
// Run comparison
// ─────────────────────────────────────────────────────────────
console.log("VQA Image Comparator");
console.log(`   Reference:  ${path.relative(process.cwd(), referencePath)}`);
console.log(`   Actual:     ${path.relative(process.cwd(), actualPath)}`);
console.log(`   Threshold:  ${threshold}%`);
if (flags.criteria) console.log(`   Criteria:   ${flags.criteria}`);

const result = await compareImages(referencePath, actualPath, {
  criteria: flags.criteria || "",
  threshold,
});

if (!result) {
  console.error("\nFAILED: comparison returned no result (API error or missing key)");
  process.exit(3);
}

// ─────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`  COMPARISON RESULT — Similarity: ${result.similarity}%`);
console.log("=".repeat(60));

if (result.differences.length > 0) {
  console.log("\n  Top differences:");
  for (let i = 0; i < result.differences.length; i++) {
    console.log(`  ${i + 1}. ${result.differences[i]}`);
  }
}

console.log("\n  Full feedback:");
console.log("  " + result.rawFeedback.replace(/\n/g, "\n  "));

console.log("\n" + "=".repeat(60));

if (result.pass) {
  console.log(`  PASS (${result.similarity}% >= ${threshold}%)`);
  process.exit(0);
} else {
  console.log(`  FAIL (${result.similarity}% < ${threshold}%)`);
  process.exit(1);
}
