#!/usr/bin/env node
/**
 * task.mjs — VQA Task Workspace Manager
 *
 * Manages per-task workspaces for iteration-based VQA workflows.
 * Each task has references (target designs) + iterations (agent attempts)
 * + comparison results, all preserved in .agent/vqa-tasks/<slug>/.
 *
 * Usage:
 *   node task.mjs create <slug> [--name "Friendly title"]
 *   node task.mjs add-ref <slug> <image-path>
 *   node task.mjs list
 *   node task.mjs info <slug>
 *
 * Workspace layout (relative to current working directory):
 *   .agent/vqa-tasks/<slug>/
 *   ├── task.json                   ← metadata + state
 *   ├── references/
 *   │   └── iter-1-reference.png    ← copied from user input (cp not mv)
 *   └── iterations/                  ← created by run-vqa.mjs --task
 *       ├── 001/
 *       │   ├── screenshot.png
 *       │   └── comparison.json
 *       └── ...
 *
 * Exit codes:
 *   0 = OK
 *   1 = task not found / already exists
 *   3 = SETUP_ERROR (bad args, missing source file)
 */

import * as fs from "fs";
import * as path from "path";

const WORKSPACE_ROOT = path.resolve(".agent/vqa-tasks");

// ─────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
task.mjs — VQA Task Workspace Manager

USAGE:
  node task.mjs <command> [args...]

COMMANDS:
  create <slug> [--name "title"]    Create a new task workspace
  add-ref <slug> <image-path>       Copy a reference image into the task
  list                              List all tasks
  info <slug>                       Show task details + iteration count
  help                              Show this help

EXAMPLES:
  node ~/VibeCoding/tools/vqa/task.mjs create page-builder-polish
  node ~/VibeCoding/tools/vqa/task.mjs add-ref page-builder-polish ~/Downloads/design.png
  node ~/VibeCoding/tools/vqa/task.mjs list
  node ~/VibeCoding/tools/vqa/task.mjs info page-builder-polish

WORKSPACE:
  Tasks live under .agent/vqa-tasks/<slug>/ relative to your CWD.
  Reference images are copied (cp), not moved — your original stays put.

EXIT CODES:
  0 = OK    1 = task error    3 = setup error
