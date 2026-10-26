# DLE Hub Auto-Tracker (browser extension)

Automatically records your `-dle` results — **win/loss + guess count** — into DLE Hub,
for (almost) **every** game, without you clicking anything in the hub.

## How it works

Two ways to capture results:

### 1. Share-button hook (every game)
When you finish a game and press **Share**, the game copies text like:

```
Wordle 1,234 4/6
🟩🟨⬛⬛⬛
🟩🟩🟩🟩🟩
```

The extension reads that at copy time, parses **solved vs failed** and the **guess count**, and queues it.

The hook also catches the phone **share sheet** (`navigator.share`). The raw share text is
sent along to the hub, whose own parser also understands times (`⏱ 1:42`), scores, hints
and `8/10 correct`.

### 2. Auto-detect when a game ends (no Share needed)
**Any game:** most daily games keep running stats in `localStorage` — games played, games
won, a guess distribution. The extension snapshots those when the game page loads; the
moment the *played* counter goes up, a game just ended: the won/failed counters say how it
went and the distribution bucket that grew gives the guess count. No per-site setup.

**Hand-tuned detectors** for a few popular games that don't keep stats that way:

- **NYT Wordle** (`nytimes.com/games/wordle`)
- **Nerdle** (`nerdlegame.com` and subdomains)
- **Worldle** (`worldle.teuteuf.fr`)
- **Waffle** (`wafflegame.net`)
- **Quordle**, **Octordle**, **Dordle**, **Heardle**

Detection is best-effort — games change their storage format over time, and games that only
keep stats on their server can't be seen. If auto-detect misses one, the Share hook still works.

When the hub is open with the extension installed, its black band shows **⚡ Auto-tracking on**.
Results from a site with several games (one per mode) are matched by the page's URL path.

Results appear in the hub when you **open or focus** the hub tab (polled every few seconds), not only on full page load.

**Rule of thumb:** play a game → either finish normally (auto-detect) or hit Share → open DLE Hub.

## Install

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
3. (Temporary add-ons are removed when you restart Firefox — reload it the same way, or install permanently by signing it at addons.mozilla.org.)

### Chrome / Edge
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension` folder

## Limitations (honest)

- Auto-detect needs the game to keep its stats in the browser (most do); games that store them only on their server, or that only start counting after you finish, fall back to **Share**.
- A result only counts if it ends while the game's tab is open — finishing a game, closing it, and reopening later is fine, but stats that were already updated before the page loaded can't be noticed.
- It triggers on **sharing** when auto-detect doesn't apply — if you never press Share and the game isn't supported for detection, use the hub's manual Solved/Failed.
- Games whose share text isn't a `n/6`-style format may not parse reliably — use the hub's paste modal for those.
- Results sync to the hub when the tab is **open/focused** (polled every ~4s).
- The hub URL is configured in `manifest.json` (`gjs2410.github.io/dle-hub`, plus `localhost` / `127.0.0.1` on any port). Add your own host to the `deliver.js` `matches` if needed — without a port number, which Firefox's match patterns don't reliably support.
- It requests access to all sites (needed to watch for share text and read game state) — it only reads completion-like data and sends it to your hub.
