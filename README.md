# 🧩 DLE Hub

A single, searchable home for every daily **`-dle`** game (Wordle-likes and friends).
Browse ~1,400 games, favorite the ones you play, and tick them off as you finish
each day — the daily status resets automatically at local midnight.

No build step, no framework, no server required.

## Features

- **One big grid** of games with favicon, name, category and a short description.
- **⭐ Favorites** — star the games you play; filter to just those.
- **✓ Done today** — mark a game complete; it shows a green accent and counts toward
  your daily progress. Everything resets automatically at local midnight.
- **🔔 "Did you finish?" prompt** — when you open a game and then come back to the
  hub tab, a small prompt asks whether you finished it, so marking done is one tap
  in context instead of hunting for the card. Toggle it off with the **🔔 Ask when
  back** button in the toolbar.
  *(Why not fully automatic? Each game stores its own completion state on its own
  domain, and the browser's same-origin policy means this site physically cannot
  read another site's storage. Truly auto-detecting completion would require a
  browser extension. See "Automatic completion tracking" below.)*
- **🔥 Streaks & stats** — an **overall** daily streak (consecutive days you complete
  at least one game) plus a **separate streak for every game**: a 🔥 flame on each
  card, and current-streak / best-streak / times-played tiles in the game's details.
  Also a favorites-done progress ring and a **📊 stats panel** with current/longest
  streak, totals, a GitHub-style activity heatmap, and your most-played games. All
  computed from local history.
- **ⓘ Game details** — tap the info button on any card for a bigger view: **thumbnail**,
  full description, category, daily/unlimited flag, per-game streak, last-played date,
  quick play/favorite/done actions, and **related games** in the same category.
- **Sort by Most played** — using real play-count data from the sources.
- **💾 Backup & transfer** (⚙️ button) — export your favorites + progress to a file
  or a shareable link, and import them on another device. Importing always **merges**
  (never deletes). No account or server required.
- **⌨️ Keyboard shortcuts** — <kbd>/</kbd> focus search, <kbd>↑</kbd>/<kbd>↓</kbd>
  move between games, <kbd>Enter</kbd> play, <kbd>Esc</kbd> close / clear.
