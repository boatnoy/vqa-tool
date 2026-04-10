#!/usr/bin/env node
/**
 * Universal VQA Runner — CLI tool for autonomous visual quality assurance
 *
 * Ported from YogiLife run-vqa.mjs — parameterized via vqa.config.mjs.
 * No hardcoded ports, auth, or selectors. All logic delegated to VQAEngine.
 *
 * Usage:
 *   node run-vqa.mjs --config ./vqa.config.mjs --url="/admin" --waitFor="aside nav" --auth
 *   node run-vqa.mjs --config ./vqa.config.mjs --all --responsive --vision
 *
 * Exit Codes:
 *   0 = PASS      — all gates passed, content verified
 *   1 = FAIL      — content/assertion/vision failure
 *   2 = BLOCKED   — hard gate (selector not found, page crash, blank page)
 *   3 = SETUP_ERROR — config not found, server not running, bad args
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as path from "path";
import { VQAEngine } from "./vqa-engine.mjs";
import { evaluateWithVision, compareImages } from "./vision-evaluator.mjs";

// ─────────────────────────────────────────────────────────────
// CONSTANTS (must be top-level for hoisting / TDZ)
// ─────────────────────────────────────────────────────────────
const TASK_WORKSPACE_ROOT = path.resolve(".agent/vqa-tasks");

function taskJsonPath(slug) {
  return path.join(TASK_WORKSPACE_ROOT, slug, "task.json");
}

// ─────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    config:     { type: "string" },
    url:        { type: "string" },
    waitFor:    { type: "string" },
    auth:       { type: "boolean", default: false },
    all:        { type: "boolean", default: false },
    responsive: { type: "boolean", default: false },
    vision:     { type: "boolean", default: false },
    headed:     { type: "boolean", default: false },
    timeout:    { type: "string", default: "10000" },
    task:       { type: "string" },     // opt-in: track this run as part of a task workspace
    reference:  { type: "string" },     // opt-in: name (within task) or absolute path to reference image
    threshold:  { type: "string", default: "80" },  // pass threshold for --reference comparison
    help:       { type: "boolean", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
Universal VQA Runner — Shared Tool

USAGE:
  node run-vqa.mjs --config <path> [options]

REQUIRED:
  --config     Path to vqa.config.mjs (project-specific config)

SINGLE TEST:
  --url        URL path to test (e.g. "/admin")
  --waitFor    CSS selector that MUST exist (anti-cheat)
  --auth       Login before navigating

BATCH TEST:
  --all        Run all tests defined in config.tests[]

OPTIONS:
  --responsive Test 3 viewports: mobile (375x812), tablet (768x1024), desktop (1280x800)
  --vision     Enable Vision AI evaluation (needs ANTHROPIC_API_KEY)
  --headed     Show browser window (debug)
  --timeout    waitFor timeout in ms (default: 10000)
  --help       Show this help

TASK MODE (opt-in — for iteration tracking):
  --task <slug>       Save this run as a new iteration of an existing task
                      (use task.mjs create <slug> first to set it up)
  --reference <name>  Compare each screenshot against a reference image.
                      Either an absolute path OR a name in the task's
                      references/ folder (e.g. iter-1-reference.png)
  --threshold <n>     Comparison pass threshold 0-100 (default: 80)

EXIT CODES:
  0 = PASS        1 = FAIL        2 = BLOCKED        3 = SETUP_ERROR

EXAMPLES:
  # Single page check
  node run-vqa.mjs --config ../myproject/vqa.config.mjs --url="/dashboard" --waitFor="h1" --auth

  # Run all tests from config
  node run-vqa.mjs --config ../myproject/vqa.config.mjs --all --responsive --vision
`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// LOAD CONFIG
// ─────────────────────────────────────────────────────────────
if (!args.config) {
  console.error("SETUP_ERROR: --config is required");
  console.error('   Example: --config ./vqa.config.mjs');
  process.exit(3);
}

const configPath = path.resolve(args.config);
if (!fs.existsSync(configPath)) {
  console.error(`SETUP_ERROR: Config file not found: ${configPath}`);
  process.exit(3);
}

let config;
try {
  const imported = await import(pathToFileURL(configPath).href);
  config = imported.default || imported;
} catch (err) {
  console.error(`SETUP_ERROR: Failed to load config: ${err.message}`);
  process.exit(3);
}

if (!config.baseUrl) {
  console.error("SETUP_ERROR: config.baseUrl is required");
  process.exit(3);
}

// ─────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────
if (!args.all && !args.url) {
  console.error("SETUP_ERROR: --url or --all is required");
  console.error('   Example: --url="/admin" or --all');
  process.exit(3);
}

if (args.url && !args.waitFor) {
  console.error("SETUP_ERROR: --waitFor is required when using --url");
  console.error('   Example: --waitFor="aside nav" or --waitFor="h1"');
  process.exit(3);
}

if (args.waitFor === "body") {
  console.error("SETUP_ERROR: --waitFor='body' is BANNED! Use a specific content selector.");
  process.exit(3);
}

if (args.all && (!config.tests || config.tests.length === 0)) {
  console.error("SETUP_ERROR: --all requires config.tests[] to be defined");
  process.exit(3);
}

// Validate task tracking flags
if (args.task) {
  const taskFile = taskJsonPath(args.task);
  if (!fs.existsSync(taskFile)) {
    console.error(`SETUP_ERROR: task workspace not found: ${args.task}`);
    console.error(`   Run: node ~/VibeCoding/tools/vqa/task.mjs create ${args.task}`);
    process.exit(3);
  }
}

if (args.reference && !args.task) {
  console.error("SETUP_ERROR: --reference requires --task");
  console.error("   Comparisons must belong to a task workspace for iteration tracking");
  process.exit(3);
}

const taskThreshold = parseInt(args.threshold, 10);
if (args.reference && (isNaN(taskThreshold) || taskThreshold < 0 || taskThreshold > 100)) {
  console.error(`SETUP_ERROR: --threshold must be 0-100, got: ${args.threshold}`);
  process.exit(3);
}

// ─────────────────────────────────────────────────────────────
// PRE-FLIGHT
// ─────────────────────────────────────────────────────────────
async function preflight() {
  try {
    await fetch(config.baseUrl, { signal: AbortSignal.timeout(5000) });
    console.log(`  Server reachable: ${config.baseUrl}`);
  } catch {
    console.error(`SETUP_ERROR: Server not running at ${config.baseUrl}`);
    console.error("   Start your dev server first");
    process.exit(3);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Build preAction function from test config shorthand.
 * Supports "click:<selector>" syntax.
 */
