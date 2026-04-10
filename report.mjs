#!/usr/bin/env node
/**
 * report.mjs — VQA Markdown Report Generator + Astro Publisher
 *
 * Reads a task workspace (.agent/vqa-tasks/<slug>/) and generates an
 * Astro-compatible markdown report showing iteration progression with
 * embedded screenshots and Vision AI feedback.
 *
 * Usage:
 *   node report.mjs --task <slug>
 *     → generates .agent/vqa-tasks/<slug>/report.md (staging copy)
 *
 *   node report.mjs --task <slug> --publish <astro-root>
 *     → ALSO copies markdown to <astro-root>/src/content/vqa-reports/
 *     → and copies images to <astro-root>/public/vqa/<slug>/
 *
 * Exit codes:
 *   0 = OK
 *   1 = task or iterations missing
 *   3 = SETUP_ERROR (bad args)
 */

import { parseArgs } from "node:util";
import * as fs from "fs";
import * as path from "path";

const WORKSPACE_ROOT = path.resolve(".agent/vqa-tasks");

// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    task:    { type: "string" },
    publish: { type: "string" },
    project: { type: "string", default: "mitree" },
    help:    { type: "boolean", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`
report.mjs — VQA Markdown Report Generator

USAGE:
  node report.mjs --task <slug> [--publish <astro-root>] [--project <name>]

OPTIONS:
  --task <slug>          Task workspace to generate report from (required)
  --publish <astro-root> Also copy markdown + images to Astro project
  --project <name>       Project tag for the report (default: mitree)
  --help                 Show this help

OUTPUT:
  Always: .agent/vqa-tasks/<slug>/report.md (staging)
  With --publish:
    <astro-root>/src/content/vqa-reports/<slug>.md
    <astro-root>/public/vqa/<slug>/iter-N-{role}.png

EXAMPLES:
  # Generate staging report only
  node ~/VibeCoding/tools/vqa/report.mjs --task page-builder-polish

  # Generate + publish to Mitree marketing site
  node ~/VibeCoding/tools/vqa/report.mjs \\
    --task page-builder-polish \\
    --publish ~/VibeCoding/mitree/marketing
`);
  process.exit(0);
}

if (!args.task) {
  console.error("SETUP_ERROR: --task is required");
  console.error("   Run with --help for usage");
  process.exit(3);
}

const slug = args.task;
const taskDir = path.join(WORKSPACE_ROOT, slug);
const taskJsonPath = path.join(taskDir, "task.json");

if (!fs.existsSync(taskJsonPath)) {
  console.error(`Task not found: ${slug}`);
  console.error(`   Expected: ${taskJsonPath}`);
  console.error("   Run: node ~/VibeCoding/tools/vqa/task.mjs create " + slug);
  process.exit(1);
}

const task = JSON.parse(fs.readFileSync(taskJsonPath, "utf8"));

// ─────────────────────────────────────────────────────────────
// Collect data
// ─────────────────────────────────────────────────────────────
const iterations = [];
const iterationsDir = path.join(taskDir, "iterations");

if (fs.existsSync(iterationsDir)) {
  const dirs = fs
    .readdirSync(iterationsDir)
    .filter((d) => /^\d+$/.test(d))
    .sort();

  for (const dir of dirs) {
    const num = parseInt(dir, 10);
    const iterPath = path.join(iterationsDir, dir);
    const compPath = path.join(iterPath, "comparison.json");

    let data = { iteration: { number: num }, comparison: null };
    if (fs.existsSync(compPath)) {
      data = JSON.parse(fs.readFileSync(compPath, "utf8"));
    }

    // List PNG files in iteration dir
    const screenshots = fs
      .readdirSync(iterPath)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f));

    iterations.push({
      number: num,
      dir: iterPath,
      screenshots,
      data: data.iteration,
      comparison: data.comparison,
    });
  }
}

