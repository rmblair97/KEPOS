// Kepos — one-off explanation reformatter.
//
// Rewrites each card's `explanation` to the house style (paragraph breaks, one real insight,
// length that follows the concept). Changes ONLY the `explanation` column, in place.
// Title, hook, example, conversation angle and questions are sent as context but never written.
//
// Needs Node 18+ and `npm install` already run in this folder (uses @supabase/supabase-js).
// Secrets come from your terminal, never from the app:
//   SUPABASE_URL              e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY Supabase dashboard > Project Settings > API (service_role)
//   ANTHROPIC_API_KEY         from console.anthropic.com
//
// Steps:
//   1. node reformat-explanations.mjs preview          rewrites 3 cards, prints before/after, writes NOTHING to the database
//   2. node reformat-explanations.mjs apply            after you approve: updates the 3 approved cards, then all the rest
//   Undo:  node reformat-explanations.mjs restore <backup-file.json>
//
// Options: --also "Title"   choose the third preview card (default: first other card)
//          --force          also redo cards whose explanation already has paragraph breaks
//          --limit N        in apply, stop after N cards (for a trial run)

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MODEL = process.env.MODEL || "claude-sonnet-5"; // same model as the generate-cards function
const TABLE = "concepts";
const PREVIEW_FILE = "reformat-preview.json";
const PREVIEW_TITLES = ["monty hall", "ship of theseus"];

const [, , command = "preview", ...rest] = process.argv;
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const need = (k) => {
  if (!process.env[k]) {
    console.error(`Missing ${k}. Set it in this terminal first (see the top of this file).`);
    process.exit(1);
  }
  return process.env[k];
};
const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

const STYLE = `HOUSE STYLE FOR AN EXPLANATION

The card shows its hook as the lead line, with your explanation straight underneath. So do NOT restate the hook; start with what the idea is.
Write short paragraphs of 2-4 sentences each, separated by a blank line (two newline characters). No bullets, headings or markdown.
  1. What it is: plainly, no jargon.
  2. Why it matters: the mechanism or consequence.
  3. The twist (optional): a surprising origin, a counter-intuitive implication, or the part most people get wrong.

One-insight rule: the explanation must deliver at least ONE thing the reader could not have guessed (a mechanism, a reframe, a surprising origin, a sharp consequence). If the current text only restates the obvious, replace the filler with a true insight. Never invent facts: use only what you are confident is accurate and established, and keep everything the current explanation correctly says that matters.

Length: let the concept decide. Default is tight: 2-3 short paragraphs. Go longer only when the idea cannot be understood without it: a step-by-step walk-through (Monty Hall: show why switching wins 2/3 of the time), a worked example or concrete numbers that make a counter-intuitive result believable, or two sides laid out in full (Ship of Theseus: the replaced ship AND the rebuilt one). Test: could you cut a sentence without losing understanding? If yes, cut it. Extra length buys comprehension, not richness.

Tone: confident and precise. Short sentences. A memorable line beats a complete one. The reader should think "huh, I didn't know that". Avoid hedging, throat-clearing ("It is interesting to note that...") and dictionary-style definitions.

Keep the card's meaning. Do not contradict the card's example, conversation angle or questions, and do not copy them into the explanation.`;

