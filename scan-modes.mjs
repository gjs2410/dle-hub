#!/usr/bin/env node
/**
 * DLE Hub mode scanner
 * ---------------------
 * Best-effort scan of every game URL in data/games.json looking for signs that
 * the game offers multiple internal modes (e.g. Brawldle's Classic/Gadget/Star
 * Power modes) that the catalog scrapers can't see, since they only capture
 * one row per game/URL.
 *
 * This is HTML-only (no JS execution / no headless browser), so it will miss
 * modes that only appear after client-side rendering. It looks for:
 *   1. Embedded SPA state (Next.js __NEXT_DATA__, Nuxt __NUXT__/__NUXT_DATA__,
 *      or any <script type="application/json">) containing a key matching
 *      /mode/i whose value is a plausible list of mode names.          [high]
 *   2. <select> elements whose id/name/class mentions "mode" with 2+ <option>s. [medium]
 *   3. Repeated links/buttons on the page pointing at the same path with a
 *      distinct ?mode=xxx (or /mode/xxx) query/segment.                 [medium]
 *   4. Meta/og description text like "N modes: A, B, and C".            [low]
 *
 * Output:
 *   data/mode-scan-report.json   — full findings per game, for audit
 *   data/overrides.json          — auto-populated with HIGH confidence hits only
 *                                   (merges with any existing manual entries;
 *                                   never overwrites an existing manual entry)
 *
 * Usage:
 *   node scan-modes.mjs                  scan all games
 *   node scan-modes.mjs --limit=50       scan only the first 50 (quick test)
 *   node scan-modes.mjs --concurrency=20 override default concurrency (15)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (DLE-Hub mode scanner)";
const DATA_DIR = join(__dirname, "data");
const GAMES_PATH = join(DATA_DIR, "games.json");
const REPORT_PATH = join(DATA_DIR, "mode-scan-report.json");
const OVERRIDES_PATH = join(DATA_DIR, "overrides.json");

const GENERIC_WORDS = new Set([
  "home", "about", "menu", "close", "back", "next", "prev", "previous", "share",
  "stats", "statistics", "help", "how to play", "settings", "login", "sign in",
  "sign up", "privacy", "terms", "contact", "faq", "archive", "leaderboard",
  "play", "start", "submit", "continue", "loading", "results", "result",
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: 0, concurrency: 15 };
  for (const a of args) {
    if (a.startsWith("--limit=")) out.limit = parseInt(a.split("=")[1], 10) || 0;
    else if (a.startsWith("--concurrency=")) out.concurrency = parseInt(a.split("=")[1], 10) || 15;
  }
  return out;
}

function cleanLabel(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function looksLikeModeLabel(s) {
  const t = cleanLabel(s);
  if (!t || t.length < 2 || t.length > 30) return false;
  if (/^\d+$/.test(t)) return false;
  if (GENERIC_WORDS.has(t.toLowerCase())) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 '&/+-]*$/.test(t);
}

function dedupeLabels(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const label = cleanLabel(raw);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// signal 1: embedded SPA JSON state
// ---------------------------------------------------------------------------

function extractJsonIslands(html) {
  const islands = [];
  const scriptRe = /<script[^>]*(?:id="__NEXT_DATA__"|id="__NUXT_DATA__"|type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      islands.push(JSON.parse(m[1]));
    } catch {
      /* not valid JSON, skip */
    }
  }
  // Also try window.__NUXT__ = {...}; assignments (not valid JSON, best-effort skip; too fragile to eval safely)
  return islands;
}

