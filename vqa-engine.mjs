#!/usr/bin/env node
/**
 * VQA Engine — Anti-Cheat Visual Quality Assurance (Shared Tool)
 *
 * Ported from YogiLife vqa-engine.mjs — parameterized for any VibeCoding project.
 * All hardcoded values (ports, auth, selectors) come from config.
 *
 * HARD GATES:
 * 1. waitForSelector — page MUST show real content before screenshot
 * 2. HARD FAIL (exit 1) if content not found within timeout
 * 3. Console error zero tolerance (configurable ignore list)
 * 4. Vision strictness: loading/error/blank = AUTOMATIC FAIL
 *
 * Usage:
 *   import { VQAEngine } from './vqa-engine.mjs';
 *   const vqa = new VQAEngine(config);
 *   await vqa.init();
 *   await vqa.run({ ... });
 *   vqa.report();
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────
// DEFAULT BLOCKED CONTENT PATTERNS
// Projects can extend via config.blockedPatterns
// ─────────────────────────────────────────────────────────────
const DEFAULT_BLOCKED_PATTERNS = [
  "loading", "spinner", "skeleton",
  "not found", "error", "undefined",
];

const DEFAULT_IGNORED_ERRORS = ["favicon.ico"];

export class VQAEngine {
  /**
   * @param {Object} config — from vqa.config.mjs
   * @param {string} config.baseUrl — e.g. "http://localhost:3200"
   * @param {string} [config.reportDir] — output directory (default: '.agent/reports/vqa')
   * @param {Object} [config.auth] — { email, password }
   * @param {string} [config.loginMode] — 'wasp-default' | 'unified-auth'
   * @param {Object} [config.loginSelectors] — CSS selectors for login form
   * @param {string} [config.loginUrl] — login page path (default: '/login')
   * @param {string[]} [config.ignoreErrors] — additional console errors to ignore
   * @param {string[]} [config.blockedPatterns] — additional blocked content patterns
   */
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.outDir = path.resolve(config.reportDir || ".agent/reports/vqa");
    this.ignoreErrors = [
      ...DEFAULT_IGNORED_ERRORS,
      ...(config.ignoreErrors || []),
    ];
    this.blockedPatterns = [
      ...DEFAULT_BLOCKED_PATTERNS,
      ...(config.blockedPatterns || []),
    ];
    this.config = config;
    this.browser = null;
    this.results = [];
    this.assertions = [];
    this.consoleErrors = [];
    this.screenshots = [];

    fs.mkdirSync(this.outDir, { recursive: true });
  }

  async init({ headed = false } = {}) {
    this.browser = await chromium.launch({ headless: !headed });
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  /**
   * Run a single VQA test case.
   *
   * @param {Object} opts
   * @param {string} opts.name — Test name (e.g. "T1-homepage-mobile")
   * @param {string} opts.url — Full URL or path (e.g. "/dashboard")
   * @param {Object} opts.viewport — { width, height }
   * @param {string} opts.waitForSelector — CSS selector that MUST exist before screenshot
   * @param {number} [opts.waitTimeout=10000] — Max ms to wait for selector
   * @param {boolean} [opts.needsAuth=false] — Login before navigating
   * @param {Function} [opts.preAction] — async function(page) before measure
   * @param {Function} [opts.measure] — page.evaluate function to measure DOM
   * @param {Function} [opts.assert] — function(measurements) returns assertions
   * @param {boolean} [opts.fullPage=false] — Capture full page screenshot
   */
  async run(opts) {
    const {
      name,
      url,
      viewport = { width: 375, height: 812 },
      waitForSelector,
      waitTimeout = 10000,
      needsAuth = false,
      preAction,
      measure,
      assert,
      fullPage = false,
    } = opts;

    console.log(`\n>>> ${name}...`);
    this.consoleErrors = [];

    const ctx = await this.browser.newContext({ viewport });
    const page = await ctx.newPage();

    // Attach console error listener
    page.on("pageerror", (ex) => {
      const msg = `[${name} PAGE CRASH]: ${ex.message}`;
      console.error(msg);
      this.consoleErrors.push(msg);
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        const text = m.text();
        if (this.ignoreErrors.some((i) => text.includes(i))) return;
        const msg = `[${name} CONSOLE]: ${text.slice(0, 200)}`;
        console.error(msg);
        this.consoleErrors.push(msg);
      }
    });

    // Auth if needed
    if (needsAuth) {
      await this._login(page, this.config);
    }

    // Navigate
    const fullUrl = url.startsWith("http") ? url : `${this.baseUrl}${url}`;
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(1500);

    // Dismiss cookie banner
    await this._dismissCookies(page);

    // ─────────────────────────────────────────────────────
    // HARD GATE: Wait for real content selector
    // ─────────────────────────────────────────────────────
    if (waitForSelector) {
      console.log(`  Waiting for: ${waitForSelector} (${waitTimeout}ms)...`);
      try {
        await page.waitForSelector(waitForSelector, { timeout: waitTimeout });
        console.log(`  Content found: ${waitForSelector}`);
      } catch {
        // ─── HARD FAIL ───
        const screenshotPath = path.join(this.outDir, `${name}-BLOCKED.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        this.screenshots.push(path.basename(screenshotPath));
        console.error(`\n  VQA BLOCKED: Target content not found!`);
        console.error(`  Selector: "${waitForSelector}" not visible after ${waitTimeout}ms`);
        console.error(`  Are you testing an empty state or loading screen?`);
        console.error(`  Screenshot saved: ${screenshotPath}`);
        console.error(`  TEST FAILED — HARD GATE BLOCKED\n`);

        this.results.push({ test: name, pass: false, blocked: true });
        await ctx.close();

        // Immediate exit — no mercy
        await this.close();
        process.exit(1);
      }
    }

    // Additional wait for render
    await page.waitForTimeout(500);

    // Pre-action hook (e.g. click dropdown, wait for animation)
    if (preAction) {
      await preAction(page);
    }

    // ─────────────────────────────────────────────────────
    // VISION STRICTNESS: Check page isn't blank/error
    // ─────────────────────────────────────────────────────
    const bodyText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");
    for (const pattern of this.blockedPatterns) {
      // Only block if the ENTIRE visible content is dominated by the pattern
      // (e.g., the whole page is just "loading..." or "error")
      if (bodyText.length < 100 && bodyText.includes(pattern)) {
        const screenshotPath = path.join(this.outDir, `${name}-VISION-FAIL.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        this.screenshots.push(path.basename(screenshotPath));
        console.error(`\n  VISION FAIL: Page content appears to be "${pattern}" state`);
        console.error(`  Body text (${bodyText.length} chars): "${bodyText.slice(0, 100)}"`);
        console.error(`  NO REAL CONTENT VISIBLE — test FAILED`);

        this.results.push({ test: name, pass: false, blocked: true, reason: `vision:${pattern}` });
        await ctx.close();
        await this.close();
        process.exit(1);
      }
    }

    // Screenshot
    const screenshotPath = path.join(this.outDir, `${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage });
    this.screenshots.push(path.basename(screenshotPath));
    console.log(`  Screenshot: ${name}.png`);

    // Measurements
    let measurements = null;
    if (measure) {
      measurements = await page.evaluate(measure);
      console.log(`  Measurements:`, JSON.stringify(measurements, null, 2));
    }

    // Assertions
    if (assert && measurements) {
      const asserts = assert(measurements);
      for (const a of asserts) {
        this.assertions.push(a);
        console.log(`  ${a.pass ? "PASS" : "FAIL"} ${a.name}: ${a.detail}`);
      }
    }

    // Console error check
    const hasErrors = this.consoleErrors.length > 0;
    this.results.push({ test: name, pass: !hasErrors });

    await ctx.close();
  }

  /**
   * Print final report. Exits with code 1 if any test failed.
   */
  report() {
    console.log("\n" + "=".repeat(50));
    console.log("  VQA ENGINE — ANTI-CHEAT REPORT");
    console.log("=".repeat(50));

    console.log("  Console Error Tests:");
    let allPass = true;
    for (const r of this.results) {
      const icon = r.pass ? "PASS" : "FAIL";
      const suffix = r.blocked ? " [BLOCKED]" : "";
      console.log(`  [${icon}] ${r.test}${suffix}`);
      if (!r.pass) allPass = false;
    }

    if (this.assertions.length > 0) {
      console.log("-".repeat(50));
      console.log("  Measurement Assertions:");
      for (const a of this.assertions) {
        const icon = a.pass ? "PASS" : "FAIL";
        console.log(`  [${icon}] ${a.name} — ${a.detail}`);
        if (!a.pass) allPass = false;
      }
    }

    console.log("=".repeat(50));
    console.log(allPass
      ? "  ALL VQA CHECKS PASSED"
      : "  SOME VQA CHECKS FAILED");
    console.log("=".repeat(50));

    if (this.assertions.length > 0) {
      console.log("\nDetailed assertions:");
      for (const a of this.assertions) {
        console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.name}: ${a.detail}`);
      }
    }

    console.log(`\nScreenshots: ${this.outDir}`);

    if (!allPass) {
      process.exit(1);
    }
  }

  // ─── Login dispatcher ───

  async _login(page, config) {
    const mode = config.loginMode || "wasp-default";
    if (mode === "unified-auth") {
      await this._loginUnifiedAuth(page, config);
    } else {
      await this._loginWaspDefault(page, config);
    }
  }

  // ─── Login: wasp-default (simple email/password form) ───

  async _loginWaspDefault(page, config) {
    const loginUrl = `${config.baseUrl}${config.loginUrl || "/login"}`;
    await page.goto(loginUrl, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await this._dismissCookies(page);

    const selectors = config.loginSelectors || {};
    const emailInput = selectors.emailInput || 'input[type="email"]';
    const passwordInput = selectors.passwordInput || 'input[type="password"]';
    const submitButton = selectors.submitButton || 'button[type="submit"]';

    await page.fill(emailInput, config.auth.email);
    await page.fill(passwordInput, config.auth.password);
    await page.click(submitButton);
    await page.waitForTimeout(3000);
  }

  // ─── Login: unified-auth (multi-step identifier → password) ───

  async _loginUnifiedAuth(page, config) {
    const loginUrl = `${config.baseUrl}${config.loginUrl || "/login"}`;
    await page.goto(loginUrl, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await this._dismissCookies(page);

    const selectors = config.loginSelectors || {};
    const emailInput = selectors.emailInput || '[data-testid="unified-identifier-input"]';
    const submitIdentifier = selectors.submitIdentifier || '[data-testid="unified-submit-identifier"]';
    const choosePassword = selectors.choosePassword || '[data-testid="unified-choose-password"]';
    const passwordInput = selectors.passwordInput || '[data-testid="unified-password-input"]';
    const submitPassword = selectors.submitPassword || '[data-testid="unified-password-submit"]';

    await page.fill(emailInput, config.auth.email);
    await page.locator(submitIdentifier).click();

    await Promise.race([
      page.locator(passwordInput).waitFor({ timeout: 8000 }),
      page.locator(choosePassword).waitFor({ timeout: 8000 }),
    ]).catch(() => {});

    const choice = page.locator(choosePassword);
    if (await choice.isVisible({ timeout: 2000 }).catch(() => false)) {
      await choice.click();
      await page.locator(passwordInput).waitFor({ timeout: 5000 });
    }

    await page.fill(passwordInput, config.auth.password);
    await page.locator(submitPassword).click();
    await page.waitForTimeout(3000);
  }

  // ─── Cookie banner dismiss ───

  async _dismissCookies(page) {
    for (const sel of [
      ".cm__btn--accept-all",
      "button:has-text('Accept all')",
      "button:has-text('OK')",
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ force: true });
        await page.waitForTimeout(300);
        break;
      }
    }
  }
}