const tool = {
  name: "save_explanation",
  description: "Save the rewritten explanation.",
  input_schema: {
    type: "object",
    properties: { explanation: { type: "string", description: "House-style explanation, paragraphs separated by a blank line" } },
    required: ["explanation"],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rewrite(card) {
  const context = {
    title: card.title,
    category: card.category,
    hook: card.hook,
    example: card.example,
    conversation_angle: card.conversation_angle,
  };
  const prompt = `${STYLE}

Rewrite this card's explanation to the house style.

Card context (do not rewrite these, they stay as they are):
${JSON.stringify(context, null, 2)}

CURRENT EXPLANATION:
${card.explanation}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        tools: [tool],
        tool_choice: { type: "tool", name: "save_explanation" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.content?.find((b) => b.type === "tool_use")?.input?.explanation;
    const clean = typeof text === "string" ? text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
    const problem = check(clean);
    if (!problem) return clean;
    console.warn(`  retry (${problem})`);
  }
  throw new Error("could not get a valid rewrite");
}

function check(text) {
  if (!text) return "empty";
  if (!/\n\n/.test(text)) return "no paragraph breaks";
  if (/^\s*([-*•]|#{1,6}\s|\d+\.)\s/m.test(text)) return "contains bullets or headings";
  if (text.length > 4000) return "too long";
  return null;
}

async function loadCards() {
  const { data, error } = await supabase.from(TABLE).select("*").order("title");
  if (error) throw error;
  return data;
}

function save(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

async function preview() {
  const cards = await loadCards();
  const backup = `explanation-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  save(backup, cards.map(({ id, title, explanation }) => ({ id, title, explanation })));
  console.log(`Backup of every current explanation: ${backup}\n`);

  const picks = [];
  for (const t of PREVIEW_TITLES) {
    const c = cards.find((x) => x.title?.trim().toLowerCase() === t);
    if (c) picks.push(c);
    else console.log(`(No card titled "${t}" found, skipping)`);
  }
  const alsoTitle = option("also")?.trim().toLowerCase();
  const extra = alsoTitle
    ? cards.find((x) => x.title?.trim().toLowerCase() === alsoTitle)
    : cards.find((x) => !picks.includes(x) && x.explanation);
  if (extra && picks.length < 3) picks.push(extra);

  const results = [];
  for (const c of picks) {
    const after = await rewrite(c);
    results.push({ id: c.id, title: c.title, before: c.explanation, after });
    console.log(`==================== ${c.title} ====================`);
    console.log(`HOOK (unchanged): ${c.hook}\n`);
    console.log(`--- BEFORE (${c.explanation.length} chars) ---\n${c.explanation}\n`);
    console.log(`--- AFTER (${after.length} chars) ---\n${after}\n`);
  }
  save(PREVIEW_FILE, results);
  console.log(`Nothing was written to the database. Preview saved to ${PREVIEW_FILE}.`);
  console.log(`If you approve, run:  node reformat-explanations.mjs apply`);
}

async function apply() {
  if (!fs.existsSync(PREVIEW_FILE)) {
    console.error(`Run "preview" first and approve it (${PREVIEW_FILE} not found).`);
    process.exit(1);
  }
  const approved = JSON.parse(fs.readFileSync(PREVIEW_FILE, "utf8"));
  const cards = await loadCards();
  const backup = `explanation-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  save(backup, cards.map(({ id, title, explanation }) => ({ id, title, explanation })));
  console.log(`Backup: ${backup} (undo with: node reformat-explanations.mjs restore ${backup})\n`);

  const limit = parseInt(option("limit") ?? "", 10) || Infinity;
  let done = 0, failed = 0, skipped = 0;

  for (const c of cards) {
    if (done >= limit) break;
    const pre = approved.find((a) => a.id === c.id);
    let after = pre?.after;
    if (!after) {
      if (!c.explanation?.trim()) { skipped++; continue; }
      if (!flag("force") && /\n\s*\n/.test(c.explanation.trim())) { skipped++; continue; } // already paragraphs
      try {
        after = await rewrite(c);
      } catch (e) {
        failed++;
        console.error(`FAILED  ${c.title}: ${e.message}`);
        continue;
      }
    }
    const { error } = await supabase.from(TABLE).update({ explanation: after }).eq("id", c.id);
    if (error) {
      failed++;
      console.error(`FAILED  ${c.title}: ${error.message}`);
    } else {
      done++;
      console.log(`updated ${c.title}`);
    }
    await sleep(300);
  }
  console.log(`\nDone. Updated ${done}, skipped ${skipped} (already paragraphs or empty), failed ${failed}.`);
  if (failed) console.log("Re-run the same command to retry the failures; finished cards are skipped.");
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

if (command !== "restore") need("ANTHROPIC_API_KEY");
const run = { preview, apply, restore }[command];
if (!run) {
  console.error("Usage: node reformat-explanations.mjs preview | apply | restore <file>");
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