function findModeArraysInJson(node, depth = 0, path = "") {
  const found = [];
  if (!node || depth > 6) return found;
  if (Array.isArray(node)) {
    for (const item of node) found.push(...findModeArraysInJson(item, depth + 1, path));
    return found;
  }
  if (typeof node !== "object") return found;
  for (const [key, val] of Object.entries(node)) {
    if (/mode/i.test(key) && Array.isArray(val) && val.length >= 2 && val.length <= 12) {
      const labels = val
        .map((v) => {
          if (typeof v === "string") return v;
          if (v && typeof v === "object") return v.label || v.name || v.title || v.id || null;
          return null;
        })
        .filter(Boolean)
        .filter(looksLikeModeLabel);
      const deduped = dedupeLabels(labels);
      if (deduped.length >= 2) found.push({ path: path + "." + key, labels: deduped });
    }
    found.push(...findModeArraysInJson(val, depth + 1, path + "." + key));
  }
  return found;
}

// ---------------------------------------------------------------------------
// signal 2: <select> with "mode" in id/name/class
// ---------------------------------------------------------------------------

function findModeSelects(html) {
  const found = [];
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = selectRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/mode/i.test(attrs)) continue;
    const optionRe = /<option\b[^>]*>([^<]*)<\/option>/gi;
    const labels = [];
    let om;
    while ((om = optionRe.exec(m[2])) !== null) labels.push(om[1]);
    const deduped = dedupeLabels(labels).filter(looksLikeModeLabel);
    if (deduped.length >= 2) found.push({ labels: deduped });
  }
  return found;
}

// ---------------------------------------------------------------------------
// signal 3: repeated links with distinct ?mode=xxx / /mode/xxx
// ---------------------------------------------------------------------------

function findModeLinks(html) {
  const values = new Set();
  const hrefRe = /href="([^"]+)"/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    const q = href.match(/[?&]mode=([A-Za-z0-9_-]+)/i);
    if (q) values.add(decodeURIComponent(q[1]));
    const seg = href.match(/\/modes?\/([A-Za-z0-9_-]+)/i);
    if (seg) values.add(decodeURIComponent(seg[1]));
  }
  const labels = dedupeLabels([...values].map((v) => v.replace(/[-_]/g, " ")));
  return labels.filter(looksLikeModeLabel);
}

// ---------------------------------------------------------------------------
// signal 4: description text "N modes: A, B, and C"
// ---------------------------------------------------------------------------

function findModeDescriptionText(html) {
  const metaRe = /<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]*)"/gi;
  const texts = [];
  let m;
  while ((m = metaRe.exec(html)) !== null) texts.push(m[1]);
  const found = [];
  for (const text of texts) {
    const dm = text.match(/(\d+)\s*(?:game\s*)?modes?[:\-]?\s*([^.!]{3,150})/i);
    if (!dm) continue;
    const n = parseInt(dm[1], 10);
    if (!n || n < 2 || n > 10) continue;
    const parts = dm[2]
      .replace(/\band\b/gi, ",")
      .split(/,|\//)
      .map((s) => s.trim())
      .filter(Boolean);
    const deduped = dedupeLabels(parts).filter(looksLikeModeLabel);
    if (deduped.length >= 2) found.push({ expected: n, labels: deduped });
  }
  return found;
}

// ---------------------------------------------------------------------------
// per-game scan
// ---------------------------------------------------------------------------