function buildPreAction(test) {
  if (!test.preAction) return undefined;
  return async (page) => {
    if (test.preAction.startsWith("click:")) {
      const selector = test.preAction.replace("click:", "");
      await page.click(selector);
      if (test.verifyAfter) {
        await page.waitForSelector(test.verifyAfter, { timeout: 5000 });
      }
      await page.waitForTimeout(500);
    }
  };
}

/**
 * Get viewport configurations based on flags.
 */
function getViewports() {
  if (args.responsive) {
    return [
      { viewport: { width: 375, height: 812 }, label: "mobile" },
      { viewport: { width: 768, height: 1024 }, label: "tablet" },
      { viewport: { width: 1280, height: 800 }, label: "desktop" },
    ];
  }
  return [
    { viewport: { width: 1280, height: 800 }, label: "desktop" },
  ];
}

// ─────────────────────────────────────────────────────────────
// TASK WORKSPACE HELPERS (opt-in via --task)
// ─────────────────────────────────────────────────────────────

function loadTaskWorkspace(slug) {
  const p = taskJsonPath(slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveTaskWorkspace(slug, task) {
  fs.writeFileSync(taskJsonPath(slug), JSON.stringify(task, null, 2));
}

/**
 * Resolve --reference value either as absolute path or as a name in the task's
 * references/ folder. Returns absolute path or null if not found.
 */
function resolveReferencePath(slug, refArg) {
  if (!refArg) return null;

  // Try as absolute path first
  const asPath = path.resolve(refArg);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    return asPath;
  }

  // Try as name within the task's references/ folder
  const refsDir = path.join(TASK_WORKSPACE_ROOT, slug, "references");
  if (fs.existsSync(refsDir)) {
    // Exact match (with or without extension)
    const exact = path.join(refsDir, refArg);
    if (fs.existsSync(exact)) return exact;

    // Try common extensions
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      const withExt = path.join(refsDir, refArg + ext);
      if (fs.existsSync(withExt)) return withExt;
    }
  }

  return null;
}

