#!/usr/bin/env node
/**
 * DLE Hub scraper
 * ----------------
 * Builds the game dataset by pulling from public "-dle" aggregators and merging
 * them into a single, de-duplicated, enriched list.
 *
 * Sources (in enrichment priority order):
 *   1. aukspot/dles      -> clean structured JSON (name/url/description/category).
 *   2. alldle.net API    -> https://api.alldle.net/games?limit=2000 — rich JSON with
 *                           descriptions, THUMBNAILS, daily/unlimited flag, play counts.
 *   3. listdle.com        -> Svelte SSR page; cards carry name, category, domain AND a
 *                           short description.
 *   4. playlin.io        -> Astro SSR; no single "all games" page, so every category,
 *                           sub-category and collection page in its sitemap is crawled
 *                           and de-duped by slug; games no listing shows are read from
 *                           their own page (retired ones skipped). Cards carry name,
 *                           external URL, a one-line "hook", and a thumbnail.
 *
 * Merge is de-duplicating (by normalized URL and by name-slug) AND enriching:
 * a game found in several sources keeps the first source's category but back-fills
 * any missing description / thumbnail / unlimited flag / popularity from the others.
 *
 * Output:
 *   data/games.json  -> the dataset (portable JSON)
 *   games.js         -> same data as `window.GAMES_DATA` so the site runs from file://
 *
 * Usage:
 *   node scrape.mjs                     regenerate the dataset
 *   node scrape.mjs --check-links       also probe every game URL, write data/link-report.json
 *   node scrape.mjs --check-links=50    probe only the first 50 (for a quick test)
 *   node scrape.mjs --check-links --prune   drop games that are clearly dead (DNS/404)
 *
 * Requires Node 18+ (built-in fetch). No dependencies.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (DLE-Hub scraper)";

const AUKSPOT_JSON =
  "https://raw.githubusercontent.com/aukspot/dles/main/src/lib/data/dles.json";
const ALLDLE_API = "https://api.alldle.net/games?limit=2000";
const SEEKDLE_URL = "https://seekdle.com/";
const LISTDLE_URL = "https://listdle.com/";
// playlin.io has no single "all games" page. Its sitemap lists every game page plus every
// category/sub-category/collection listing page; the listings are crawled for game cards
// (de-duped by slug), and the few games no listing shows are read from their own page.
const PLAYLIN_SITEMAP = "https://playlin.io/_playlin-sitemap-0.xml";
// Top-level category slug -> its label (category pages don't print a pill on each card,
// since the page itself is the category). Also the fallback crawl list if the sitemap fails.
const PLAYLIN_CATEGORY_LABELS = {
  "animal-games": "animal", "arcade-games": "arcade game", estimation: "estimation",
  "fandom-games": "fandom", "food-games": "food", "geography-games": "geography",
  "learning-games": "learning", "logic-games": "logic & deduction", luck: "luck",
  "math-games": "math game", "movies-and-tv-games": "movies & tv", "music-games": "music",
  "number-games": "number", "other-games": "other", "pop-culture-games": "pop culture",
  skill: "skill", "sports-games": "sports", "sudoku-games": "sudoku",
  "trivia-games": "trivia & knowledge", "visual-games": "visual & pattern",
  "weird-games": "weird & wonderful", "word-games": "word game",
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function urlKey(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, "").toLowerCase().replace(/^www\./, "");
  } catch {
    return String(url).toLowerCase();
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

// Fold every incoming category onto one canonical vocabulary.
const CANON = {
  word: "Words", words: "Words",
  math: "Math/Logic", maths: "Math/Logic", logic: "Math/Logic",
  "math/logic": "Math/Logic", "logic & math": "Math/Logic", "math & logic": "Math/Logic",
  geography: "Geography", geo: "Geography",
  "movies & tv": "Movies/TV", "movies/tv": "Movies/TV", movies: "Movies/TV", tv: "Movies/TV", film: "Movies/TV",
  music: "Music",
  "video games": "Video Games", "video game": "Video Games", games: "Video Games", gaming: "Video Games",
  sports: "Sports", sport: "Sports",
  trivia: "Trivia", guessing: "Estimation",
  history: "History",
  color: "Colors", colors: "Colors", colour: "Colors", colours: "Colors",
  price: "Estimation", prices: "Estimation", estimation: "Estimation",
  mystery: "Miscellaneous", visual: "Miscellaneous", novelty: "Novelty",
  shapes: "Shapes/Patterns", shape: "Shapes/Patterns", patterns: "Shapes/Patterns", "shapes/patterns": "Shapes/Patterns",
  miscellaneous: "Miscellaneous", misc: "Miscellaneous", other: "Miscellaneous",
  "card/board games": "Card/Board Games", "card games": "Card/Board Games",
  "board games": "Card/Board Games", "tabletop games": "Card/Board Games", tabletop: "Card/Board Games",
  "cards & board": "Card/Board Games",
  "science/nature": "Science/Nature", science: "Science/Nature", nature: "Science/Nature",
  "nature & science": "Science/Nature", "science & nature": "Science/Nature",
  food: "Food", "food & drink": "Food",
  vehicles: "Vehicles", vehicle: "Vehicles", cars: "Vehicles", transport: "Vehicles",
  // playlin.io's own category labels
  "arcade game": "Video Games", "word game": "Words", "math game": "Math/Logic",
  "logic & deduction": "Math/Logic", "visual & pattern": "Shapes/Patterns",
  "trivia & knowledge": "Trivia", animal: "Science/Nature", "weird & wonderful": "Novelty",
  estimation: "Estimation", fandom: "Trivia", learning: "Trivia", luck: "Novelty",
  number: "Math/Logic", "pop culture": "Trivia", skill: "Video Games", sudoku: "Math/Logic",
  arcade: "Video Games", "logic & deduction games": "Math/Logic",
};

function normCategory(cat) {
  if (!cat) return "Miscellaneous";
  const c = decodeEntities(String(cat)).trim();
  const key = c.toLowerCase();
  if (CANON[key]) return CANON[key];
  // Game pages say e.g. "Word Games" / "Math" where listings say "word game".
  const bare = key.replace(/ games?$/, "");
  if (CANON[bare]) return CANON[bare];
  return c
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

async function fetchAukspot() {
  console.log("→ Fetching aukspot dataset...");
  const res = await fetch(AUKSPOT_JSON, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`aukspot fetch failed: ${res.status}`);
  const rows = await res.json();
  const games = rows
    .filter((r) => r && r.name && r.url)
    .map((r) => ({
      name: decodeEntities(r.name),
      url: r.url.trim(),
      description: decodeEntities(r.description || ""),
      category: normCategory(r.category),
      thumbnail: "",
      unlimited: undefined,
      popularity: 0,
      source: "aukspot",
    }));
  console.log(`  ✓ aukspot: ${games.length} games`);
  return games;
}

async function fetchAlldle() {
  console.log("→ Fetching alldle.net API...");
  try {
    const res = await fetch(ALLDLE_API, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    const items = (json && json.data && json.data.items) || [];
    const games = items
      .map((it) => it && it.game)
      .filter((g) => g && g.name && g.url && g.status !== "rejected")
      .map((g) => ({
        name: decodeEntities(g.name),
        url: String(g.url).trim(),
        description: decodeEntities(g.description || ""),
        category: normCategory(g.categoryName),
        thumbnail: g.thumbnailUrl || "",
        unlimited: !!g.isUnlimited,
        popularity: parseInt(g.playCount, 10) || 0,
        source: "alldle",
      }));
    console.log(`  ✓ alldle: ${games.length} games (${games.filter((g) => g.thumbnail).length} with thumbnails)`);
    return games;
  } catch (err) {
    console.warn(`  ! alldle fetch failed (${err.message}); continuing without it`);
    return [];
  }
}

async function fetchSeekdle() {
  console.log("→ Fetching seekdle.com...");
  try {
    const res = await fetch(SEEKDLE_URL, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const html = await res.text();
    // The game list is embedded as a JSON island: [{ s, n, d, u, c, f }, ...].
    const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
    let rows = null;
    for (const m of scripts) {
      try {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed) && parsed[0] && parsed[0].u && parsed[0].n) { rows = parsed; break; }
      } catch { /* not the array we want */ }
    }
    if (!rows) throw new Error("game JSON island not found");
    const games = rows
      .filter((r) => r && r.n && r.u)
      .map((r) => ({
        name: decodeEntities(r.n),
        url: String(r.u).trim(),
        description: decodeEntities(r.d || ""),
        category: normCategory(r.c),
        thumbnail: "",
        unlimited: undefined,
        popularity: 0,
        source: "seekdle",
      }));
    console.log(`  ✓ seekdle: ${games.length} games`);
    return games;
  } catch (err) {
    console.warn(`  ! seekdle scrape failed (${err.message}); continuing without it`);
    return [];
  }
}

