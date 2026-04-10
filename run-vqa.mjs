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
import { evaluateWithVision } from "./vision-evaluator.mjs";

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
  console.log(`   reportDir:   ${config.reportDir || ".agent/reports/vqa"}\n`);

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