- **🎛️ Grouped modes** — games that live on the same site (e.g. Gamedle's 6 modes, or
  a publisher's suite) collapse into one **hub card**; tap it to see every mode, each
  with its own play / favorite / done / streak. Keeps the list tidy without losing detail.
- **▦ List / grid view** — toggle between the compact list and a thumbnail gallery.
- **📱 Installable (PWA)** — add it to your home screen and it works offline (see below).
- **🔍 Search** across names, descriptions and categories.
- **Category chips** (18 categories) + sort by name / favorites-first / category.
- **Light / dark / auto** theme toggle.
- All personal data (favorites, daily progress, preferences) is stored in your
  browser's `localStorage` — nothing leaves your device.

## Run it

Just open **`index.html`** in your browser (double-click it). That's it.

> The data is baked into `games.js` (as `window.GAMES_DATA`) specifically so the
> app works from `file://` with no server and no CORS problems.

If you prefer serving it over HTTP (e.g. to host it, or to use a `#dle=` share
link locally), a tiny zero-dependency server is included:

```bash
node server.mjs
```

Then open http://localhost:8777. Any other static server works too
(`npx --yes serve .`). To publish, drop the whole folder on GitHub Pages,
Netlify, Cloudflare Pages, etc. — it's fully static.

### Install it as an app (PWA)

When served over **http/https** (the local server above, or any host — not `file://`),
the app registers a service worker and can be installed:

- **Desktop (Chrome/Edge):** click the install icon in the address bar.
- **iOS Safari:** Share → *Add to Home Screen*.
- **Android Chrome:** menu → *Install app*.

Once installed it opens fullscreen and works **offline** (the app shell + game list
are cached). Game thumbnails and favicons are loaded from other sites, so those need
a connection. Bump `CACHE` in `sw.js` whenever you change the shell files.

## Deploy it live

The app is fully static, so hosting is free and takes a minute. Two easy paths:

### Option A — Netlify Drop (no account setup, instant)

1. Go to **https://app.netlify.com/drop**
2. Drag the whole `DLE` folder onto the page.
3. You get a live `https://<name>.netlify.app` URL immediately. Rename it in
   *Site settings → Change site name*.

### Option B — GitHub Pages (best for updates; a permanent URL)

The repo is already committed locally, so:

1. Create a new **public** repo on GitHub (e.g. `dle-hub`) — don't add a README.
2. Push it:
   ```bash
   git remote add origin https://github.com/<your-username>/dle-hub.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, pick branch **main** and folder **/ (root)**, then **Save**.
4. In ~1 minute it's live at `https://<your-username>.github.io/dle-hub/`.

To update later: `git add -A && git commit -m "update" && git push` (Pages redeploys
automatically). All asset paths are relative, so it works under the `/dle-hub/`
subpath, and the service worker (network-first) picks up changes on the next visit.

Once it's on https, open it on your phone and **Add to Home Screen** to install it
as an app (see PWA section above).

## Cloud accounts & sync (optional)

By default all data is local. To sync streaks / done-games / favorites across devices
with a passwordless login, connect a free [Supabase](https://supabase.com) project:

1. Create a free Supabase project (supabase.com → New project).
2. **SQL Editor → New query →** paste [`supabase-setup.sql`](supabase-setup.sql) → **Run**.
3. **Authentication → URL Configuration:** set **Site URL** to your live URL
   (e.g. `https://<user>.github.io/dle-hub/`) and add both that URL and
   `http://localhost:8777` to **Redirect URLs**. (Email auth is on by default.)
4. **Project Settings → API:** copy the **Project URL** and the **anon public** key.
5. Paste them into [`supabase-config.js`](supabase-config.js), then commit & push.

The 👤 button then appears — sign in with your email (magic link), and your data
merges and syncs automatically. Sync is **merge-only** (union across devices), so
nothing is ever deleted; un-favoriting on one device won't remove it on another.
The anon key is safe to commit (public by design; data is protected by row-level
security). Never commit the `service_role` key.

## Refreshing the game list

The dataset is generated by `scrape.mjs` (Node 18+, uses built-in `fetch`, no
dependencies to install):

```bash
node scrape.mjs
```

This regenerates both `data/games.json` and `games.js` (~1,400 games).

Optional flags:

```bash
node scrape.mjs --check-links       # probe every game URL, write data/link-report.json
node scrape.mjs --check-links=50    # probe only the first 50 (quick test)
node scrape.mjs --check-links --prune  # also drop games that are clearly dead (DNS/404)
```

The link checker is conservative: only DNS failures / 404 / 410 count as "dead";
403/429 responses are kept (they're usually bot-protection, not a dead game).

### Where the data comes from

| Source | How it's used |
|--------|---------------|
| [aukspot/dles](https://dles.aukspot.com/) ([repo](https://github.com/aukspot/dles)) | Curated structured JSON — name, URL, description, category. |
| [alldle.net](https://www.alldle.net/) (`api.alldle.net/games`) | Rich JSON API — adds games, descriptions, **thumbnails**, and a daily/unlimited flag. |
| [seekdle.com](https://seekdle.com/) | Embedded JSON island — ~1,000 games with descriptions and categories. |
| [listdle.com](https://listdle.com/) | Parsed from the page — catches any games the others miss, with descriptions. |

Other directories exist ([dlelist.com](https://dlelist.com/), [wordly.org](https://wordly.org/wordle-games), [dlegames.org](https://dlegames.org/)) but overlap almost entirely with the four above; dlelist adds only ~40 long-tail games and exposes names but no categories/descriptions, so it's not wired in.

Games are merged and **de-duplicated** by URL and name-slug. The merge also
**enriches**: a game found in several sources keeps the first source's category but
back-fills any missing description / thumbnail / daily-flag / popularity from the
others. Categories from all sources are folded onto one consistent 18-category
taxonomy. Result: ~1,400 games, **0 blank descriptions**, ~980 with thumbnails.

Each game record: `id, name, url, category, description, thumbnail, unlimited, popularity`.

## Multi-mode games & result types

Some games (e.g. Brawldle) have several internal daily modes on one URL — the
scrapers above only see one row per game/URL, so modes can't be picked up
automatically from those sources. `data/overrides.json` layers extra info on
top of `games.json` without touching the generated dataset:

```json
{
  "brawldle": {
    "resultType": "guesses",
    "modes": [
      { "id": "classic", "label": "Classic", "path": "/classic" },
      { "id": "gadget", "label": "Gadget", "path": "/gadget" }
    ]
  }
}
```

- `modes` expands one catalog entry into several trackable entries (own streak,
  favorite, daily completion), grouped into one hub card — same UI as the
  existing same-host grouping.
- `resultType` (per game or per mode) is one of `guesses` (default — a count,
  Wordle-style), `winloss` (no number, just solved/failed), `score` (a plain
  number), or `time` (formatted mm:ss). It controls how the detail view's
  stats and "log a result" field are labeled/formatted. Games also silently
  *learn* a different type the first time a pasted result clearly implies one
  (e.g. pasting "1:23" for a game with no override).

After hand-editing `data/overrides.json`, regenerate `overrides.js` (the
`window.GAMES_OVERRIDES` script the app actually loads):

```bash
node build-overrides.mjs
```

`node scan-modes.mjs` does a best-effort automated pass over every game URL
looking for mode signals (embedded SPA JSON, `<select>` mode pickers, repeated
`?mode=` links, description text) and auto-adds only *high-confidence* hits to
`overrides.json`; everything else is written to
`data/mode-scan-report.json` for manual review. It's HTML-only (no headless
browser), so it misses modes that only render after client-side JS — most
`-dle` sites are SPAs, so treat it as a rough first pass, not a full audit.

## Automatic completion tracking

A common question: *can it just know when I've finished a game?* Not from a plain
website. Each `-dle` stores "solved today" in **its own** site's `localStorage`/
cookies (on `nytimes.com`, `nerdlegame.com`, …). The browser's same-origin policy
means this app cannot read another site's storage, there's no shared "you won"
signal to listen for, and the games block being embedded in an iframe. So the hub
has no way to *detect* completion.

The closest practical option without an install is the **"Did you finish?" prompt**
(enabled by default) — you open a game, and when you switch back to the hub it asks
you in one tap. The only way to *truly* auto-detect completion is a **browser
extension** (it can run code on each game's page), but because ~1,000 games each
store state differently, detection would be reliable only for a handful of popular
games. That's a separate, larger project — ask if you want to go there.

## Project layout

```
DLE/
├── index.html      # markup
├── styles.css      # styling + light/dark theme
├── app.js          # all app logic (search, favorites, daily reset, filters)
├── games.js        # generated dataset as window.GAMES_DATA (loaded by index.html)
├── overrides.js    # generated as window.GAMES_OVERRIDES (multi-mode games + result types)
├── scrape.mjs      # regenerates the dataset from the sources
├── scan-modes.mjs  # best-effort scan for multi-mode games, writes overrides.json + report
├── build-overrides.mjs  # regenerates overrides.js from a hand-edited data/overrides.json
├── server.mjs      # optional tiny static server (node server.mjs)
├── manifest.webmanifest  # PWA manifest
├── sw.js           # service worker (offline app shell)
├── icon.svg        # app icon
├── data/
│   ├── games.json          # generated dataset (portable JSON copy)
│   ├── overrides.json      # hand-curated + auto-scanned multi-mode/result-type data
│   ├── mode-scan-report.json  # generated by scan-modes.mjs, full findings for review
│   └── link-report.json    # generated by `--check-links` (dead/blocked URLs)
└── README.md
```

## Notes on stability

- Favorites and daily progress are keyed by a stable slug derived from each game's
  name, so they survive dataset refreshes (as long as a game keeps its name).
- Daily "done" state stores the date it was marked; anything not matching *today's*
  local date is treated as not-done, which is what produces the automatic reset.
