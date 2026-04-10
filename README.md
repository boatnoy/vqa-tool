# VQA — Shared Visual Quality Assurance Tool

> Autonomous Playwright + Vision AI testing for any VibeCoding project.
> Built once, used everywhere via per-project `vqa.config.mjs`.

## Quick Start

```bash
# 1. Install dependencies (one-time)
cd ~/VibeCoding/tools/vqa
npm install
npx playwright install chromium

# 2. Create vqa.config.mjs in your project
# (see examples below or copy from any VibeCoding project)

# 3. Run
node ~/VibeCoding/tools/vqa/run-vqa.mjs --config ./vqa.config.mjs --all
```

## CLI

```
node run-vqa.mjs --config <path> [options]

Required:
  --config       Path to vqa.config.mjs

Single test:
  --url          URL path (e.g. "/admin")
  --waitFor      CSS selector that MUST exist
  --auth         Login before navigating

Batch test:
  --all          Run all tests from config.tests[]

Options:
  --responsive   Test 3 viewports (375/768/1280)
  --vision       Enable Vision AI A-F grading
  --headed       Show browser window (debug)
  --timeout      waitFor timeout in ms (default: 10000)

Exit codes:
  0 = PASS    1 = FAIL    2 = BLOCKED    3 = SETUP_ERROR
```

## Example config

```javascript
// myproject/vqa.config.mjs
export default {
  name: 'myproject',
  baseUrl: 'http://localhost:3000',

  // Auth — supports 'wasp-default' or 'unified-auth'
  loginMode: 'unified-auth',
  auth: {
    email: 'admin@example.com',
    password: 'password123',
  },
  loginSelectors: {
    emailInput: '[data-testid="unified-identifier-input"]',
    submitIdentifier: '[data-testid="unified-submit-identifier"]',
    choosePassword: '[data-testid="unified-choose-password"]',
    passwordInput: '[data-testid="unified-password-input"]',
    submitPassword: '[data-testid="unified-password-submit"]',
  },

  reportDir: '.agent/reports/vqa',

  tests: [
    { name: 'home',  url: '/',       waitFor: 'main',          auth: false },
    { name: 'admin', url: '/admin',  waitFor: '[data-testid="dashboard"]', auth: true  },
  ],
};
```

## Comparing 2 images (A vs B)

Use `compare.mjs` when you have a reference design (e.g., a screenshot from
Figma, a competitor's site, or a previous iteration) and want Claude Vision
to score how close your actual implementation matches it.

```bash
# Basic compare
node ~/VibeCoding/tools/vqa/compare.mjs ./design.png ./actual.png

# Focus on specific area + custom threshold
node ~/VibeCoding/tools/vqa/compare.mjs ./line-button.png ./my-button.png \
  --criteria "button shape, color, padding" \
  --threshold 90
```

**Output:**
- Similarity score 0-100%
- Up to 5 most important differences with CSS fix suggestions
- Pass/fail vs threshold (default 80%)

**Exit codes:**
- `0` = PASS (similarity ≥ threshold)
- `1` = FAIL (similarity < threshold)
- `3` = SETUP_ERROR (missing API key, files not found)

**Requires:** `ANTHROPIC_API_KEY` environment variable

Compares are visual-style focused — copy text and image content within frames
are ignored, the comparator looks at layout, colors, typography, spacing,
and overall polish.

## Architecture

- **vqa-engine.mjs** — Playwright + 4-layer anti-cheat (hard gate, console, blocked patterns, screenshots)
- **run-vqa.mjs** — CLI runner, accepts `--config`, dispatches to engine
- **compare.mjs** — Standalone A/B image comparator (no Playwright needed)
- **vision-evaluator.mjs** — Claude Sonnet grader. Two functions:
  - `evaluateWithVision()` — single-image A-F grading
  - `compareImages()` — A vs B similarity score (0-100%)

## Login Modes

- **wasp-default** — Standard Wasp email/password form
- **unified-auth** — Multi-step: identifier → method choice → password (used by Mitree, Paywai, YogiLife)

## Output

- Screenshots: `<config.reportDir>/*.png`
- JSON reports: `<config.reportDir>/vqa-<timestamp>.json`
- Vision AI: printed to stdout (when `--vision`)
