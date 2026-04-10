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
