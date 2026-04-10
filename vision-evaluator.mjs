#!/usr/bin/env node
/**
 * Vision Evaluator — Claude Vision AI screenshot grading
 *
 * Extracted from YogiLife run-vqa.mjs.
 * Sends screenshots to Claude Sonnet for A-F visual quality grading.
 *
 * Usage:
 *   import { evaluateWithVision } from './vision-evaluator.mjs';
 *   const result = await evaluateWithVision(screenshotPaths, { outDir });
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

/**
 * Evaluate screenshots using Claude Vision AI.
 *
 * @param {string[]} screenshotPaths — array of screenshot filenames (not full paths)
 * @param {Object} config
 * @param {string} config.outDir — directory containing screenshots
 * @param {string} [config.projectDescription] — describes the project for the evaluator
 * @returns {{ score: string, pass: boolean, feedback: string } | null}
 */
export async function evaluateWithVision(screenshotPaths, config = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("\n  No ANTHROPIC_API_KEY — skipping Vision evaluation");
    console.log("     Set ANTHROPIC_API_KEY env to enable Vision AI grading");
    return null;
  }

  // Filter out BLOCKED/VISION-FAIL/BLANK screenshots — those already failed
  const validScreenshots = screenshotPaths.filter(
    (ss) =>
      ss &&
      !ss.includes("BLOCKED") &&
      !ss.includes("BLANK") &&
      !ss.includes("VISION-FAIL")
  );

  if (validScreenshots.length === 0) {
    console.log("\n  No valid screenshots for Vision evaluation");
    return null;
  }

  const outDir = config.outDir || ".";
  const projectDesc = config.projectDescription || "a SaaS web application";

  console.log("\n  Sending to Vision AI...");

  try {
    const client = new Anthropic({ apiKey });

    const imageContents = [];
    for (const ss of validScreenshots) {
      const imgPath = path.join(outDir, ss);
      if (!fs.existsSync(imgPath)) continue;
      const data = fs.readFileSync(imgPath).toString("base64");
      imageContents.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      });
      imageContents.push({ type: "text", text: `Screenshot: ${ss}` });
    }

    if (imageContents.length === 0) return null;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: [
            ...imageContents,
            {
              type: "text",
              text: `You are a strict UI/UX quality auditor for ${projectDesc}.

Evaluate these screenshots. Check:
1. Layout: overlap, misalignment, cut-off content, broken grid
2. Responsive: content too wide/narrow for viewport
3. Dark mode: invisible text, wrong contrast, missing backgrounds
4. Content: blank areas, loading spinners, error messages still visible
5. Polish: spacing consistency, professional appearance

SCORE (first line, exactly this format):
SCORE: A|B|C|D|F

A = Production-ready, no issues
B = Minor polish needed, shippable
C = Usable but visible issues — list what to fix
D = Broken layout or major issues — list specifics
F = Unusable — critical failures

If score C or below, list specific CSS fixes (selector + property).
Be concise, max 150 words.`,
            },
          ],
        },
      ],
    });

    const feedback = response.content[0]?.text || null;
    if (!feedback) return null;

    // Parse score
    const scoreMatch = feedback.match(/SCORE:\s*([A-F])/i);
    const score = scoreMatch ? scoreMatch[1].toUpperCase() : "?";
    const pass = ["A", "B"].includes(score);

    return { score, pass, feedback };
  } catch (err) {
    console.warn(`  Vision API error: ${err.message}`);
    return null;
  }
}

/**
 * Compare two images using Claude Vision AI.
 *
 * Image A is the reference (target). Image B is the agent's actual output.
 * Returns a similarity score 0-100 plus list of differences.
 *
 * @param {string} referencePath — absolute path to reference image (PNG/JPG)
 * @param {string} actualPath — absolute path to actual image (PNG/JPG)
 * @param {Object} [options]
 * @param {string} [options.criteria] — focus area, e.g. "button styling, ignore copy"
 * @param {number} [options.threshold=80] — pass threshold (0-100)
 * @returns {Promise<{ similarity: number, pass: boolean, differences: string[], rawFeedback: string } | null>}
 */