/**
 * After engine runs, persist this run as a new iteration in the task workspace.
 * Optionally compare each screenshot against a reference image via Claude Vision.
 *
 * Returns the iteration result object (also persisted to comparison.json).
 */
async function recordTaskIteration(slug, engine, referencePath, threshold) {
  const task = loadTaskWorkspace(slug);
  if (!task) {
    console.error(`\nTask workspace not found: ${slug}`);
    console.error(`   Run: node ~/VibeCoding/tools/vqa/task.mjs create ${slug}`);
    return null;
  }

  // Auto-increment iteration number
  const iterNum = (task.iterationCount || 0) + 1;
  const iterDir = path.join(TASK_WORKSPACE_ROOT, slug, "iterations", String(iterNum).padStart(3, "0"));
  fs.mkdirSync(iterDir, { recursive: true });

  // Copy all screenshots (ephemeral → permanent)
  const copiedScreenshots = [];
  for (const ss of engine.screenshots) {
    // ss is a basename relative to engine.outDir
    const sourcePath = path.join(engine.outDir, ss);
    if (!fs.existsSync(sourcePath)) continue;
    const destPath = path.join(iterDir, ss);
    fs.copyFileSync(sourcePath, destPath);
    copiedScreenshots.push(ss);
  }

  // Optional: comparison vs reference
  let comparisonResult = null;
  if (referencePath) {
    if (copiedScreenshots.length === 0) {
      console.warn(`\n  No screenshots to compare for iteration ${iterNum}`);
    } else {
      // Compare against the FIRST screenshot (or only one if single test)
      const firstScreenshot = path.join(iterDir, copiedScreenshots[0]);
      console.log(`\n  Recording iteration ${iterNum} for task: ${slug}`);
      const result = await compareImages(referencePath, firstScreenshot, {
        threshold,
      });
      if (result) {
        comparisonResult = result;
        console.log(`     Similarity: ${result.similarity}%  ${result.pass ? "PASS" : "FAIL"} (threshold ${threshold}%)`);
        if (result.differences.length > 0) {
          console.log("     Top differences:");
          result.differences.slice(0, 3).forEach((d, i) => {
            console.log(`       ${i + 1}. ${d.length > 100 ? d.slice(0, 100) + "..." : d}`);
          });
        }
      }
    }
  }

  // Build iteration record
  const iteration = {
    number: iterNum,
    timestamp: new Date().toISOString(),
    screenshots: copiedScreenshots,
    referenceUsed: referencePath ? path.basename(referencePath) : null,
    similarity: comparisonResult?.similarity ?? null,
    pass: comparisonResult?.pass ?? null,
    threshold: referencePath ? threshold : null,
  };

  // Save full comparison.json in iteration folder
  fs.writeFileSync(
    path.join(iterDir, "comparison.json"),
    JSON.stringify({ iteration, comparison: comparisonResult }, null, 2)
  );

  // Update task.json
  task.iterationCount = iterNum;
  task.iterations = task.iterations || [];
  task.iterations.push(iteration);
  task.updatedAt = new Date().toISOString();
  saveTaskWorkspace(slug, task);

  console.log(`  ✓ Iteration ${iterNum} saved to ${path.relative(process.cwd(), iterDir)}`);
  return iteration;
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  const TIMEOUT = parseInt(args.timeout) || 10000;

  console.log("VQA Runner (shared tool)");
  console.log(`   baseUrl:     ${config.baseUrl}`);
  console.log(`   loginMode:   ${config.loginMode || "wasp-default"}`);
  console.log(`   mode:        ${args.all ? "all tests" : args.url}`);
  console.log(`   responsive:  ${args.responsive}`);
  console.log(`   vision:      ${args.vision}`);
  console.log(`   reportDir:   ${config.reportDir || ".agent/reports/vqa"}`);
  if (args.task) console.log(`   task:        ${args.task}`);
  if (args.reference) console.log(`   reference:   ${args.reference} (threshold ${taskThreshold}%)`);
  console.log("");

  await preflight();

  const engine = new VQAEngine(config);
  await engine.init({ headed: args.headed });

  const viewports = getViewports();

  if (args.all) {
    // ── Batch mode: run all tests from config ──
    console.log(`\nRunning ${config.tests.length} test(s) from config...\n`);

    for (const test of config.tests) {
      if (args.responsive) {
        // Responsive mode: test all 3 viewports regardless of config
        for (const vp of viewports) {
          const testName = `${test.name}-${vp.label}`;
          await engine.run({
            name: testName,
            url: test.url,
            viewport: vp.viewport,
            waitForSelector: test.waitFor,
            waitTimeout: test.timeout || TIMEOUT,
            needsAuth: test.auth || false,
            preAction: buildPreAction(test),
            fullPage: test.fullPage || false,
          });
        }
      } else {
        // Normal mode: use viewport from test config (or default desktop)
        await engine.run({
          name: test.name,
          url: test.url,
          viewport: test.viewport || { width: 1280, height: 800 },
          waitForSelector: test.waitFor,
          waitTimeout: test.timeout || TIMEOUT,
          needsAuth: test.auth || false,
          preAction: buildPreAction(test),
          fullPage: test.fullPage || false,
        });
      }
    }
  } else {
    // ── Single URL mode ──
    for (const vp of viewports) {
      const testName = `vqa-${vp.label}`;
      await engine.run({
        name: testName,
        url: args.url,
        viewport: vp.viewport,
        waitForSelector: args.waitFor,
        waitTimeout: TIMEOUT,
        needsAuth: args.auth,
        fullPage: false,
      });
    }
  }

  // ── Vision AI evaluation ──
  let visionResult = null;
  if (args.vision && engine.screenshots.length > 0) {
    visionResult = await evaluateWithVision(engine.screenshots, {
      outDir: engine.outDir,
      projectDescription: config.projectDescription || "a SaaS web application",
    });

    if (visionResult) {
      console.log(`\n  Vision AI Verdict:\n${visionResult.feedback}`);

      // If Vision scores C/D/F, escalate to FAIL
      if (!visionResult.pass) {
        for (const r of engine.results) {
          if (r.pass) {
            r.pass = false;
            r.failReason = `VISION: Score ${visionResult.score} — needs CSS fixes`;
          }
        }
      }
    }
  }

  // ── Task workspace iteration tracking (opt-in via --task) ──
  let taskIteration = null;
  if (args.task) {
    let resolvedRef = null;
    if (args.reference) {
      resolvedRef = resolveReferencePath(args.task, args.reference);
      if (!resolvedRef) {
        console.error(`\n  Reference not found: "${args.reference}"`);
        console.error(`     Tried: absolute path AND .agent/vqa-tasks/${args.task}/references/`);
        // Continue without comparison rather than aborting — screenshots still saved
      }
    }
    taskIteration = await recordTaskIteration(args.task, engine, resolvedRef, taskThreshold);
  }

  // ── Write JSON report ──
  const timestamp = Date.now();
  const report = {
    timestamp: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl,
      loginMode: config.loginMode || "wasp-default",
      responsive: args.responsive,
      vision: args.vision,
    },
    exitCode: engine.results.every((r) => r.pass) ? 0 : 1,
    pass: engine.results.every((r) => r.pass),
    tests: engine.results,
    visionVerdict: visionResult,
    task: args.task || null,
    iteration: taskIteration,
  };

  const reportPath = path.join(engine.outDir, `vqa-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ── Report ──
  engine.report();

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Screenshots: ${engine.outDir}/`);
}

main().catch((err) => {
  console.error(`VQA script crashed: ${err.message}`);
  process.exit(3);
});
