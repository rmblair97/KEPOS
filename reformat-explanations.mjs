// Kepos - one-off explanation reformatter (draft, check, then apply).
//
// Rewrites each card's `explanation` to the house style. Changes ONLY the `explanation`
// column, in place. Title, hook, example, conversation angle and questions are sent as
// context but never written.
//
// Every rewrite is checked (automatic rules plus a second Claude call that looks for
// invented or risky claims and lost content). Problems are sent back for up to two
// revisions. Cards that still have problems are marked "flagged" for you to review.
//
// Modes (run through the GitHub Actions workflow, or locally with Node 22):
//   preview   rewrites + checks 3 cards, prints before/after. Writes NOTHING to the database.
//   draft     rewrites + checks ALL cards, saves reformat-draft.json and reformat-review.md.
//             Writes NOTHING to the database.
//   apply     writes the drafted text into the database. Clean cards are written; flagged
//             cards only if listed in APPROVE_FLAGGED ("all", or comma-separated title words).
//   restore   puts back the explanations from a backup file.
//
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (preview/draft only)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MODEL = process.env.MODEL || "claude-sonnet-5"; // same model as the generate-cards function
const TABLE = "concepts";
const DRAFT_FILE = "reformat-draft.json";
const REVIEW_FILE = "reformat-review.md";
const PREVIEW_TITLES = ["monty hall", "ship of theseus"];
const MAX_REVISIONS = 2;
const WORKERS = 3;
const MAX_SENTENCES = 4;

const [, , command = "preview", ...rest] = process.argv;
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const flag = (name) => rest.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const need = (k) => {
  if (!process.env[k]) {
    console.error(`Missing ${k}. Check the GitHub secret of that exact name.`);
    process.exit(1);
  }
  return process.env[k];
};

// Accept the project URL even if it was pasted with a trailing slash or path.
const supabaseUrl = new URL(need("SUPABASE_URL").trim()).origin;
const supabase = createClient(supabaseUrl, need("SUPABASE_SERVICE_ROLE_KEY").trim());

const STYLE = `HOUSE STYLE FOR AN EXPLANATION

The card shows its hook as the lead line, with your explanation straight underneath. So do NOT restate the hook; start with what the idea is.
Write short paragraphs of 2-4 sentences each, separated by a blank line (two newline characters). No paragraph may have more than 4 sentences: if you need more, start a new paragraph. No bullets, headings or markdown.
  1. What it is: plainly, no jargon.
  2. Why it matters: the mechanism or consequence.
  3. The twist (optional): a surprising origin, a counter-intuitive implication, or the part most people get wrong.

One-insight rule: the explanation must deliver at least ONE thing the reader could not have guessed (a mechanism, a reframe, a surprising origin, a sharp consequence). If the current text only restates the obvious, replace the filler with a true insight. Never invent facts: use only what you are confident is accurate and established, and keep everything the current explanation correctly says that matters.

Length: let the concept decide. Default is tight: 2-3 short paragraphs. Go longer only when the idea cannot be understood without it: a step-by-step walk-through (Monty Hall: show why switching wins 2/3 of the time), a worked example or concrete numbers that make a counter-intuitive result believable, or two sides laid out in full (Ship of Theseus: the replaced ship AND the rebuilt one). Test: could you cut a sentence without losing understanding? If yes, cut it. Extra length buys comprehension, not richness.

Tone: confident and precise. Short sentences. A memorable line beats a complete one. The reader should think "huh, I didn't know that". Avoid hedging, throat-clearing ("It is interesting to note that...") and dictionary-style definitions.

Complete the idea: if the concept has a famous second half, counter-case or twist that people need to understand it, include it. Examples: Ship of Theseus needs BOTH the ship with replaced planks AND Hobbes' twist (the discarded planks reassembled into a second ship: which one is the original?); Monty Hall needs the walk-through of why switching wins 2/3 of the time. Use your knowledge of the concept, not just the current text, but only for things you are certain are established.

Opening: do not begin with a definition such as "It's a puzzle about..." or "X is the idea that...". Open with the concrete situation, claim or consequence, in plain words.

Myths: do not repeat popular half-truths. For example "every cell in your body is replaced every seven years" is false for many cells. If the current text hedges a claim, keep the hedge or drop the claim.

Accuracy: do not state who coined a phrase, who argued what, where an idea came from, dates, numbers, or sweeping words like "usually" and "always" unless the current explanation already says so or you are certain. If unsure, leave it out and use a different true insight, such as the mechanism or a consequence.

Keep the card's meaning. Do not contradict the card's example, conversation angle or questions, and do not copy them into the explanation.`;