export async function compareImages(referencePath, actualPath, options = {}) {
  const { criteria = "", threshold = 80 } = options;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("\n  No ANTHROPIC_API_KEY — cannot compare images");
    console.log("     Set ANTHROPIC_API_KEY env to enable A/B comparison");
    return null;
  }

  if (!fs.existsSync(referencePath)) {
    console.error(`  Reference image not found: ${referencePath}`);
    return null;
  }
  if (!fs.existsSync(actualPath)) {
    console.error(`  Actual image not found: ${actualPath}`);
    return null;
  }

  const referenceData = fs.readFileSync(referencePath).toString("base64");
  const actualData = fs.readFileSync(actualPath).toString("base64");

  const refMime = referencePath.toLowerCase().endsWith(".jpg") || referencePath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";
  const actMime = actualPath.toLowerCase().endsWith(".jpg") || actualPath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";

  console.log("\n  Comparing images via Claude Vision...");
  console.log(`     Reference: ${path.basename(referencePath)}`);
  console.log(`     Actual:    ${path.basename(actualPath)}`);
  if (criteria) console.log(`     Criteria:  ${criteria}`);

  try {
    const client = new Anthropic({ apiKey });

    const focusInstruction = criteria
      ? `\n\nFOCUS AREA: ${criteria}\nPrioritize differences in this area when scoring.`
      : "";

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: refMime, data: referenceData },
            },
            { type: "text", text: "Image A — REFERENCE (target design)" },
            {
              type: "image",
              source: { type: "base64", media_type: actMime, data: actualData },
            },
            { type: "text", text: "Image B — ACTUAL (agent's implementation)" },
            {
              type: "text",
              text: `You are a senior UI design reviewer. Compare Image A (reference) with Image B (actual implementation).

Evaluate VISUAL SIMILARITY focusing on:
- Layout structure (positioning, alignment, spacing)
- Color palette (background, text, accent colors)
- Typography (font weight, size, hierarchy)
- Component styling (border-radius, shadows, borders)
- Visual polish (consistency, professionalism)

IGNORE differences in:
- Actual text/copy content (placeholder text is fine)
- Image content within frames (focus on the frame itself)
- Browser chrome or scrollbars
- Aspect ratio differences (compare visual style, not exact pixel layout)
${focusInstruction}

OUTPUT FORMAT (strict — first line must match):
SIMILARITY: NN%

Then a numbered list of UP TO 5 most important differences, each with a CSS fix suggestion:
1. <difference> → <CSS fix>
2. ...

Scoring guide:
- 95-100% = visually identical, ship it
- 85-94%  = minor polish needed, mostly there
- 70-84%  = recognizable but visible gaps, list specific fixes
- 50-69%  = right direction, multiple issues
- < 50%   = significant rework needed

Be concise. Total response under 300 words.`,
            },
          ],
        },
      ],
    });

    const rawFeedback = response.content[0]?.text || "";
    if (!rawFeedback) return null;

    // Parse similarity score
    const simMatch = rawFeedback.match(/SIMILARITY:\s*(\d+)\s*%/i);
    const similarity = simMatch ? parseInt(simMatch[1], 10) : 0;

    // Parse differences (numbered list lines)
    const differences = rawFeedback
      .split("\n")
      .filter((line) => /^\s*\d+[\.\)]\s+/.test(line))
      .map((line) => line.replace(/^\s*\d+[\.\)]\s+/, "").trim())
      .filter((line) => line.length > 0);

    const pass = similarity >= threshold;

    return { similarity, pass, differences, rawFeedback };
  } catch (err) {
    console.warn(`  Vision API error: ${err.message}`);
    return null;
  }
}