async function scanGame(g) {
  const result = { id: g.id, name: g.name, url: g.url, status: "ok", confidence: "none", modes: [], evidence: [] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let html;
  try {
    const res = await fetch(g.url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html" },
    });
    if (!res.ok) {
      result.status = `http-${res.status}`;
      return result;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && ct !== "") {
      result.status = "non-html";
      return result;
    }
    html = await res.text();
  } catch (err) {
    result.status = err.name === "AbortError" ? "timeout" : "unreachable";
    return result;
  } finally {
    clearTimeout(t);
  }

  // Signal 1: embedded JSON (highest confidence)
  try {
    const islands = extractJsonIslands(html);
    for (const island of islands) {
      const hits = findModeArraysInJson(island);
      for (const hit of hits) {
        result.evidence.push({ kind: "embedded-json", path: hit.path, labels: hit.labels });
        if (hit.labels.length > result.modes.length) result.modes = hit.labels;
        result.confidence = "high";
      }
    }
  } catch { /* ignore */ }

  // Signal 2: <select> with mode options
  if (result.confidence !== "high") {
    const selects = findModeSelects(html);
    for (const s of selects) {
      result.evidence.push({ kind: "select", labels: s.labels });
      if (s.labels.length > result.modes.length) result.modes = s.labels;
      result.confidence = "medium";
    }
  }

  // Signal 3: repeated mode links
  if (result.confidence === "none" || result.confidence === "medium") {
    const linkLabels = findModeLinks(html);
    if (linkLabels.length >= 2) {
      result.evidence.push({ kind: "link-params", labels: linkLabels });
      if (linkLabels.length > result.modes.length) result.modes = linkLabels;
      if (result.confidence === "none") result.confidence = "medium";
    }
  }

  // Signal 4: description text (lowest confidence, always recorded even if we already have better)
  const descHits = findModeDescriptionText(html);
  for (const d of descHits) {
    result.evidence.push({ kind: "description", expected: d.expected, labels: d.labels });
    if (result.confidence === "none") {
      result.modes = d.labels;
      result.confidence = "low";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const payload = JSON.parse(await readFile(GAMES_PATH, "utf8"));
  let games = payload.games;
  if (opts.limit) games = games.slice(0, opts.limit);

  console.log(`Scanning ${games.length} games (concurrency ${opts.concurrency})...`);

  const results = [];
  let done = 0, high = 0, medium = 0, low = 0, failed = 0;
  const queue = games.slice();
  const workers = Array.from({ length: opts.concurrency }, async () => {
    while (queue.length) {
      const g = queue.shift();
      const r = await scanGame(g);
      results.push(r);
      done++;
      if (r.confidence === "high") high++;
      else if (r.confidence === "medium") medium++;
      else if (r.confidence === "low") low++;
      if (r.status !== "ok") failed++;
      if (done % 50 === 0 || done === games.length) {
        console.log(`  ...${done}/${games.length}  (high:${high} medium:${medium} low:${low} unreachable/failed:${failed})`);
      }
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.id.localeCompare(b.id));

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    REPORT_PATH,
    JSON.stringify({ scannedAt: new Date().toISOString(), count: results.length, results }, null, 2),
    "utf8"
  );
  console.log(`\n✓ Wrote ${REPORT_PATH}`);

  // Merge HIGH confidence hits into overrides.json, never clobbering existing manual entries.
  let overrides = {};
  try {
    overrides = JSON.parse(await readFile(OVERRIDES_PATH, "utf8"));
  } catch { /* file doesn't exist yet */ }

  let added = 0;
  for (const r of results) {
    if (r.confidence !== "high") continue;
    if (overrides[r.id]) continue; // don't overwrite manual/prior curation
    overrides[r.id] = {
      modes: r.modes.map((label) => ({
        id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        label,
      })),
      source: "auto-scan",
      scannedAt: new Date().toISOString(),
    };
    added++;
  }

  await writeFile(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), "utf8");
  console.log(`✓ Wrote ${OVERRIDES_PATH} (+${added} auto-added high-confidence entries)`);

  await writeFile(
    join(__dirname, "overrides.js"),
    `// Auto-generated by scan-modes.mjs / build-overrides.mjs from data/overrides.json — do not edit by hand.\nwindow.GAMES_OVERRIDES = ${JSON.stringify(overrides)};\n`,
    "utf8"
  );
  console.log("✓ Wrote overrides.js");

  const needsReview = results.filter((r) => r.confidence === "medium" || r.confidence === "low");
  console.log(`\nSummary: ${high} high-confidence, ${medium} medium, ${low} low, ${failed} unreachable/failed.`);
  console.log(`${needsReview.length} games flagged for manual review in ${REPORT_PATH} (confidence: medium/low).`);
}

main().catch((err) => {
  console.error("Scan failed:", err);
  process.exit(1);
});
