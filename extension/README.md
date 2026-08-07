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

### 2. Auto-detect on popular games (no Share needed)
On supported sites the extension also polls `localStorage` for a finished game state and records it automatically. Currently includes:

- **NYT Wordle** (`nytimes.com/games/wordle`)
- **Nerdle** (`nerdlegame.com` and subdomains)
- **Worldle** (`worldle.teuteuf.fr`)
- **Waffle** (`wafflegame.net`)
- **Quordle**, **Octordle**, **Dordle**, **Heardle**

Detection is best-effort — games change their storage format over time. If auto-detect misses one, the Share hook still works.

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

- Auto-detect only covers a handful of popular games; everything else still works via **Share**.
- It triggers on **sharing** when auto-detect doesn't apply — if you never press Share and the game isn't supported for detection, use the hub's manual Solved/Failed.
- Games whose share text isn't a `n/6`-style format may not parse reliably — use the hub's paste modal for those.
- Results sync to the hub when the tab is **open/focused** (polled every ~4s).
- The hub URL is configured in `manifest.json` (`gjs2410.github.io/dle-hub` + `localhost:8777`). Add your own host to the `deliver.js` `matches` if needed.
- It requests access to all sites (needed to watch for share text and read game state) — it only reads completion-like data and sends it to your hub.
