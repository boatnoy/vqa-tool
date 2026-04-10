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

## Architecture

- **vqa-engine.mjs** — Playwright + 4-layer anti-cheat (hard gate, console, blocked patterns, screenshots)
- **run-vqa.mjs** — CLI runner, accepts `--config`, dispatches to engine
- **vision-evaluator.mjs** — Optional Claude Sonnet A-F grading (set `ANTHROPIC_API_KEY`)

## Login Modes

- **wasp-default** — Standard Wasp email/password form
- **unified-auth** — Multi-step: identifier → method choice → password (used by Mitree, Paywai, YogiLife)

## Output

- Screenshots: `<config.reportDir>/*.png`
- JSON reports: `<config.reportDir>/vqa-<timestamp>.json`
- Vision AI: printed to stdout (when `--vision`)
