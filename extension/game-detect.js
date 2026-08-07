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

  var detectors = [
    detectNYTWordle,
    detectNerdle,
    detectWorldle,
    detectWaffle,
    detectQuordle,
    detectOctordle,
    detectDordle,
    detectHeardle,
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