const rewriteTool = {
  name: "save_explanation",
  description: "Save the rewritten explanation.",
  input_schema: {
    type: "object",
    properties: { explanation: { type: "string", description: "House-style explanation, paragraphs separated by a blank line" } },
    required: ["explanation"],
  },
};

const checkTool = {
  name: "report_check",
  description: "Report the result of checking a rewritten explanation.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["ok", "flag"] },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["unsupported_claim", "false_or_myth", "lost_content", "filler", "no_insight"] },
            quote: { type: "string", description: "The exact words concerned (from the rewrite, or from the original for lost_content)" },
            why: { type: "string", description: "One short sentence" },
          },
          required: ["type", "quote", "why"],
        },
      },
    },
    required: ["verdict", "issues"],
  },
};

async function callTool(tool, prompt, maxTokens) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch {
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const input = data.content?.find((b) => b.type === "tool_use")?.input;
    if (input) return input;
  }
  throw new Error("no usable response from Claude");
}

const cardContext = (card) =>
  JSON.stringify(
    {
      title: card.title,
      category: card.category,
      hook: card.hook,
      example: card.example,
      conversation_angle: card.conversation_angle,
    },
    null,
    2
  );

const normalize = (t) =>
  typeof t === "string" ? t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";

// Hard problems: the text is unusable. Retried straight away.
function hardProblem(text) {
  if (!text) return "empty";
  if (!/\n\n/.test(text)) return "no paragraph breaks";
  if (/^\s*([-*\u2022]|#{1,6}\s|\d+\.)\s/m.test(text)) return "contains bullets or headings";
  return null;
}

async function rewrite(card, feedback) {
  const fb = feedback
    ? `\n\nYOUR PREVIOUS ATTEMPT (rejected):\n${feedback.prev}\n\nPROBLEMS TO FIX (keep what was good, change only what is needed):\n${feedback.issues.map((i) => `- ${i}`).join("\n")}`
    : "";
  const prompt = `${STYLE}

Rewrite this card's explanation to the house style.

Card context (do not rewrite these, they stay as they are):
${cardContext(card)}

CURRENT EXPLANATION:
${card.explanation}${fb}`;

  for (let i = 0; i < 3; i++) {
    const out = await callTool(rewriteTool, prompt, 2000);
    const text = normalize(out.explanation);
    const problem = hardProblem(text);
    if (!problem) return text;
    console.warn(`  retry (${problem})`);
  }
  throw new Error("could not get a valid rewrite");
}

function sentenceCount(p) {
  return p.split(/(?<=[.!?]["')\]]?)\s+(?=["'(A-Z])/).filter(Boolean).length;
}

// Automatic rules from the house style.
function localIssues(card, text) {
  const issues = [];
  text.split(/\n\n/).forEach((p, i) => {
    const n = sentenceCount(p);
    if (n > MAX_SENTENCES) issues.push(`paragraph ${i + 1} has ${n} sentences (maximum ${MAX_SENTENCES}); split it or cut`);
  });
  if (text.length > 2400) issues.push(`too long (${text.length} characters); cut anything not needed to understand the idea`);
  if (card.explanation && text.length > card.explanation.length * 3) issues.push("more than 3x longer than the original; cut it back");
  if (/^(it'?s|it is|this is|there'?s)\s+(a|an|the)\s+(puzzle|paradox|idea|concept|effect|bias|theory|principle|phenomenon|thought experiment)/i.test(text)) {
    issues.push("opens with a definition; open with the concrete situation or claim instead");
  }
  return issues;
}

// A second Claude call that compares the rewrite against the original.
async function checkRewrite(card, text) {
  const prompt = `You are a careful fact-checker and editor for a concept-card app. Compare the ORIGINAL explanation with the REWRITE of it.

Card context:
${cardContext(card)}

ORIGINAL:
${card.explanation}

REWRITE:
${text}

Report an issue ONLY for these:
- unsupported_claim: a specific attribution (who coined, argued or said something), date, number, statistic, or a sweeping word such as "usually", "always", "most" in the REWRITE that is NOT in the original, the example or the conversation angle, AND that you are not certain is true and well established.
- false_or_myth: anything in the rewrite you believe is false, contested, overstated or a popular myth, even if the original said it.
- lost_content: something important in the ORIGINAL that the rewrite dropped, changing what the card teaches.
- filler: a paragraph that adds nothing the reader could not have guessed.
- no_insight: the rewrite as a whole only restates the obvious and delivers nothing a reader could not have guessed.

Do NOT flag: standard, well-established parts of the concept that you are certain about (for example the rebuilt ship in the Ship of Theseus), or matters of style. Be strict about accuracy but not nitpicky. If there are no issues, verdict "ok" with an empty list.`;
  const out = await callTool(checkTool, prompt, 1500);
  if (out.verdict !== "flag" || !Array.isArray(out.issues)) return [];
  return out.issues.map((i) => `${i.type}: "${i.quote}" - ${i.why}`);
}

// Rewrite, check, send problems back for revision, up to MAX_REVISIONS times.
async function processCard(card) {
  let feedback = null;
  let text = "";
  let issues = [];
  let attempts = 0;
  for (let round = 0; round <= MAX_REVISIONS; round++) {
    attempts++;
    text = await rewrite(card, feedback);
    issues = [...localIssues(card, text), ...(await checkRewrite(card, text))];
    if (!issues.length) break;
    feedback = { prev: text, issues };
  }
  return { id: card.id, title: card.title, hook: card.hook, before: card.explanation, after: text, status: issues.length ? "flagged" : "ok", issues, attempts };
}

async function loadCards() {
  const { data, error } = await supabase.from(TABLE).select("*").order("title");
  if (error) throw error;
  return data;
}

const save = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function saveBackup(prefix, cards) {
  const file = `${prefix}-${stamp()}.json`;
  save(file, cards.map(({ id, title, explanation }) => ({ id, title, explanation })));
  return file;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx], idx);
      }
    })
  );
}