if (iterations.length === 0) {
  console.error(`Task "${slug}" has no iterations yet`);
  console.error("   Run VQA with --task to record an iteration:");
  console.error(`     node run-vqa.mjs --config ./vqa.config.mjs --task ${slug} --reference iter-1-reference --url ... --waitFor ... --auth`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function pickRoleName(filename, role, iterNum) {
  // Generate consistent name for published images: iter-N-{role}.png
  const ext = path.extname(filename) || ".png";
  return `iter-${iterNum}-${role}${ext}`;
}

function copyImageWithRole(sourcePath, destDir, role, iterNum) {
  const filename = pickRoleName(path.basename(sourcePath), role, iterNum);
  const destPath = path.join(destDir, filename);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  return filename;
}

// ─────────────────────────────────────────────────────────────
// Generate markdown
// ─────────────────────────────────────────────────────────────

const scoresWithValues = iterations
  .filter((i) => i.data.similarity != null)
  .map((i) => i.data.similarity);

const initialScore = scoresWithValues[0] ?? 0;
const finalScore = scoresWithValues[scoresWithValues.length - 1] ?? 0;
const status = finalScore >= 90 ? "completed" : "active";
const reportDate = new Date().toISOString().split("T")[0];

// First reference (if any)
const firstRef = task.references?.[0]?.name || null;
const referencePathForFrontmatter = firstRef ? `/vqa/${slug}/iter-1-reference.png` : "";

// Build frontmatter
const frontmatter = [
  "---",
  `title: "${task.name.replace(/"/g, '\\"')}"`,
  `slug: ${slug}`,
  `date: ${reportDate}`,
  `project: ${args.project}`,
  `status: ${status}`,
  `iterations: ${iterations.length}`,
  `finalScore: ${finalScore}`,
  `initialScore: ${initialScore}`,
  `reference: "${referencePathForFrontmatter}"`,
  "tags: [vqa]",
  "---",
  "",
].join("\n");

// Build body
let body = `## Background\n\n`;
body += `Task **${task.name}** was created on ${task.createdAt.split("T")[0]} `;
body += `to track ${iterations.length} iteration${iterations.length === 1 ? "" : "s"} of UI work, `;
if (task.references?.length > 0) {
  body += `comparing each agent attempt against ${task.references.length} reference image${task.references.length === 1 ? "" : "s"}.\n\n`;
} else {
  body += `capturing visual snapshots at each iteration.\n\n`;
}

if (scoresWithValues.length > 0) {
  const delta = finalScore - initialScore;
  const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
  body += `**Score progression:** ${initialScore}% → ${finalScore}% (${deltaStr} points)\n\n`;
}

if (firstRef) {
  body += `## Reference\n\n`;
  body += `![Reference design](/vqa/${slug}/iter-1-reference.png)\n\n`;
}

body += `## Iterations\n\n`;

for (const iter of iterations) {
  const score = iter.data.similarity;
  const scoreText = score != null ? `Score: **${score}%**` : "No comparison";
  body += `### Iteration ${iter.number} — ${scoreText}\n\n`;

  // Reference the published image path (will be /vqa/<slug>/iter-N-coded.png after publish)
  if (iter.screenshots.length > 0) {
    body += `![Iteration ${iter.number}](/vqa/${slug}/iter-${iter.number}-coded.png)\n\n`;
  }

  if (iter.comparison?.differences?.length > 0) {
    body += `**Vision AI feedback:**\n\n`;
    iter.comparison.differences.forEach((d, i) => {
      body += `${i + 1}. ${d}\n`;
    });
    body += "\n";
  } else if (iter.comparison?.rawFeedback) {
    body += `**Vision AI:** ${iter.comparison.rawFeedback.split("\n").slice(0, 3).join(" ").trim()}\n\n`;
  }

  body += `_${iter.data.timestamp || "no timestamp"}_\n\n`;
}

// Final summary
if (scoresWithValues.length > 1) {
  body += `## Summary\n\n`;
  body += `Started at **${initialScore}%** similarity, finished at **${finalScore}%** `;
  const delta = finalScore - initialScore;
  if (delta > 0) {
    body += `(improvement of **+${delta} points** across ${iterations.length} iterations).\n`;
  } else if (delta === 0) {
    body += `(no change across ${iterations.length} iterations).\n`;
  } else {
    body += `(regression of **${delta} points** — review needed).\n`;
  }
}

const markdown = frontmatter + body;

// ─────────────────────────────────────────────────────────────
// Save staging copy (always)
// ─────────────────────────────────────────────────────────────
const stagingPath = path.join(taskDir, "report.md");
fs.writeFileSync(stagingPath, markdown);
console.log(`✓ Generated staging report: ${path.relative(process.cwd(), stagingPath)}`);

// ─────────────────────────────────────────────────────────────
// Optionally publish to Astro
// ─────────────────────────────────────────────────────────────
if (args.publish) {
  const astroRoot = path.resolve(args.publish);

  // Sanity check: astro.config.mjs is the definitive marker of an Astro project
  const astroConfig = path.join(astroRoot, "astro.config.mjs");
  if (!fs.existsSync(astroConfig)) {
    console.error(`\nSETUP_ERROR: --publish path is not an Astro project`);
    console.error(`   Expected file: ${astroConfig}`);
    process.exit(3);
  }

  // Destination dirs (created if missing — this is the publisher's job)
  const reportDestDir = path.join(astroRoot, "src", "content", "vqa-reports");
  const imagesDestDir = path.join(astroRoot, "public", "vqa", slug);
  fs.mkdirSync(reportDestDir, { recursive: true });
  fs.mkdirSync(imagesDestDir, { recursive: true });

  let imageCount = 0;

  // Copy reference images
  if (task.references?.length > 0) {
    for (let i = 0; i < task.references.length; i++) {
      const ref = task.references[i];
      const sourcePath = path.join(taskDir, "references", ref.name);
      if (!fs.existsSync(sourcePath)) continue;
      copyImageWithRole(sourcePath, imagesDestDir, "reference", i + 1);
      imageCount++;
    }
  }

  // Copy iteration screenshots (use the first screenshot of each iteration as the "coded" view)
  for (const iter of iterations) {
    if (iter.screenshots.length === 0) continue;
    const sourcePath = path.join(iter.dir, iter.screenshots[0]);
    if (!fs.existsSync(sourcePath)) continue;
    copyImageWithRole(sourcePath, imagesDestDir, "coded", iter.number);
    imageCount++;
  }

  // Copy markdown
  const mdDestPath = path.join(reportDestDir, `${slug}.md`);
  fs.writeFileSync(mdDestPath, markdown);

  console.log(`✓ Published to Astro:`);
  console.log(`     Markdown: ${path.relative(process.cwd(), mdDestPath)}`);
  console.log(`     Images:   ${path.relative(process.cwd(), imagesDestDir)}/ (${imageCount} files)`);
}

console.log(`\n  Task: ${task.name} (${slug})`);
console.log(`  Iterations: ${iterations.length}`);
if (scoresWithValues.length > 0) {
  console.log(`  Scores: ${scoresWithValues.map((s) => s + "%").join(" → ")}`);
}