`);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function ensureWorkspace() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

function taskDir(slug) {
  return path.join(WORKSPACE_ROOT, slug);
}

function taskJsonPath(slug) {
  return path.join(taskDir(slug), "task.json");
}

function loadTask(slug) {
  const p = taskJsonPath(slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveTask(slug, task) {
  fs.writeFileSync(taskJsonPath(slug), JSON.stringify(task, null, 2));
}

function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

function cmdCreate(slug, opts = {}) {
  if (!slug) {
    console.error("SETUP_ERROR: slug is required");
    console.error("   Usage: task.mjs create <slug>");
    process.exit(3);
  }
  if (!isValidSlug(slug)) {
    console.error(`SETUP_ERROR: invalid slug "${slug}"`);
    console.error("   Use lowercase letters, digits, and hyphens only");
    process.exit(3);
  }

  ensureWorkspace();
  const dir = taskDir(slug);

  if (fs.existsSync(dir)) {
    console.error(`Task already exists: ${slug}`);
    console.error(`   Path: ${dir}`);
    process.exit(1);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.mkdirSync(path.join(dir, "iterations"), { recursive: true });

  const task = {
    name: opts.name || slug,
    slug,
    createdAt: new Date().toISOString(),
    status: "active",
    iterationCount: 0,
    references: [],
    iterations: [],
  };

  saveTask(slug, task);

  console.log(`✓ Created task: ${slug}`);
  console.log(`  Path: ${dir}`);
  console.log(`  Next: task.mjs add-ref ${slug} <image.png>`);
}

function cmdAddRef(slug, imagePath) {
  if (!slug || !imagePath) {
    console.error("SETUP_ERROR: slug and image-path required");
    console.error("   Usage: task.mjs add-ref <slug> <image-path>");
    process.exit(3);
  }

  const task = loadTask(slug);
  if (!task) {
    console.error(`Task not found: ${slug}`);
    console.error("   Run: task.mjs create " + slug);
    process.exit(1);
  }

  const sourcePath = path.resolve(imagePath);
  if (!fs.existsSync(sourcePath)) {
    console.error(`SETUP_ERROR: source image not found: ${sourcePath}`);
    process.exit(3);
  }

  // Determine reference number — based on existing references count + 1
  const refNum = task.references.length + 1;
  const ext = path.extname(sourcePath).toLowerCase() || ".png";
  const destName = `iter-${refNum}-reference${ext}`;
  const destPath = path.join(taskDir(slug), "references", destName);

  // COPY (not move) — preserve user's original
  fs.copyFileSync(sourcePath, destPath);

  task.references.push({
    name: destName,
    addedAt: new Date().toISOString(),
    sourcePath,
  });

  saveTask(slug, task);

  console.log(`✓ Reference added to ${slug}: ${destName}`);
  console.log(`  Source: ${sourcePath} (untouched)`);
  console.log(`  Saved:  ${destPath}`);
  console.log(`  Total references: ${task.references.length}`);
}

function cmdList() {
  if (!fs.existsSync(WORKSPACE_ROOT)) {
    console.log("No tasks yet. Create one with: task.mjs create <slug>");
    return;
  }

  const slugs = fs.readdirSync(WORKSPACE_ROOT).filter((d) => {
    return fs.statSync(path.join(WORKSPACE_ROOT, d)).isDirectory();
  });

  if (slugs.length === 0) {
    console.log("No tasks yet.");
    return;
  }

  console.log(`VQA Tasks (${slugs.length}):\n`);
  for (const slug of slugs.sort()) {
    const task = loadTask(slug);
    if (!task) {
      console.log(`  ${slug}  ⚠️ no task.json`);
      continue;
    }
    const refs = task.references?.length || 0;
    const iters = task.iterationCount || 0;
    const status = task.status || "?";
    console.log(`  ${slug.padEnd(30)} status=${status}  refs=${refs}  iters=${iters}`);
  }
}

function cmdInfo(slug) {
  if (!slug) {
    console.error("SETUP_ERROR: slug is required");
    process.exit(3);
  }
  const task = loadTask(slug);
  if (!task) {
    console.error(`Task not found: ${slug}`);
    process.exit(1);
  }

  console.log(`Task: ${task.name}`);
  console.log(`  Slug:        ${task.slug}`);
  console.log(`  Status:      ${task.status}`);
  console.log(`  Created:     ${task.createdAt}`);
  console.log(`  Path:        ${taskDir(slug)}`);
  console.log(`  References:  ${task.references?.length || 0}`);
  if (task.references?.length > 0) {
    for (const ref of task.references) {
      console.log(`    - ${ref.name}`);
    }
  }
  console.log(`  Iterations:  ${task.iterationCount || 0}`);
  if (task.iterations?.length > 0) {
    for (const iter of task.iterations) {
      const score = iter.similarity != null ? `${iter.similarity}%` : "—";
      console.log(`    - iter ${String(iter.number).padStart(3, "0")}  similarity=${score}  ${iter.timestamp}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────
const [, , command, ...rest] = process.argv;

if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp();
  process.exit(command ? 0 : 3);
}

switch (command) {
  case "create": {
    // Parse optional --name "..."
    const opts = {};
    const args = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--name") {
        opts.name = rest[++i];
      } else {
        args.push(rest[i]);
      }
    }
    cmdCreate(args[0], opts);
    break;
  }
  case "add-ref":
    cmdAddRef(rest[0], rest[1]);
    break;
  case "list":
    cmdList();
    break;
  case "info":
    cmdInfo(rest[0]);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(3);
}