function printResult(r) {
  console.log(`==================== ${r.title} ====================`);
  console.log(`HOOK (unchanged): ${r.hook}\n`);
  console.log(`--- BEFORE (${r.before.length} chars) ---\n${r.before}\n`);
  console.log(`--- AFTER (${r.after.length} chars, ${r.status.toUpperCase()}, ${r.attempts} attempt${r.attempts > 1 ? "s" : ""}) ---\n${r.after}\n`);
  if (r.issues.length) console.log(`--- STILL FLAGGED ---\n${r.issues.map((i) => `* ${i}`).join("\n")}\n`);
}

const alreadyParagraphs = (c) => /\n\s*\n/.test((c.explanation || "").trim());

async function preview() {
  const cards = await loadCards();
  const picks = [];
  for (const t of PREVIEW_TITLES) {
    const c = cards.find((x) => !picks.includes(x) && x.title?.toLowerCase().includes(t));
    if (c) picks.push(c);
    else console.log(`(No card with "${t}" in its title found, skipping)`);
  }
  const also = option("also")?.trim().toLowerCase();
  const extra = also
    ? cards.find((x) => !picks.includes(x) && x.title?.toLowerCase().includes(also))
    : cards.find((x) => !picks.includes(x) && x.explanation);
  if (extra && picks.length < 3) picks.push(extra);

  for (const c of picks) printResult(await processCard(c));
  console.log("Nothing was written to the database.");
}

