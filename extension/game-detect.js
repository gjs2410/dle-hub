// Runs in the PAGE world. Polls known -dle sites for completion in localStorage / DOM,
// so results can be recorded without pressing Share. Forwards to the extension via postMessage.
(function () {
  "use strict";

  var host = location.hostname.replace(/^www\./, "");
  var path = location.pathname || "";
  var lastSig = "";

  function emit(payload) {
    var sig = JSON.stringify(payload);
    if (!sig || sig === lastSig) return;
    lastSig = sig;
    try {
      window.postMessage({ __dleResult: true, payload: payload }, "*");
    } catch (e) {}
  }

  function tryJson(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function guessFromRows(rows) {
    if (!rows || !rows.length) return null;
    return rows.length;
  }

  // NYT Wordle — nytimes.com/games/wordle
  function detectNYTWordle() {
    if (!/\/games\/wordle/i.test(path)) return;
    var keys = ["nyt-wordle-state", "nyt-wordle-v2", "wordle-state"];
    for (var i = 0; i < keys.length; i++) {
      var s = tryJson(keys[i]);
      if (!s || !s.status) continue;
      if (s.status === "WIN") {
        var g = (s.currentRowIndex != null ? s.currentRowIndex + 1 : null) || guessFromRows(s.boardState);
        emit({ solved: true, guesses: g, resultType: "guesses", source: "wordle" });
        return;
      }
      if (s.status === "LOSE") {
        emit({ solved: false, source: "wordle" });
        return;
      }
    }
  }

  // Nerdle family — nerdlegame.com, mini.nerdlegame.com, etc.
  function detectNerdle() {
    if (!/nerdlegame\.com$/i.test(host)) return;
    var keys = Object.keys(localStorage);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!/game|stats|state|nerdle/i.test(k)) continue;
      var s = tryJson(k);
      if (!s) continue;
      if (s.gameState === "won" || s.state === "won" || s.status === "WIN") {
        var g = s.guesses || s.attempts || s.currentRow || s.row;
        emit({ solved: true, guesses: g, resultType: "guesses", source: "nerdle" });
        return;
      }
      if (s.gameState === "lost" || s.state === "lost" || s.status === "LOSE") {
        emit({ solved: false, source: "nerdle" });
        return;
      }
    }
    // Fallback: look for a visible score like "3/6" after game ends
    var body = document.body && document.body.innerText;
    if (body && /nerdle/i.test(body)) {
      var m = body.match(/\b(\d)\s*\/\s*6\b/);
      if (m && /won|solved|congrat/i.test(body)) {
        emit({ solved: true, guesses: parseInt(m[1], 10), resultType: "guesses", source: "nerdle" });
      }
    }
  }

  // Worldle — worldle.teuteuf.fr
  function detectWorldle() {
    if (!/teuteuf\.fr$/i.test(host)) return;
    var s = tryJson("worldle") || tryJson("gameState") || tryJson("state");
    if (!s) return;
    if (s.gameOver || s.status === "won" || s.won) {
      var g = s.attempts || s.guessCount || s.guesses;
      emit({ solved: true, guesses: g, resultType: "guesses", source: "worldle" });
      return;
    }
    if (s.status === "lost" || s.lost) {
      emit({ solved: false, source: "worldle" });
    }
  }

  // Waffle — wafflegame.net
  function detectWaffle() {
    if (!/wafflegame\.net$/i.test(host)) return;
    var s = tryJson("waffleState") || tryJson("gameState");
    if (!s) return;
    if (s.status === "WIN" || s.won || s.gameWon) {
      emit({ solved: true, guesses: s.moves || s.guesses, resultType: "guesses", source: "waffle" });
      return;
    }
    if (s.status === "LOSE" || s.lost) {
      emit({ solved: false, source: "waffle" });
    }
  }

  // Quordle — quordle.com
  function detectQuordle() {
    if (!/quordle\.com$/i.test(host)) return;
    var s = tryJson("gameState") || tryJson("quordle-state");
    if (!s) return;
    if (s.isGameOver && s.isWin) {
      emit({ solved: true, guesses: s.currentRow || s.guesses, resultType: "guesses", source: "quordle" });
      return;
    }
    if (s.isGameOver && !s.isWin) {
      emit({ solved: false, source: "quordle" });
    }
  }

  // Octordle — octordle.com
  function detectOctordle() {
    if (!/octordle\.com$/i.test(host)) return;
    var s = tryJson("octordle-state") || tryJson("gameState");
    if (!s) return;
    if (s.gameOver && (s.won || s.isWin)) {
      emit({ solved: true, guesses: s.guesses || s.attempts, resultType: "guesses", source: "octordle" });
      return;
    }
    if (s.gameOver && !s.won && !s.isWin) {
      emit({ solved: false, source: "octordle" });
    }
  }

  // Dordle — zaratustra.itch.io/dordle or dordlegame.com
  function detectDordle() {
    if (!/dordle/i.test(host + path)) return;
    var s = tryJson("gameState") || tryJson("dordle");
    if (!s) return;
    if (s.gameWon || s.won) {
      emit({ solved: true, guesses: s.guesses, resultType: "guesses", source: "dordle" });
    } else if (s.gameOver || s.lost) {
      emit({ solved: false, source: "dordle" });
    }
  }

  // Heardle — heardle.app / heardledecades.com
  function detectHeardle() {
    if (!/heardle/i.test(host)) return;
    var s = tryJson("heardle") || tryJson("state") || tryJson("game");
    if (!s) return;
    if (s.status === "won" || s.gameWon) {
      emit({ solved: true, guesses: s.guesses || s.attempt, resultType: "guesses", source: "heardle" });
    } else if (s.status === "lost" || s.gameOver) {
      emit({ solved: false, source: "heardle" });
    }
  }

  // Generic — any other game. Most daily games keep running stats in localStorage, in
  // shapes like { gamesPlayed, gamesWon, guesses: { 1: 0, 2: 3, ..., fail: 1 } } or
  // { totalGames, gamesFailed, winDistribution: [0, 2, 5, ...] }. Snapshot every such stats
  // object when the page loads; when its "played" counter goes up during this visit, a game
  // just finished — the won/failed counters say how, and whichever distribution bucket grew
  // gives the guess count. Only objects with a played counter AND a won/failed counter or a
  // distribution count, so unrelated counters (e.g. an audio player's "plays") are ignored.
  var KNOWN_HOSTS = /nytimes\.com$|nerdlegame\.com$|teuteuf\.fr$|wafflegame\.net$|quordle\.com$|octordle\.com$|dordle|heardle/i;
  var PLAYED = /^(games?_?played|played|total_?games|total_?played|games_?count|num_?games|plays)$/i;
  var WON = /^(games?_?won|wins?|won|total_?wins|num_?wins|solved)$/i;
  var FAILED = /^(games?_?failed|games?_?lost|losses|lost|fails|failed)$/i;
  var DIST = /^(guesses|win_?distribution|guess_?distribution|distribution|guess_?counts?)$/i;

  // { "<storageKey>|<path>": { played, won, failed, dist } } for every stats-like object.
  function statsSnapshot() {
    var out = {};
    function walk(obj, id, depth) {
      if (!obj || typeof obj !== "object" || depth > 3) return;
      var s = {}, has = false;
      Object.keys(obj).slice(0, 80).forEach(function (k) {
        var v = obj[k];
        if (typeof v === "number") {
          if (PLAYED.test(k)) { s.played = v; has = true; }
          else if (WON.test(k)) s.won = v;
          else if (FAILED.test(k)) s.failed = v;
        } else if (v && typeof v === "object" && DIST.test(k)) {
          var d = {}, n = 0;
          Object.keys(v).slice(0, 30).forEach(function (b) { if (typeof v[b] === "number") { d[b] = v[b]; n++; } });
          if (n) { s.dist = d; s.distZeroBased = Array.isArray(v); }
        } else if (v && typeof v === "object") {
          walk(v, id + "." + k, depth + 1);
        }
      });
      if (has && (s.won != null || s.failed != null || s.dist)) out[id] = s;
    }
    try {
      for (var i = 0; i < localStorage.length && i < 300; i++) {
        var key = localStorage.key(i);
        var raw = localStorage.getItem(key);
        if (!raw || raw.length > 50000 || !/^[\[{]/.test(raw)) continue;
        try { walk(JSON.parse(raw), key, 0); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  // The distribution bucket that grew: "1".."9" -> that many guesses; an array index i ->
  // i + 1 guesses (react-wordle style); "fail"/"X"/"lost" -> a loss.
  function grownBucket(before, after) {
    if (!after) return null;
    var keys = Object.keys(after);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if ((after[k] || 0) > ((before && before[k]) || 0)) return k;
    }
    return null;
  }

  var baseline = null;
  function detectGeneric() {
    if (KNOWN_HOSTS.test(host)) return;
    var now = statsSnapshot();
    if (!baseline) { baseline = now; return; }
    var ids = Object.keys(now);
    for (var i = 0; i < ids.length; i++) {
      var a = now[ids[i]], b = baseline[ids[i]];
      if (!b) {
        // Stats that only appeared after load count as a finished game only if they hold
        // exactly one game (a first-ever play); otherwise they were just loaded late.
        if (a.played !== 1) { baseline[ids[i]] = a; continue; }
        b = { played: 0 };
      }
      if (!(a.played > (b.played || 0))) continue;
      var bucket = grownBucket(b.dist, a.dist);
      var lostBucket = bucket != null && /fail|lost|lose|^x$/i.test(bucket);
      var solved;
      if (a.won != null && a.won > (b.won || 0)) solved = true;
      else if (a.failed != null && a.failed > (b.failed || 0)) solved = false;
      else if (bucket != null) solved = !lostBucket;
      else if (a.won != null) solved = false; // played went up, wins didn't
      else continue; // can't tell how it ended — leave it to the Share hook
      var guesses = null;
      if (solved && bucket != null && !lostBucket) {
        var n = parseInt(bucket, 10);
        if (!isNaN(n)) guesses = a.distZeroBased ? n + 1 : n;
        // Only a guess distribution looks like this: a dozen or fewer numbered slots, all
        // small (1..6 plus "fail"). Score/time histograms ("100", "250", ...) aren't guesses.
        var slots = Object.keys(a.dist).filter(function (k) { return !/fail|lost|lose|^x$/i.test(k); });
        var small = slots.every(function (k) { var v = parseInt(k, 10); return !isNaN(v) && v >= 0 && v <= 12; });
        if (slots.length > 13 || !small || guesses > 12) guesses = null;
      }
      baseline = now; // re-arm for the next round (unlimited modes)
      emit(solved
        ? { solved: true, guesses: guesses, resultType: guesses ? "guesses" : undefined, source: "stats" }
        : { solved: false, source: "stats" });
      return;
    }
  }

  var detectors = [
    detectNYTWordle,
    detectNerdle,
    detectWorldle,
    detectWaffle,
    detectQuordle,
    detectOctordle,
    detectDordle,
    detectHeardle,
    detectGeneric,
  ];

  function run() {
    for (var i = 0; i < detectors.length; i++) {
      try { detectors[i](); } catch (e) {}
    }
  }

  run();
  setInterval(run, 2500);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") run();
  });
})();