async function fetchListdle() {
  console.log("→ Fetching listdle.com...");
  try {
    const res = await fetch(LISTDLE_URL, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const html = await res.text();

    const games = [];
    const cardRe = /<a[^>]+href="\/games\/[^"]*"[\s\S]*?<\/a>/g;
    let block;
    while ((block = cardRe.exec(html)) !== null) {
      const b = block[0];
      const domain = (b.match(/domain=([^&"]+)/) || [])[1];
      const name = (b.match(/<span class="text-lg[^"]*">([^<]+)<\/span>/) || [])[1];
      const category = (b.match(/opacity-80[^"]*">([^<]+)<\/span>/) || [])[1];
      const desc = (b.match(/<p class="text-sm[^"]*">([\s\S]*?)<\/p>/) || [])[1];
      if (!domain || !name) continue;
      games.push({
        name: decodeEntities(name),
        url: `https://${domain.trim()}`,
        description: desc ? decodeEntities(desc) : "",
        category: normCategory(category),
        thumbnail: "",
        unlimited: undefined,
        popularity: 0,
        source: "listdle",
      });
    }
    console.log(`  ✓ listdle: ${games.length} games (${games.filter((g) => g.description).length} with descriptions)`);
    return games;
  } catch (err) {
    console.warn(`  ! listdle scrape failed (${err.message}); continuing without it`);
    return [];
  }
}

// Parses the repeated "game card" markup on playlin.io listing pages: a run of hidden
// <input> fields (title, slug, external url, ...) followed by the card's screenshot <img>
// and a one-line "hook". Each card's window ends where the next card starts, so a field
// missing from one card can't be picked up from its neighbour. categoryLabel is the
// listing page's own category (null on collection pages, which mix categories).
function parsePlaylinCards(html, categoryLabel) {
  const games = [];
  const starts = [...html.matchAll(/<input type="hidden" data-game-title value="/g)].map((m) => m.index);
  starts.forEach((start, i) => {
    // The like-button's inline SVG pushes the hook text well past a naive short window.
    const win = html.slice(start, Math.min(starts[i + 1] || html.length, start + 6000));
    const title = (win.match(/data-game-title value="([^"]*)"/) || [])[1];
    const slug = (win.match(/data-game-slug value="([^"]*)"/) || [])[1];
    const url = (win.match(/data-game-url value="([^"]*)"/) || [])[1];
    if (!title || !slug || !url) return;
    const thumb = (win.match(/src="(https:\/\/assets\.playlin\.io\/renditions\/screenshot_card\/[^"]+)"/) || [])[1];
    const hook = (win.match(/data-game-hook[^>]*>([^<]*)</) || [])[1];
    games.push({
      slug,
      name: decodeEntities(title),
      url: url.trim(),
      description: hook ? decodeEntities(hook.trim()) : "",
      category: categoryLabel ? normCategory(categoryLabel) : "",
      thumbnail: thumb || "",
      unlimited: false,
      popularity: 0,
      source: "playlin",
    });
  });
  return games;
}

// A single /game/<slug>/ page, for games no listing page shows. Returns null for games
// Playlin marks as retired ("no longer playable").
function parsePlaylinGamePage(html, slug) {
  const title = (html.match(/data-game-title value="([^"]*)"/) || [])[1];
  const url = (html.match(/data-game-url value="([^"]*)"/) || [])[1];
  if (!title || !url) return null;
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
  const meta = decodeEntities((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "");
  if (/\(Retired\)/i.test(ogTitle) || /since been retired|no longer playable/i.test(meta)) return null;
  // "X is a daily word game that's free to play. <hook>" — keep just the hook.
  const hook = meta.replace(/^[^.]*\bis an? [^.]*\.\s*/, "");
  const cat = (html.match(/<strong>Category:<\/strong>\s*([^<]+)/) || [])[1];
  // Same card-sized rendition the listing pages use, derived from the og:image file name.
  const shot = (html.match(/\/([a-z0-9-]+-screenshot)\.(?:png|jpe?g|webp)"/) || [])[1];
  return {
    slug,
    name: decodeEntities(title),
    url: url.trim(),
    description: hook,
    category: normCategory(cat),
    thumbnail: shot ? `https://assets.playlin.io/renditions/screenshot_card/${shot}.webp` : "",
    unlimited: false,
    popularity: 0,
    source: "playlin",
  };
}

async function fetchPlaylin() {
  console.log("→ Fetching playlin.io...");
  try {
    const get = async (path) => {
      const res = await fetch(`https://playlin.io${path}`, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.text();
    };
    // Runs fn over items, `limit` at a time.
    const pool = async (items, limit, fn) => {
      const queue = items.slice();
      await Promise.all(Array.from({ length: limit }, async () => {
        while (queue.length) await fn(queue.shift());
      }));
    };

    let gameSlugs = [];
    let listings = Object.keys(PLAYLIN_CATEGORY_LABELS).map((c) => `/category/${c}/`);
    try {
      const xml = await (await fetch(PLAYLIN_SITEMAP, { headers: { "user-agent": UA } })).text();
      const paths = [...xml.matchAll(/<loc>https:\/\/playlin\.io([^<]+)<\/loc>/g)].map((m) => m[1]);
      gameSlugs = paths.filter((p) => p.startsWith("/game/")).map((p) => p.split("/")[2]).filter(Boolean);
      const fromMap = paths.filter((p) => /^\/(category|collections)\/./.test(p));
      if (fromMap.length) listings = fromMap;
    } catch (err) {
      console.warn(`  ! playlin sitemap failed (${err.message}); crawling top-level categories only`);
    }
    // Category pages first, so a game's category comes from a real category page rather
    // than staying blank from a collection page.
    listings.sort((a, b) => (a.startsWith("/category/") ? 0 : 1) - (b.startsWith("/category/") ? 0 : 1));

    const byId = new Map();
    let failures = 0;
    // A game appears on several listings (category, sub-category, collections) — enrich
    // rather than keep only the first occurrence, so the best data for each slug wins.
    function enrich(existing, incoming) {
      if (!existing) return incoming;
      if (!existing.description && incoming.description) existing.description = incoming.description;
      if (!existing.thumbnail && incoming.thumbnail) existing.thumbnail = incoming.thumbnail;
      if (!existing.category && incoming.category) existing.category = incoming.category;
      return existing;
    }
    await pool(listings, 6, async (path) => {
      try {
        // /category/word-games/word-grids/ -> "word-games" -> "word game"
        const top = path.startsWith("/category/") ? path.split("/")[2] : null;
        parsePlaylinCards(await get(path), top ? PLAYLIN_CATEGORY_LABELS[top] || top : null).forEach((g) => {
          byId.set(g.slug, enrich(byId.get(g.slug), g));
        });
      } catch (err) {
        failures++;
        console.warn(`  ! playlin${path} failed (${err.message})`);
      }
    });

    // Games in the sitemap that no listing shows (often retired ones): read their own page.
    const unlisted = gameSlugs.filter((s) => !byId.has(s));
    let retired = 0;
    await pool(unlisted, 6, async (slug) => {
      try {
        const g = parsePlaylinGamePage(await get(`/game/${slug}/`), slug);
        if (g) byId.set(slug, g); else retired++;
      } catch (err) {
        failures++;
      }
    });

    const games = [...byId.values()].map(({ slug, ...g }) => ({ ...g, category: g.category || "Miscellaneous" }));
    console.log(
      `  ✓ playlin: ${games.length} games from ${listings.length} listing pages + ${unlisted.length - retired} game pages` +
      ` (${retired} retired skipped${failures ? `, ${failures} page(s) failed` : ""})`
    );
    return games;
  } catch (err) {
    console.warn(`  ! playlin scrape failed (${err.message}); continuing without it`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// merge + enrich
// ---------------------------------------------------------------------------

function mergeAll(sourceLists) {
  const byUrl = new Map();
  const byName = new Map();
  const out = [];

  function enrich(rec, g) {
    if (!rec.description && g.description) rec.description = g.description;
    if (!rec.thumbnail && g.thumbnail) rec.thumbnail = g.thumbnail;
    if (rec.unlimited === undefined && g.unlimited !== undefined) rec.unlimited = g.unlimited;
    if ((g.popularity || 0) > (rec.popularity || 0)) rec.popularity = g.popularity;
  }

  sourceLists.forEach((list, idx) => {
    let added = 0, enriched = 0;
    list.forEach((g) => {
      const uk = urlKey(g.url);
      const nk = slugify(g.name);
      const existing = byUrl.get(uk) || byName.get(nk);
      if (existing) {
        enrich(existing, g);
        enriched++;
      } else {
        const rec = Object.assign({}, g);
        byUrl.set(uk, rec);
        byName.set(nk, rec);
        out.push(rec);
        added++;
      }
    });
    console.log(`  ✓ source #${idx + 1} (${list[0] ? list[0].source : "?"}): +${added} new, ${enriched} enriched`);
  });

  return out;
}

// prevIds maps urlKey -> id from the last dataset. Saved favorites, streaks and history are
// keyed by id, so a game whose source renamed it (same URL) keeps the id it already had
// instead of getting a new one from its new name.
function finalize(games, prevIds = new Map()) {
  const seenIds = new Set();
  // Reserve every id that will be carried over, so a new game can't claim one first.
  const keep = games.map((g) => prevIds.get(urlKey(g.url)));
  keep.forEach((id) => { if (id) seenIds.add(id); });
  const withIds = games.map((g, i) => {
    if (keep[i] && keep.indexOf(keep[i]) === i) {
      return toRecord(keep[i], g);
    }
    let id = slugify(g.name);
    let n = 2;
    const base = id;
    while (seenIds.has(id)) id = `${base}-${n++}`;
    seenIds.add(id);
    return toRecord(id, g);
  });
  withIds.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return withIds;
}

async function readPrevIds() {
  try {
    const prev = JSON.parse(await readFile(join(__dirname, "data", "games.json"), "utf8"));
    return new Map((prev.games || []).map((g) => [urlKey(g.url), g.id]));
  } catch {
    return new Map(); // first run, or no previous dataset
  }
}

function toRecord(id, g) {
  return {
    id,
    name: g.name,
    url: g.url,
    category: g.category,
    description: g.description || "",
    thumbnail: g.thumbnail || "",
    unlimited: g.unlimited === true,
    popularity: g.popularity || 0,
  };
}

// ---------------------------------------------------------------------------
// optional dead-link checker
// ---------------------------------------------------------------------------

async function checkLinks(games, limit) {
  const subset = limit ? games.slice(0, limit) : games;
  console.log(`\n→ Checking ${subset.length} links (this can take a while)...`);
  const CONCURRENCY = 20;
  const dead = [], blocked = [];
  let done = 0;

  async function probe(g) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      let res;
      try {
        res = await fetch(g.url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA } });
      } catch {
        res = await fetch(g.url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA } });
      }
      if (res.status === 404 || res.status === 410) dead.push({ id: g.id, name: g.name, url: g.url, status: res.status });
      else if (res.status === 403 || res.status === 429) blocked.push({ id: g.id, name: g.name, url: g.url, status: res.status });
    } catch (err) {
      // DNS failure / connection refused / timeout -> treat as dead
      dead.push({ id: g.id, name: g.name, url: g.url, status: err.name === "AbortError" ? "timeout" : "unreachable" });
    } finally {
      clearTimeout(t);
      if (++done % 100 === 0) console.log(`  ...${done}/${subset.length}`);
    }
  }

  const queue = subset.slice();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await probe(queue.shift());
  });
  await Promise.all(workers);

  console.log(`  ✓ link check: ${dead.length} dead/unreachable, ${blocked.length} blocked (403/429, likely bot-protection — kept)`);
  return { checkedAt: new Date().toISOString(), checked: subset.length, dead, blocked };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { check: false, checkLimit: 0, prune: false };
  for (const a of args) {
    if (a === "--prune") out.prune = true;
    else if (a === "--check-links") out.check = true;
    else if (a.startsWith("--check-links=")) { out.check = true; out.checkLimit = parseInt(a.split("=")[1], 10) || 0; }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const [aukspot, alldle, seekdle, listdle, playlin] = await Promise.all([
    fetchAukspot(), fetchAlldle(), fetchSeekdle(), fetchListdle(), fetchPlaylin(),
  ]);
  const merged = mergeAll([aukspot, alldle, seekdle, listdle, playlin]);
  let games = finalize(merged, await readPrevIds());

  let linkReport = null;
  if (opts.check) {
    linkReport = await checkLinks(games, opts.checkLimit);
    if (opts.prune && !opts.checkLimit) {
      const deadIds = new Set(linkReport.dead.map((d) => d.id));
      const before = games.length;
      games = games.filter((g) => !deadIds.has(g.id));
      console.log(`  ✓ pruned ${before - games.length} dead games`);
    }
    await mkdir(join(__dirname, "data"), { recursive: true });
    await writeFile(join(__dirname, "data", "link-report.json"), JSON.stringify(linkReport, null, 2), "utf8");
    console.log("  ✓ wrote data/link-report.json");
  }

  const categories = [...new Set(games.map((g) => g.category))].sort();
  const withThumb = games.filter((g) => g.thumbnail).length;
  const withDesc = games.filter((g) => g.description).length;
  console.log(`\nTotal games: ${games.length}`);
  console.log(`With description: ${withDesc} (${games.length - withDesc} blank)`);
  console.log(`With thumbnail:   ${withThumb}`);
  console.log(`Categories (${categories.length}): ${categories.join(", ")}`);

  const payload = { generatedAt: new Date().toISOString(), count: games.length, categories, games };

  await mkdir(join(__dirname, "data"), { recursive: true });
  await writeFile(join(__dirname, "data", "games.json"), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(
    join(__dirname, "games.js"),
    `// Auto-generated by scrape.mjs — do not edit by hand.\nwindow.GAMES_DATA = ${JSON.stringify(payload)};\n`,
    "utf8"
  );
  console.log("\n✓ Wrote data/games.json and games.js");
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