async function draft() {
  const cards = await loadCards();
  const backup = saveBackup("draft-backup", cards);
  console.log(`Backup of every current explanation: ${backup}`);

  const todo = cards.filter((c) => c.explanation?.trim() && (flag("force") || !alreadyParagraphs(c)));
  console.log(`${cards.length} cards, ${todo.length} to draft (the rest are empty or already in paragraphs).\n`);

  const results = new Array(todo.length);
  let done = 0;
  await pool(todo, WORKERS, async (card, idx) => {
    try {
      results[idx] = await processCard(card);
    } catch (e) {
      results[idx] = { id: card.id, title: card.title, hook: card.hook, before: card.explanation, after: "", status: "error", issues: [String(e.message || e)], attempts: 0 };
    }
    done++;
    const r = results[idx];
    console.log(`[${done}/${todo.length}] ${r.title}: ${r.status}${r.issues.length ? ` (${r.issues.length} issue${r.issues.length > 1 ? "s" : ""})` : ""}`);
  });

  save(DRAFT_FILE, results);
  fs.writeFileSync(REVIEW_FILE, reviewMarkdown(results));

  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nDRAFT DONE: ${count("ok")} clean, ${count("flagged")} flagged, ${count("error")} failed.`);
  console.log("Nothing was written to the database. Read the review on this run's Summary page.");
}

function reviewMarkdown(results) {
  const order = { flagged: 0, error: 1, ok: 2 };
  const sorted = [...results].sort((a, b) => order[a.status] - order[b.status] || a.title.localeCompare(b.title));
  const count = (s) => results.filter((r) => r.status === s).length;
  let out = `# Reformat draft review\n\n${count("ok")} clean, ${count("flagged")} flagged, ${count("error")} failed. Flagged cards come first.\n\n`;
  for (const r of sorted) {
    out += `---\n\n## ${r.title} (${r.status.toUpperCase()})\n\n`;
    if (r.issues.length) out += `**Issues**\n\n${r.issues.map((i) => `- ${i}`).join("\n")}\n\n`;
    out += `**Hook (unchanged):** ${r.hook}\n\n**After**\n\n${r.after || "(none)"}\n\n`;
    if (out.length < 700000) out += `<details><summary>Before</summary>\n\n${r.before}\n\n</details>\n\n`;
  }
  return out;
}

async function apply() {
  if (!fs.existsSync(DRAFT_FILE)) {
    console.error(`${DRAFT_FILE} not found. Run "draft" first and pass its run number as source_run_id.`);
    process.exit(1);
  }
  const drafts = JSON.parse(fs.readFileSync(DRAFT_FILE, "utf8"));
  const approve = (process.env.APPROVE_FLAGGED || "none").trim().toLowerCase();
  const words = approve === "none" || approve === "all" ? [] : approve.split(",").map((s) => s.trim()).filter(Boolean);

  const cards = await loadCards();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const backup = saveBackup("explanation-backup", cards);
  console.log(`Backup before changes: ${backup}\n`);

  const written = [], held = [], changed = [], failed = [];
  for (const d of drafts) {
    if (d.status === "error" || !d.after) { held.push(`${d.title} (draft failed)`); continue; }
    const flagged = d.status === "flagged";
    const approved = !flagged || approve === "all" || words.some((w) => d.title.toLowerCase().includes(w));
    if (!approved) { held.push(`${d.title} (flagged)`); continue; }
    const cur = byId.get(d.id);
    if (!cur || (cur.explanation || "") !== d.before) { changed.push(d.title); continue; }
    const { error } = await supabase.from(TABLE).update({ explanation: d.after }).eq("id", d.id);
    if (error) { failed.push(`${d.title}: ${error.message}`); continue; }
    written.push(d.title);
    console.log(`updated ${d.title}`);
    await sleep(150);
  }

  console.log(`\nDONE. Updated ${written.length}.`);
  if (held.length) console.log(`Held back (${held.length}): ${held.join("; ")}`);
  if (changed.length) console.log(`Skipped because the card changed since the draft (${changed.length}): ${changed.join("; ")}`);
  if (failed.length) console.log(`Failed (${failed.length}): ${failed.join("; ")}`);
}

async function restore() {
  const file = rest[0];
  if (!file || !fs.existsSync(file)) {
    console.error("Usage: node reformat-explanations.mjs restore <backup-file.json>");
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const r of rows) {
    const { error } = await supabase.from(TABLE).update({ explanation: r.explanation }).eq("id", r.id);
    console.log(error ? `FAILED ${r.title}: ${error.message}` : `restored ${r.title}`);
  }
}

const run = { preview, draft, apply, restore }[command];
if (!run) {
  console.error("Usage: node reformat-explanations.mjs preview | draft | apply | restore <file>");
  process.exit(1);
}
if (command === "preview" || command === "draft") need("ANTHROPIC_API_KEY");
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
