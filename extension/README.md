# DLE Hub Auto-Tracker (browser extension)

Automatically records your `-dle` results — **win/loss + guess count** — into DLE Hub,
for (almost) **every** game, without you clicking anything in the hub.

## How it works

It hooks the one thing nearly every `-dle` shares: the **Share / Copy** button.
When you finish a game and press Share, the game copies text like:

```
Wordle 1,234 4/6
🟩🟨⬛⬛⬛
🟩🟩🟩🟩🟩
```

The extension reads that at the moment it's copied, parses **solved vs failed** and
the **guess count** (`4/6` → solved in 4, `X/6` → failed), and queues it. Next time
you open DLE Hub, it drops the results in and the matching game is marked
solved/failed with your guesses filled in.

**So the rule is simple: play a game, hit its Share button, done.**

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

- It triggers on **sharing** — if you never press a game's Share/Copy button, there's
  nothing for it to read.
- Games whose share text isn't a `n/6`-style format (some Connections/geography games)
  may not parse a win/guess reliably — use the hub's manual Solved/Failed for those.
- Results appear in the hub **when you next open/refresh it** (it delivers on hub load).
- The hub URL is hard-coded in `manifest.json` (`gjs2410.github.io/dle-hub` +
  `localhost:8777`). If you host it elsewhere, add that URL to the `deliver.js`
  content-script `matches` and reload the extension.
- It requests access to all sites (needed to watch for share text anywhere) — it only
  ever reads text that looks like a `-dle` result and sends it to your own hub.
