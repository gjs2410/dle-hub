(function () {
  "use strict";

  // ---------- data ----------
  var DATA = (window.GAMES_DATA && window.GAMES_DATA.games) || [];
  var ALL_CATEGORIES = (window.GAMES_DATA && window.GAMES_DATA.categories) || [];

  // Per-category colors (listdle-style color-coded badges).
  var CATEGORY_COLORS = {
    "Words": "#dc2626",
    "Video Games": "#65a30d",
    "Math/Logic": "#4f46e5",
    "Geography": "#16a34a",
    "Movies/TV": "#7c3aed",
    "Miscellaneous": "#64748b",
    "Music": "#0891b2",
    "Trivia": "#db2777",
    "Shapes/Patterns": "#0284c7",
    "Sports": "#ea580c",
    "Estimation": "#059669",
    "Card/Board Games": "#ca8a04",
    "History": "#d97706",
    "Science/Nature": "#0d9488",
    "Colors": "#c026d3",
    "Novelty": "#e11d48",
    "Food": "#9333ea",
    "Vehicles": "#2563eb"
  };
  function colorFor(cat) { return CATEGORY_COLORS[cat] || "#64748b"; }

  if (!DATA.length) {
    document.getElementById("grid").innerHTML =
      '<p style="color:var(--text-dim);padding:40px">Could not load game data. Make sure <code>games.js</code> exists (run <code>node scrape.mjs</code>).</p>';
    return;
  }

  // ---------- per-game overrides (multi-mode games + result types) ----------
  // window.GAMES_OVERRIDES: { [gameId]: { resultType?, modes?: [{id,label,path?,url?,resultType?}] } }
  // Games with `modes` are expanded into one synthetic entry per mode (id "parentId::modeId").
  // These share the parent's URL host, so the existing same-host hub grouping below renders
  // them as a single card with one row per mode — no separate UI path needed.
  (function applyOverrides() {
    var overrides = window.GAMES_OVERRIDES || {};
    var out = [];
    DATA.forEach(function (g) {
      var ov = overrides[g.id];
      if (ov && Array.isArray(ov.modes) && ov.modes.length) {
        var baseType = ov.resultType || "guesses";
        ov.modes.forEach(function (mode) {
          var url = g.url;
          if (mode.path) {
            try { url = new URL(mode.path, g.url).href; } catch (e) {}
          } else if (mode.url) {
            url = mode.url;
          }
          out.push({
            id: g.id + "::" + mode.id,
            // Each mode is now its own standalone card (no hub grouping), so it needs the
            // parent game's name for context — "Classic" alone wouldn't mean anything on its own.
            name: g.name + ": " + mode.label,
            url: url,
            category: g.category,
            description: g.description,
            thumbnail: g.thumbnail,
            unlimited: g.unlimited,
            popularity: g.popularity,
            resultType: mode.resultType || baseType,
          });
        });
      } else {
        g.resultType = (ov && ov.resultType) || "guesses";
        out.push(g);
      }
    });
    DATA = out;
  })();

  // ---------- storage ----------
  var LS = {
    fav: "dlehub:favorites",
    done: "dlehub:done",
    history: "dlehub:history",
    fails: "dlehub:fails",
    guesses: "dlehub:guesses",
    routine: "dlehub:routine",
    theme: "dlehub:theme",
    prefs: "dlehub:prefs",
    pending: "dlehub:pending",
    resultTypes: "dlehub:resultTypes", // legacy: single learned type per game, read once for migration
    activeTypes: "dlehub:activeTypes",
  };
  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  var favorites = new Set(read(LS.fav, []));
  // Custom routine: an ordered list of game ids the user plays daily.
  var routine = read(LS.routine, []);
  if (!Array.isArray(routine)) routine = [];
  var prefs = read(LS.prefs, { category: "all", favOnly: false, completion: "all", sort: "name", askOnReturn: true, view: "list", routineOnly: false });
  if (prefs.askOnReturn === undefined) prefs.askOnReturn = true;
  if (prefs.view === undefined) prefs.view = "list";
  if (prefs.routineOnly === undefined) prefs.routineOnly = false;
  // migrate the old "hide done" boolean into the new 3-way completion filter
  if (prefs.completion === undefined) prefs.completion = prefs.hideDone ? "todo" : "all";

  // Completion history: { "YYYY-MM-DD": [gameId, ...] }. Single source of truth for
  // "done today", and the basis for streaks, the activity heatmap, and per-game stats.
  var history = read(LS.history, null);
  if (!history || typeof history !== "object") {
    history = {};
    // migrate from the old { id: "YYYY-MM-DD" } format if present
    var legacy = read(LS.done, null);
    if (legacy && typeof legacy === "object") {
      Object.keys(legacy).forEach(function (id) {
        var d = legacy[id];
        if (!d) return;
        (history[d] = history[d] || []).push(id);
      });
    }
    write(LS.history, history);
  }

  // Failed attempts: { "YYYY-MM-DD": [gameId, ...] } — played but didn't solve.
  // Kept separate from `history` (wins) so streaks/heatmap logic is unchanged.
  var fails = read(LS.fails, null);
  if (!fails || typeof fails !== "object") fails = {};

  // Guess counts: { "YYYY-MM-DD": { gameId: guesses } } — captured from share text.
  var guesses = read(LS.guesses, null);
  if (!guesses || typeof guesses !== "object") guesses = {};

  // Games you opened today but haven't confirmed finishing yet. Persisted so the
  // "Did you finish?" prompt survives a reload. Reset when the date rolls over.
  var pendingStore = read(LS.pending, { date: "", ids: [] });

  // ---------- date helpers (drives the daily auto-reset) ----------
  function dateStrOf(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function todayStr() { return dateStrOf(new Date()); }
  function parseDate(s) {
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }
  var TODAY = todayStr();

  // Sync bridge: when signed in, sync.js registers window.__dleOnDirty to push
  // changes to the cloud. suppressDirty prevents a pull→apply→push feedback loop.
  var suppressDirty = false;
  function dleDirty() {
    if (!suppressDirty && typeof window.__dleOnDirty === "function") window.__dleOnDirty();
  }
  function saveFavorites() { write(LS.fav, Array.from(favorites)); dleDirty(); }
  function saveRoutine() { write(LS.routine, routine); dleDirty(); }
  function inRoutine(id) { return routine.indexOf(id) !== -1; }
  function toggleRoutine(id) {
    var i = routine.indexOf(id);
    if (i === -1) routine.push(id); else routine.splice(i, 1);
    saveRoutine();
    updateRoutineControls();
  }
  function saveHistory() { write(LS.history, history); dleDirty(); }
  function saveFails() { write(LS.fails, fails); dleDirty(); }
  function isDoneToday(id) {
    return !!history[TODAY] && history[TODAY].indexOf(id) !== -1;
  }
  function isFailedToday(id) {
    return !!fails[TODAY] && fails[TODAY].indexOf(id) !== -1;
  }
  function markDoneToday(id) {
    clearFailToday(id); // a win overrides a recorded loss for the day
    var arr = history[TODAY] || (history[TODAY] = []);
    if (arr.indexOf(id) === -1) { arr.push(id); saveHistory(); }
  }
  function unmarkDoneToday(id) {
    var arr = history[TODAY];
    if (!arr) return;
    var i = arr.indexOf(id);
    if (i !== -1) {
      arr.splice(i, 1);
      if (!arr.length) delete history[TODAY];
      saveHistory();
    }
  }
  function markFailedToday(id) {
    unmarkDoneToday(id); // a loss overrides a recorded win for the day
    var arr = fails[TODAY] || (fails[TODAY] = []);
    if (arr.indexOf(id) === -1) { arr.push(id); saveFails(); }
  }
  function clearFailToday(id) {
    var arr = fails[TODAY];
    if (!arr) return;
    var i = arr.indexOf(id);
    if (i !== -1) {
      arr.splice(i, 1);
      if (!arr.length) delete fails[TODAY];
      saveFails();
    }
  }
  function saveGuesses() { write(LS.guesses, guesses); dleDirty(); }
  // Each day's entry per game is an object keyed by value type, e.g. { guesses: 4, score: 1250 } —
  // a game can track more than one measurement at once. "correct" values are { n, m } pairs.
  function setValueToday(id, type, val) {
    if (val == null) return;
    if (type === "correct") {
      if (!(val.m > 0) || !(val.n >= 0) || val.n > val.m) return;
    } else if (!(val > 0)) {
      return;
    }
    var day = guesses[TODAY] || (guesses[TODAY] = {});
    var entry = day[id] || (day[id] = {});
    entry[type] = val;
    saveGuesses();
  }
  function valueToday(id, type) {
    var entry = guesses[TODAY] && guesses[TODAY][id];
    return entry ? entry[type] : undefined;
  }
  function gameAvgValue(id, type) {
    var sum = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      var v = guesses[k][id] && guesses[k][id][type];
      if (v != null) { sum += v; n++; }
    });
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }
  // Average for "correct" (N/M) games — averages n and m separately since m can vary.
  function gameAvgCorrect(id) {
    var sumN = 0, sumM = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      var v = guesses[k][id] && guesses[k][id].correct;
      if (v && v.m > 0) { sumN += v.n; sumM += v.m; n++; }
    });
    if (!n) return null;
    return { n: Math.round((sumN / n) * 10) / 10, m: Math.round((sumM / n) * 10) / 10 };
  }
  // Global average for one value type, across every game that has ever recorded it —
  // values are stored under their own type key, so no per-game type-matching needed here.
  function overallAvgByType(type) {
    var sum = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      Object.keys(guesses[k]).forEach(function (id) {
        var v = guesses[k][id][type];
        if (v != null) { sum += v; n++; }
      });
    });
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }
  // Distribution of guess-count solves: buckets 1..6 and "7+".
  function guessDistribution() {
    var dist = {}, max = 0, total = 0;
    Object.keys(guesses).forEach(function (date) {
      var day = guesses[date];
      Object.keys(day).forEach(function (id) {
        var n = day[id].guesses;
        if (!(n >= 1)) return;
        var b = n >= 7 ? 7 : n;
        dist[b] = (dist[b] || 0) + 1;
        total++;
        if (dist[b] > max) max = dist[b];
      });
    });
    return { dist: dist, max: max, total: total };
  }
  // Average accuracy (%) across every recorded "correct" (N/M) value.
  function overallAccuracy() {
    var sumRatio = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      Object.keys(guesses[k]).forEach(function (id) {
        var v = guesses[k][id].correct;
        if (v && v.m > 0) { sumRatio += v.n / v.m; n++; }
      });
    });
    return n ? Math.round((sumRatio / n) * 1000) / 10 : null;
  }

  // ---------- result types (which measurements a game tracks) ----------
  // A game can track any combination of these at once (e.g. both "guesses" and "score").
  var ALL_TYPES = ["guesses", "score", "time", "correct", "hints"];
  var TYPE_LABELS = { guesses: "Guesses", score: "Score", time: "Time", correct: "Accuracy", hints: "Hints" };
  // Static default comes from the game's own `resultType` (set from overrides.json), a single
  // type ("winloss" meaning none). The user can override this per game (manualTypes, possibly
  // more than one type, or none at all) — that always wins once set, even to an empty list.
  var manualTypes = read(LS.activeTypes, {});
  function saveManualTypes() { write(LS.activeTypes, manualTypes); dleDirty(); }
  function defaultTypesOf(g) {
    if (!g || !g.resultType || g.resultType === "winloss") return [];
    return [g.resultType];
  }
  function activeTypesOf(g) {
    if (!g) return ["guesses"];
    if (Object.prototype.hasOwnProperty.call(manualTypes, g.id)) return manualTypes[g.id];
    return defaultTypesOf(g);
  }
  function setActiveTypes(id, types) {
    manualTypes[id] = types.slice();
    saveManualTypes();
  }
  // Auto-add a type the first time a paste/extension result clearly implies it, so a game
  // starts tracking whatever it's actually shown to produce without the user having to
  // find the toggle first (they still can, to add/remove types manually at any time).
  function ensureTypeActive(id, type) {
    if (!type || ALL_TYPES.indexOf(type) === -1) return;
    var current = activeTypesOf(gameById[id]);
    if (current.indexOf(type) !== -1) return;
    setActiveTypes(id, current.concat([type]));
  }
  function formatResultValue(rt, v) {
    if (v == null) return "";
    if (rt === "time") {
      var s = Math.max(0, Math.round(v));
      var m = Math.floor(s / 60), r = s % 60;
      return m + ":" + (r < 10 ? "0" : "") + r;
    }
    if (rt === "correct" && v && typeof v === "object") return v.n + "/" + v.m;
    return String(v);
  }
  function parseResultValueInput(rt, str) {
    str = String(str || "").trim();
    if (!str) return null;
    if (rt === "time") {
      var m = str.match(/^(\d+):(\d{1,2})$/);
      if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      return null;
    }
    if (rt === "correct") {
      var cm = str.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
      if (!cm) return null;
      var n = parseInt(cm[1], 10), tot = parseInt(cm[2], 10);
      return tot > 0 && n >= 0 && n <= tot ? { n: n, m: tot } : null;
    }
    var n2 = parseFloat(str);
    return isFinite(n2) ? Math.round(n2) : null;
  }
  function describeResultValue(rt, v) {
    if (v == null) return "";
    if (rt === "time") return "in " + formatResultValue("time", v);
    if (rt === "score") return "scoring " + v;
    if (rt === "correct") return "with " + formatResultValue("correct", v) + " correct";
    if (rt === "hints") return "using " + v + " hint" + (v === 1 ? "" : "s");
    return "in " + v;
  }
  // ---------- streak & stats computation ----------
  function completedDaySet() {
    var s = {};
    Object.keys(history).forEach(function (k) {
      if (history[k] && history[k].length) s[k] = true;
    });
    return s;
  }
  function currentStreak() {
    var days = completedDaySet();
    var d = new Date();
    // if today has no completion yet, the streak is still alive from yesterday
    if (!days[dateStrOf(d)]) d = addDays(d, -1);
    var n = 0;
    while (days[dateStrOf(d)]) { n++; d = addDays(d, -1); }
    return n;
  }
  function longestStreak() {
    var keys = Object.keys(completedDaySet()).sort();
    var best = 0, cur = 0, prev = null;
    keys.forEach(function (k) {
      if (prev && dateStrOf(addDays(parseDate(prev), 1)) === k) cur++;
      else cur = 1;
      if (cur > best) best = cur;
      prev = k;
    });
    return best;
  }
  function gameStreak(id) {
    var d = new Date();
    if ((history[dateStrOf(d)] || []).indexOf(id) === -1) d = addDays(d, -1);
    var n = 0;
    while ((history[dateStrOf(d)] || []).indexOf(id) !== -1) { n++; d = addDays(d, -1); }
    return n;
  }
  function gameLastPlayed(id) {
    var last = null;
    Object.keys(history).forEach(function (k) {
      if (history[k].indexOf(id) !== -1 && (!last || k > last)) last = k;
    });
    return last;
  }
  function gameLongestStreak(id) {
    var days = Object.keys(history).filter(function (k) { return history[k].indexOf(id) !== -1; }).sort();
    var best = 0, cur = 0, prev = null;
    days.forEach(function (k) {
      if (prev && dateStrOf(addDays(parseDate(prev), 1)) === k) cur++;
      else cur = 1;
      if (cur > best) best = cur;
      prev = k;
    });
    return best;
  }
  function gameTimesPlayed(id) {
    var n = 0;
    Object.keys(history).forEach(function (k) { if (history[k].indexOf(id) !== -1) n++; });
    return n;
  }
  function totalCompletions() {
    return Object.keys(history).reduce(function (n, k) { return n + history[k].length; }, 0);
  }
  function gameLosses(id) {
    var n = 0;
    Object.keys(fails).forEach(function (k) { if (fails[k].indexOf(id) !== -1) n++; });
    return n;
  }
  function totalFails() {
    return Object.keys(fails).reduce(function (n, k) { return n + fails[k].length; }, 0);
  }
  function winRate(wins, losses) {
    var t = wins + losses;
    return t ? Math.round((wins / t) * 100) : 0;
  }

  // ---------- "did you finish?" pending queue ----------
  if (pendingStore.date !== TODAY) pendingStore = { date: TODAY, ids: [] };

  function savePending() { write(LS.pending, pendingStore); }
  function addPending(id) {
    if (isDoneToday(id)) return; // already marked done, nothing to ask
    if (pendingStore.ids.indexOf(id) === -1) {
      pendingStore.ids.push(id);
      savePending();
    }
  }
  function removePending(id) {
    var i = pendingStore.ids.indexOf(id);
    if (i !== -1) { pendingStore.ids.splice(i, 1); savePending(); }
  }

  // ---------- misc helpers ----------
  function hostOf(url) {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }
  function faviconUrl(url) {
    var h = hostOf(url);
    return h ? "https://www.google.com/s2/favicons?domain=" + h + "&sz=64" : "";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- DOM refs ----------
  var $ = function (id) { return document.getElementById(id); };
  var grid = $("grid");
  var searchEl = $("search");
  var clearSearchBtn = $("clearSearch");
  var favFilterBtn = $("favFilter");
  var routineFilterBtn = $("routineFilter");
  var playRoutineBtn = $("playRoutine");
  var statusEl = $("statusFilter");
  var sortEl = $("sort");
  var chipsEl = $("categoryChips");
  var statsEl = $("stats");
  var emptyEl = $("emptyState");
  var footerCountEl = $("footerCount");

  var searchTerm = "";

  // ---------- theme ----------
  // Keeps the browser chrome / PWA status bar color matching the actual page background —
  // Android reads the <meta name="theme-color"> tag directly (installed PWA and browser tab),
  // and it has to be updated by hand because the theme can be forced to light/dark, not just
  // follow the OS (a static prefers-color-scheme media query wouldn't reflect that override).
  var darkMedia = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function syncThemeColor() {
    var theme = document.documentElement.getAttribute("data-theme");
    var dark = theme === "dark" || (theme === "auto" && darkMedia && darkMedia.matches);
    var meta = $("themeColorMeta");
    if (meta) meta.setAttribute("content", dark ? "#1f1f23" : "#ffffff");
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    var order = ["auto", "light", "dark"];
    var next = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.setAttribute("data-theme", next);
    write(LS.theme, next);
    var title = "Theme: " + next + " (click to change)";
    $("themeToggle").title = title;
    $("pageTheme").title = title;
    syncThemeColor();
  }
  (function initTheme() {
    var saved = read(LS.theme, "auto");
    document.documentElement.setAttribute("data-theme", saved);
    $("themeToggle").addEventListener("click", toggleTheme);
    $("pageTheme").addEventListener("click", toggleTheme);
    syncThemeColor();
    if (darkMedia && darkMedia.addEventListener) darkMedia.addEventListener("change", syncThemeColor);
  })();

  // ---------- category chips ----------
  function buildChips() {
    var counts = {};
    DATA.forEach(function (g) { counts[g.category] = (counts[g.category] || 0) + 1; });
    var frag = document.createDocumentFragment();

    function applyChipColor(b, value) {
      var active = prefs.category === value;
      if (active && value !== "all") {
        b.style.background = colorFor(value);
        b.style.color = "#fff";
      } else if (active) {
        // "All" chip active: neutral dark fill
        b.style.background = "var(--text)";
        b.style.color = "var(--bg)";
      } else {
        b.style.background = "";
        b.style.color = "";
      }
    }
    function chip(label, value, count) {
      var b = document.createElement("button");
      b.className = "chip" + (prefs.category === value ? " active" : "");
      b.dataset.cat = value;
      var dot =
        value === "all"
          ? ""
          : '<span class="dot" style="background:' + colorFor(value) + '"></span>';
      b.innerHTML = dot + escapeHtml(label) + ' <span class="count">' + count + "</span>";
      applyChipColor(b, value);
      b.addEventListener("click", function () {
        prefs.category = value;
        savePrefs();
        Array.prototype.forEach.call(chipsEl.children, function (c) {
          c.classList.toggle("active", c.dataset.cat === value);
          applyChipColor(c, c.dataset.cat);
        });
        render();
      });
      return b;
    }

    frag.appendChild(chip("All", "all", DATA.length));
    ALL_CATEGORIES.forEach(function (cat) {
      frag.appendChild(chip(cat, cat, counts[cat] || 0));
    });
    chipsEl.innerHTML = "";
    chipsEl.appendChild(frag);
  }

  // ---------- flat item list: every game (incl. each multi-mode entry) is its own card ----------
  var ITEMS = [];        // what the grid iterates: every game, one card each
  var itemById = {};     // grid-item id -> game
  var gameById = {};     // every game id -> game
  var gamesByHost = {};  // host -> [games] (for extension result matching)

  (function buildItems() {
    DATA.forEach(function (g) {
      gameById[g.id] = g;
      itemById[g.id] = g;
      ITEMS.push(g);
      var h = hostOf(g.url);
      (gamesByHost[h] = gamesByHost[h] || []).push(g);
    });
  })();

  // One-time migration: each day's recorded value used to be a single number (or, for the
  // "correct" type, a bare { n, m } pair) with the type inferred from the game's one-and-only
  // resultType. Now that a game can track several types at once, values live under their type's
  // key instead — recover the type each old value was actually recorded under (its per-game
  // learned override if it had one, else its static default) so history isn't misattributed.
  (function migrateGuessesShape() {
    var legacyLearned = read(LS.resultTypes, {});
    var changed = false;
    Object.keys(guesses).forEach(function (date) {
      var day = guesses[date];
      Object.keys(day).forEach(function (id) {
        var v = day[id];
        if (v == null) return;
        if (v && typeof v === "object" && "n" in v && "m" in v) {
          day[id] = { correct: v };
          changed = true;
        } else if (typeof v !== "object") {
          var g = gameById[id];
          var oldType = legacyLearned[id] || (g && g.resultType) || "guesses";
          if (oldType === "winloss") oldType = "guesses";
          var obj = {};
          obj[oldType] = v;
          day[id] = obj;
          changed = true;
        }
        // else: already { type: value, ... } shaped — nothing to do.
      });
    });
    if (changed) saveGuesses();

    // Carry forward any single learned type as that game's initial active-type set, so a
    // game that had already learned e.g. "score" keeps showing it now that a game's active
    // types live in their own storage (dlehub:activeTypes) instead of alongside resultType.
    var existingActive = read(LS.activeTypes, {});
    var activeChanged = false;
    Object.keys(legacyLearned).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(existingActive, id)) return;
      var t = legacyLearned[id];
      if (t && t !== "winloss" && ["guesses", "score", "time", "correct"].indexOf(t) !== -1) {
        existingActive[id] = [t];
        activeChanged = true;
      }
    });
    if (activeChanged) write(LS.activeTypes, existingActive);
  })();

  // thin predicates kept as named functions since they're used from several places (filtering,
  // sorting) — no longer branch on "hub vs game" now that every item is a plain game.
  function itemPopularity(it) { return it.popularity || 0; }
  function itemFavorited(it) { return favorites.has(it.id); }
  function itemInRoutine(it) { return inRoutine(it.id); }
  function itemAllDone(it) { return isDoneToday(it.id); }
  function itemDoneCount(it) { return isDoneToday(it.id) ? 1 : 0; }
  function itemMatchesCat(it, cat) { return cat === "all" || it.category === cat; }
  function itemHay(it) { return (it.name + " " + it.description + " " + it.category).toLowerCase(); }

  // ---------- filtering + sorting ----------
  function getFiltered() {
    var term = searchTerm.trim().toLowerCase();
    var list = ITEMS.filter(function (it) {
      if (!itemMatchesCat(it, prefs.category)) return false;
      if (prefs.favOnly && !itemFavorited(it)) return false;
      if (prefs.routineOnly && !itemInRoutine(it)) return false;
      if (prefs.completion === "todo" && itemAllDone(it)) return false;
      if (prefs.completion === "done" && !itemAllDone(it)) return false;
      if (term && itemHay(it).indexOf(term) === -1) return false;
      return true;
    });
    var byName = function (a, b) { return a.name.localeCompare(b.name); };
    if (prefs.sort === "category") {
      list.sort(function (a, b) { return a.category.localeCompare(b.category) || byName(a, b); });
    } else if (prefs.sort === "fav") {
      list.sort(function (a, b) { return (itemFavorited(a) ? 0 : 1) - (itemFavorited(b) ? 0 : 1) || byName(a, b); });
    } else if (prefs.sort === "popular") {
      list.sort(function (a, b) { return itemPopularity(b) - itemPopularity(a) || byName(a, b); });
    } else {
      list.sort(byName);
    }
    return list;
  }

  // ---------- card ----------
  function cardHtml(it) {
    return gameCardHtml(it);
  }

  function gameCardHtml(g) {
    var fav = favorites.has(g.id);
    var done = isDoneToday(g.id);
    var failed = isFailedToday(g.id);
    var col = colorFor(g.category);
    var fIco = faviconUrl(g.url);
    var letter = escapeHtml((g.name[0] || "?").toUpperCase());
    var fallback =
      '<span class=&quot;favicon-fallback&quot; style=&quot;background:' + col + '&quot;>' + letter + "</span>";
    var icon = fIco
      ? '<img class="favicon" src="' + fIco + '" alt="" loading="lazy" onerror="this.outerHTML=\'' + fallback + '\'">'
      : '<span class="favicon-fallback" style="background:' + col + '">' + letter + "</span>";

    var desc = g.description
      ? '<p class="card-desc">' + escapeHtml(g.description) + "</p>"
      : '<p class="card-desc empty">A daily ' + escapeHtml(g.category.toLowerCase()) + " puzzle.</p>";

    var gs = gameStreak(g.id);
    var flame = gs >= 1
      ? '<span class="streak-pill" title="' + gs + '-day streak for this game">🔥 ' + gs + "</span>"
      : "";

    var thumbStyle = g.thumbnail
      ? "background-color:" + col + ";background-image:url('" + encodeURI(g.thumbnail) + "')"
      : "background-color:" + col;

    return (
      '<article class="card' + (done ? " is-done" : "") + (failed ? " is-failed" : "") + '" data-id="' + g.id + '" data-url="' + escapeHtml(g.url) + '" tabindex="0" role="link" aria-label="Play ' + escapeHtml(g.name) + '">' +
        '<div class="card-thumb" style="' + thumbStyle + '" aria-hidden="true"></div>' +
        '<div class="card-body">' +
          '<div class="card-line">' +
            icon +
            '<span class="card-title">' + escapeHtml(g.name) + "</span>" +
            '<span class="card-badge" style="background:' + col + '">' + escapeHtml(g.category) + "</span>" +
          "</div>" +
          desc +
        "</div>" +
        '<div class="card-acts">' +
          '<button class="info-btn" data-act="info" title="Details" aria-label="Details about ' + escapeHtml(g.name) + '">ⓘ</button>' +
          '<button class="star-btn' + (fav ? " active" : "") + '" data-act="fav" title="' + (fav ? "Remove favorite" : "Add favorite") + '" aria-pressed="' + fav + '">' + (fav ? "★" : "☆") + "</button>" +
          flame +
          '<button class="fail-btn' + (failed ? " active" : "") + '" data-act="fail" title="Mark as failed today" aria-pressed="' + failed + '">' + (failed ? "✗ Failed" : "✗") + "</button>" +
          '<button class="done-btn' + (done ? " active" : "") + '" data-act="done" title="Mark as solved today">' + (done ? "✓ Solved" : "Solved") + "</button>" +
        "</div>" +
      "</article>"
    );
  }

  function groupHead(cat, count) {
    return (
      '<h2 class="group-head"><span class="group-dot" style="background:' + colorFor(cat) + '"></span>' +
      escapeHtml(cat) +
      ' <span class="group-count">' + count + "</span></h2>"
    );
  }

  // ---------- incremental (lazy) rendering ----------
  var PAGE = 60;
  var currentList = [];
  var renderedCount = 0;
  var lastRenderedCat = null;
  var catCounts = null;

  function buildChunk(start, end) {
    var html = "";
    for (var i = start; i < end; i++) {
      var g = currentList[i];
      if (prefs.sort === "category" && g.category !== lastRenderedCat) {
        lastRenderedCat = g.category;
        html += groupHead(g.category, catCounts[g.category]);
      }
      html += cardHtml(g);
    }
    return html;
  }

  function updateSentinel() {
    var s = document.getElementById("scrollSentinel");
    if (s) s.hidden = renderedCount >= currentList.length;
  }

  function appendMore() {
    if (renderedCount >= currentList.length) return;
    var end = Math.min(renderedCount + PAGE, currentList.length);
    grid.insertAdjacentHTML("beforeend", buildChunk(renderedCount, end));
    renderedCount = end;
    updateSentinel();
  }

  function render() {
    currentList = getFiltered();
    lastRenderedCat = null;
    renderedCount = 0;
    catCounts = null;
    if (prefs.sort === "category") {
      catCounts = {};
      currentList.forEach(function (g) { catCounts[g.category] = (catCounts[g.category] || 0) + 1; });
    }
    if (!currentList.length) {
      grid.innerHTML = "";
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      var end = Math.min(PAGE, currentList.length);
      grid.innerHTML = buildChunk(0, end);
      renderedCount = end;
    }
    window.scrollTo(0, 0); // new list → back to top
    updateSentinel();
    updateStats(currentList.length);
  }

  function ringHtml(done, total) {
    var r = 9, c = 2 * Math.PI * r;
    var frac = total > 0 ? done / total : 0;
    var off = c * (1 - frac);
    return (
      '<svg class="ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="' + r + '" class="ring-bg"></circle>' +
        '<circle cx="12" cy="12" r="' + r + '" class="ring-fg" ' +
          'stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"></circle>' +
      "</svg>"
    );
  }

  function updateStats(shown) {
    var doneToday = history[TODAY] ? history[TODAY].length : 0; // O(1) instead of scanning all games
    var favCount = favorites.size;
    var favDone = 0;
    favorites.forEach(function (id) { if (isDoneToday(id)) favDone++; });
    var streak = currentStreak();

    var parts = [];
    if (streak > 0) {
      parts.push('<button class="stat streak" id="openStatsFromStreak" title="View your stats">🔥 <b>' + streak + "</b> day" + (streak === 1 ? "" : "s") + "</button>");
    }
    if (favCount > 0) {
      parts.push('<span class="stat progress">' + ringHtml(favDone, favCount) + "<span><b>" + favDone + " / " + favCount + "</b> favorites done</span></span>");
    } else if (doneToday > 0) {
      parts.push('<span class="stat progress">✓ <b>' + doneToday + "</b> done today</span>");
    }
    parts.push('<span class="stat">🎮 <b>' + DATA.length + "</b> games</span>");
    parts.push('<span class="stat">★ <b>' + favCount + "</b> favorites</span>");
    statsEl.innerHTML = parts.join("");
    var sBtn = $("openStatsFromStreak");
    if (sBtn) sBtn.addEventListener("click", openStats);
    footerCountEl.textContent = "Showing " + shown + " of " + DATA.length + " games";
  }

  // ---------- stats modal ----------
  var statsModal = null;

  function heatmapHtml() {
    var weeks = 18;
    var today = new Date();
    var sundayThisWeek = addDays(today, -today.getDay());
    var firstSunday = addDays(sundayThisWeek, -(weeks - 1) * 7);
    var cells = "";
    for (var col = 0; col < weeks; col++) {
      cells += '<div class="hm-col">';
      for (var row = 0; row < 7; row++) {
        var d = addDays(firstSunday, col * 7 + row);
        if (d > today) { cells += '<div class="hm-cell hm-future"></div>'; continue; }
        var key = dateStrOf(d);
        var n = (history[key] || []).length;
        var lvl = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4;
        cells += '<div class="hm-cell hm-l' + lvl + '" title="' + key + ": " + n + ' game' + (n === 1 ? "" : "s") + '"></div>';
      }
      cells += "</div>";
    }
    return (
      '<div class="heatmap">' + cells + "</div>" +
      '<div class="hm-legend">Less ' +
        '<span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span>' +
        '<span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span>' +
        '<span class="hm-cell hm-l4"></span> More</div>'
    );
  }

  function topGamesHtml() {
    var counts = {};
    Object.keys(history).forEach(function (k) {
      history[k].forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    });
    var rows = Object.keys(counts)
      .map(function (id) { return { id: id, n: counts[id] }; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 5);
    if (!rows.length) return '<p class="stats-empty">No games completed yet — play one and mark it done to start your streak. 🔥</p>';
    return (
      '<ul class="top-games">' +
      rows.map(function (r) {
        var g = DATA.find(function (x) { return x.id === r.id; });
        var name = g ? g.name : r.id;
        var col = g ? colorFor(g.category) : "#64748b";
        return '<li><span class="tg-dot" style="background:' + col + '"></span>' +
          '<span class="tg-name">' + escapeHtml(name) + "</span>" +
          '<span class="tg-count">' + r.n + "×</span></li>";
      }).join("") +
      "</ul>"
    );
  }

  function renderStats() {
    var distinct = {};
    Object.keys(history).forEach(function (k) { history[k].forEach(function (id) { distinct[id] = 1; }); });
    var body = statsModal.querySelector(".stats-body");
    var solved = totalCompletions(), failed = totalFails();
    var tiles =
      '<div class="stats-tile"><span class="st-big">🔥 ' + currentStreak() + '</span><span class="st-label">Current streak</span></div>' +
      '<div class="stats-tile"><span class="st-big">🏆 ' + longestStreak() + '</span><span class="st-label">Longest streak</span></div>' +
      '<div class="stats-tile"><span class="st-big">' + solved + '</span><span class="st-label">Solved</span></div>' +
      '<div class="stats-tile"><span class="st-big">' + failed + '</span><span class="st-label">Failed</span></div>' +
      '<div class="stats-tile"><span class="st-big">' + (solved + failed ? winRate(solved, failed) + "%" : "–") + '</span><span class="st-label">Win rate</span></div>' +
      '<div class="stats-tile"><span class="st-big">' + (overallAvgByType("guesses") != null ? overallAvgByType("guesses") : "–") + '</span><span class="st-label">Avg guesses</span></div>' +
      '<div class="stats-tile"><span class="st-big">' + Object.keys(distinct).length + '</span><span class="st-label">Games played</span></div>';
    // Score/time/accuracy games are a different unit from guesses, so they only show up
    // here — as their own tiles — when there's actually data for them, rather than
    // padding the guess-count average/distribution above.
    var avgScore = overallAvgByType("score");
    if (avgScore != null) {
      tiles += '<div class="stats-tile"><span class="st-big">' + avgScore + '</span><span class="st-label">Avg score</span></div>';
    }
    var avgTime = overallAvgByType("time");
    if (avgTime != null) {
      tiles += '<div class="stats-tile"><span class="st-big">' + formatResultValue("time", avgTime) + '</span><span class="st-label">Avg time</span></div>';
    }
    var accuracy = overallAccuracy();
    if (accuracy != null) {
      tiles += '<div class="stats-tile"><span class="st-big">' + accuracy + '%</span><span class="st-label">Accuracy</span></div>';
    }
    var avgHints = overallAvgByType("hints");
    if (avgHints != null) {
      tiles += '<div class="stats-tile"><span class="st-big">' + avgHints + '</span><span class="st-label">Avg hints</span></div>';
    }
    body.innerHTML =
      '<div class="stats-tiles">' + tiles + "</div>" +
      '<h3 class="stats-h">Guess distribution</h3>' + guessDistHtml() +
      '<h3 class="stats-h">Activity</h3>' + heatmapHtml() +
      '<h3 class="stats-h">Most played</h3>' + topGamesHtml();
  }

  function distBarsHtml(d, title) {
    var rows = "";
    for (var i = 1; i <= 7; i++) {
      var c = d.dist[i] || 0;
      var pct = d.max ? Math.round((c / d.max) * 100) : 0;
      rows +=
        '<div class="gd-row"><span class="gd-num">' + (i === 7 ? "7+" : i) + "</span>" +
        '<div class="gd-track"><div class="gd-bar' + (c ? "" : " gd-empty") + '" style="width:' + (c ? Math.max(pct, 12) : 0) + '%">' + c + "</div></div></div>";
    }
    return '<div class="guess-dist"' + (title ? ' title="' + title + '"' : "") + ">" + rows + "</div>";
  }
  function guessDistHtml() {
    var d = guessDistribution();
    if (!d.total) {
      return '<p class="stats-empty">No guess data yet — install the extension and share a game, or it fills in as guesses are recorded.</p>';
    }
    return distBarsHtml(d, d.total + " solves with a recorded guess count");
  }
  function gameGuessDistribution(id) {
    var dist = {}, max = 0, total = 0;
    Object.keys(guesses).forEach(function (date) {
      var n = guesses[date][id] && guesses[date][id].guesses;
      if (!(n >= 1)) return;
      var b = n >= 7 ? 7 : n;
      dist[b] = (dist[b] || 0) + 1;
      total++;
      if (dist[b] > max) max = dist[b];
    });
    return { dist: dist, max: max, total: total };
  }
  // Every recorded score for one game, newest first — backs the "Score" tab.
  function gameScoreHistory(id) {
    var rows = [];
    Object.keys(guesses).forEach(function (date) {
      var v = guesses[date][id] && guesses[date][id].score;
      if (v != null) rows.push({ date: date, value: v });
    });
    rows.sort(function (a, b) { return b.date.localeCompare(a.date); });
    return rows;
  }
  function scoreHistoryHtml(id) {
    var rows = gameScoreHistory(id);
    if (!rows.length) {
      return '<p class="stats-empty">No scores recorded yet — captured automatically when you share this game (or add one below).</p>';
    }
    var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0) || 1;
    return (
      '<div class="score-history">' +
      rows.map(function (r) {
        var pct = Math.max(Math.round((r.value / max) * 100), 10);
        return '<div class="sh-row"><span class="sh-date">' + escapeHtml(r.date) + "</span>" +
          '<div class="sh-track"><div class="sh-bar" style="width:' + pct + '%">' + escapeHtml(String(r.value)) + "</div></div></div>";
      }).join("") +
      "</div>"
    );
  }

  function openStats() {
    if (!statsModal) {
      statsModal = document.createElement("div");
      statsModal.className = "modal-overlay";
      statsModal.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Your stats">' +
          '<div class="modal-head"><h2>Your stats</h2><button class="modal-close" aria-label="Close">✕</button></div>' +
          '<div class="stats-body"></div>' +
        "</div>";
      document.body.appendChild(statsModal);
      statsModal.addEventListener("click", function (e) {
        if (e.target === statsModal || e.target.closest(".modal-close")) closeStats();
      });
    }
    renderStats();
    statsModal.classList.add("show");
    document.addEventListener("keydown", escClose);
  }
  function closeStats() {
    if (statsModal) statsModal.classList.remove("show");
    document.removeEventListener("keydown", escClose);
  }
  function escClose(e) { if (e.key === "Escape") closeStats(); }

  // ---------- generic modal (used by settings + stats-like popups) ----------
  var genericModal = null, genericEsc = null;

  function showModal(title, bodyHtml) {
    if (!genericModal) {
      genericModal = document.createElement("div");
      genericModal.className = "modal-overlay";
      genericModal.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<div class="modal-head"><h2></h2><button class="modal-close" aria-label="Close">✕</button></div>' +
          '<div class="modal-body"></div>' +
        "</div>";
      document.body.appendChild(genericModal);
      genericModal.addEventListener("click", onModalClick);
      genericModal.addEventListener("change", onModalChange);
      genericModal.addEventListener("input", function (e) {
        if (e.target && e.target.id === "pasteBox") populateFromPaste(e.target.value);
      });
    }
    genericModal.querySelector(".modal-head h2").textContent = title;
    genericModal.querySelector(".modal-body").innerHTML = bodyHtml;
    genericModal.classList.add("show");
    if (genericEsc) document.removeEventListener("keydown", genericEsc);
    genericEsc = function (e) { if (e.key === "Escape") hideModal(); };
    document.addEventListener("keydown", genericEsc);
  }
  function hideModal() {
    if (genericModal) genericModal.classList.remove("show");
    if (genericEsc) { document.removeEventListener("keydown", genericEsc); genericEsc = null; }
  }
  function modalBody() { return genericModal.querySelector(".modal-body"); }

  // Click/change handling shared between the settings/paste modal and the game/hub page view.
  function onContentClick(e) {
    var rel = e.target.closest("[data-related-id]");
    if (rel) { openDetail(rel.dataset.relatedId); return; }
    var d = e.target.closest("[data-detail-act]");
    if (d && currentDetailId) { handleDetailAct(d.dataset.detailAct); return; }
    var tab = e.target.closest("[data-tab]");
    if (tab && currentDetailId) { currentDetailTab = tab.dataset.tab; refreshDetail(); return; }
    var tt = e.target.closest("[data-type-toggle]");
    if (tt && currentDetailId) {
      var type = tt.dataset.typeToggle;
      var active = activeTypesOf(gameById[currentDetailId]).slice();
      var idx = active.indexOf(type);
      if (idx === -1) active.push(type); else active.splice(idx, 1);
      setActiveTypes(currentDetailId, active);
      refreshDetail();
      return;
    }
    var s = e.target.closest("[data-set-act]");
    if (s) { handleSetAct(s.dataset.setAct); return; }
    var res = e.target.closest("[data-res]");
    if (res) { setResSelection(res.dataset.res); return; }
    if (e.target.closest("[data-record]")) { handleRecord(); return; }
  }
  function onModalClick(e) {
    if (e.target === genericModal || e.target.closest(".modal-close")) { hideModal(); return; }
    onContentClick(e);
  }
  function onModalChange(e) {
    if (e.target.id === "importFile" && e.target.files && e.target.files[0]) {
      importFromFile(e.target.files[0]);
    }
  }
  function onPasteInput(e) {
    if (e.target && e.target.id === "pasteBox") populateFromPaste(e.target.value);
  }

  // ---------- page view (game detail as a real, deep-linkable page) ----------
  // The URL hash drives what's shown: #g=<gameId> (every game, including each mode of a
  // multi-mode game, has its own). Bookmarkable/shareable, and the browser's own
  // back/forward buttons work with it.
  var currentDetailId = null;
  var currentDetailTab = "overview"; // "overview" | "score" — reset whenever a new game page opens
  var pageBodyEl = null, pageTitleEl = null;

  function parseRoute() {
    var g = location.hash.match(/[#&]g=([^&]+)/);
    return g ? { type: "game", id: decodeURIComponent(g[1]) } : { type: "grid" };
  }
  function navigateTo(hashValue) {
    if (hashValue) {
      if (location.hash.replace(/^#/, "") === hashValue) { applyRoute(); return; }
      location.hash = hashValue;
    } else {
      if (!location.hash) { applyRoute(); return; }
      window.history.pushState(null, "", location.pathname + location.search);
      applyRoute();
    }
  }
  function applyRoute() {
    var r = parseRoute();
    if (r.type === "game") renderGamePage(r.id);
    else hidePage();
  }
  // Remembers where the grid was scrolled to before opening a game page, so returning to
  // it lands back on the game you came from instead of wherever the detail page's own
  // scroll happened to end up. Only captured when the grid is the thing being left (not
  // when hopping from one game page to another via "related games") so a chain of those
  // still returns to the original spot in the grid.
  var savedGridScroll = 0;
  function showPage(title, bodyHtml) {
    if (!pageBodyEl) {
      pageBodyEl = $("pageBody");
      pageTitleEl = $("pageTitle");
      pageBodyEl.addEventListener("click", onContentClick);
      pageBodyEl.addEventListener("change", onModalChange);
      pageBodyEl.addEventListener("input", onPasteInput);
    }
    if (!$("mainGrid").hidden) savedGridScroll = window.scrollY;
    pageTitleEl.textContent = title;
    pageBodyEl.innerHTML = bodyHtml;
    document.body.classList.add("page-open");
    $("mainGrid").hidden = true;
    $("pageView").hidden = false;
    window.scrollTo(0, 0);
  }
  function hidePage() {
    document.body.classList.remove("page-open");
    $("pageView").hidden = true;
    $("mainGrid").hidden = false;
    currentDetailId = null;
    window.scrollTo(0, savedGridScroll);
    // Clear the stale detail content so its #resFields editor (same id as the global paste
    // modal's) can't linger in the DOM and get matched alongside the modal's own fields.
    if (pageBodyEl) pageBodyEl.innerHTML = "";
  }
  function copyPageLink() {
    var btn = $("pageShare");
    var url = location.href;
    var flash = function (ok) {
      btn.textContent = ok ? "✓" : "🔗";
      btn.classList.toggle("copied", ok);
      setTimeout(function () { btn.textContent = "🔗"; btn.classList.remove("copied"); }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { flash(true); }, function () { fallbackCopy(url, flash); });
    } else {
      fallbackCopy(url, flash);
    }
  }
  function fallbackCopy(text, flash) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      flash(ok);
    } catch (e) { flash(false); }
  }

  // ---------- game detail modal ----------
  function detailBody(g) {
    var col = colorFor(g.category);
    var fav = favorites.has(g.id), done = isDoneToday(g.id), failed = isFailedToday(g.id), rt = inRoutine(g.id);
    var gs = gameStreak(g.id), last = gameLastPlayed(g.id);
    var host = hostOf(g.url);
    var fIco = faviconUrl(g.url);
    var letter = escapeHtml((g.name[0] || "?").toUpperCase());
    var related = DATA.filter(function (x) { return x.category === g.category && x.id !== g.id; }).slice(0, 6);
    var types = activeTypesOf(g); // e.g. [], ["guesses"], or ["score","guesses"]
    // A "Score" tab (score history over time) only makes sense — and only appears —
    // for games actually tracking a score.
    var hasScoreTab = types.indexOf("score") !== -1;
    if (!hasScoreTab) currentDetailTab = "overview";

    var icon = fIco
      ? '<img src="' + fIco + '" alt="" class="detail-ico">'
      : '<span class="detail-ico detail-fallback" style="background:' + col + '">' + letter + "</span>";
    var heroTxt =
      '<div class="detail-hero-txt"><span class="detail-cat">' + escapeHtml(g.category) + "</span>" +
      (gs >= 2 ? '<span class="detail-streak">🔥 ' + gs + "-day streak</span>" : "") + "</div>";
    var hero = g.thumbnail
      ? '<div class="detail-banner" style="background-color:' + col + ";background-image:url('" + encodeURI(g.thumbnail) + "')\"></div>" +
        '<div class="detail-subhead">' + icon.replace("detail-ico", "detail-ico sm") + heroTxt + "</div>"
      : '<div class="detail-hero" style="background:linear-gradient(135deg,' + col + ",color-mix(in srgb," + col + ' 55%, #000))">' + icon + heroTxt + "</div>";

    return (
      hero +
      '<p class="detail-desc' + (g.description ? "" : " empty") + '">' +
        escapeHtml(g.description || "A daily " + g.category.toLowerCase() + " puzzle.") + "</p>" +
      '<div class="detail-meta"><span>🔗 ' + escapeHtml(host) + "</span>" +
        "<span>" + (g.unlimited ? "♾️ Unlimited" : "📅 Daily") + "</span>" +
        (last ? "<span>Last played " + escapeHtml(last) + "</span>" : "<span>Not played yet</span>") + "</div>" +
      (function () {
        var wins = gameTimesPlayed(g.id), losses = gameLosses(g.id);
        var tiles = '<div class="gs-tile"><b>🔥 ' + gs + '</b><span>Current streak</span></div>' +
          '<div class="gs-tile"><b>🏆 ' + gameLongestStreak(g.id) + '</b><span>Best streak</span></div>' +
          '<div class="gs-tile"><b>' + wins + " / " + losses + '</b><span>Solved / failed</span></div>' +
          '<div class="gs-tile"><b>' + (wins + losses ? winRate(wins, losses) + "%" : "–") + '</b><span>Win rate</span></div>';
        types.forEach(function (t) {
          var val;
          if (t === "correct") {
            var avgC = gameAvgCorrect(g.id);
            val = avgC != null ? formatResultValue("correct", avgC) : "–";
          } else {
            var avg = gameAvgValue(g.id, t);
            val = avg != null ? formatResultValue(t, avg) : "–";
          }
          tiles += '<div class="gs-tile"><b>' + val + "</b><span>Avg " + TYPE_LABELS[t].toLowerCase() + "</span></div>";
        });
        return '<div class="detail-gamestats">' + tiles + "</div>";
      })() +
      '<div class="detail-actions">' +
        '<button class="btn btn-primary" data-detail-act="play">▶ Play</button>' +
        '<button class="btn' + (fav ? " on" : "") + '" data-detail-act="fav">' + (fav ? "★ Favorited" : "☆ Favorite") + "</button>" +
        '<button class="btn' + (rt ? " on-routine" : "") + '" data-detail-act="routine">' + (rt ? "🎯 In routine" : "🎯 Add to routine") + "</button>" +
      "</div>" +
      (hasScoreTab
        ? '<div class="detail-tabs" role="tablist">' +
            '<button class="detail-tab' + (currentDetailTab === "overview" ? " active" : "") + '" data-tab="overview" role="tab" aria-selected="' + (currentDetailTab === "overview") + '">Overview</button>' +
            '<button class="detail-tab' + (currentDetailTab === "score" ? " active" : "") + '" data-tab="score" role="tab" aria-selected="' + (currentDetailTab === "score") + '">Score</button>' +
          "</div>"
        : "") +
      '<div class="tab-panel"' + (hasScoreTab && currentDetailTab !== "overview" ? " hidden" : "") + '>' +
        (function () {
          if (!types.length) {
            return '<h3 class="stats-h">History</h3><p class="stats-empty">This game is tracked as solved/failed only — no score or guess count. Add a measurement below to start tracking one.</p>';
          }
          return types.map(function (t) {
            var heading, body;
            if (t === "guesses") {
              var gd = gameGuessDistribution(g.id);
              heading = "Guess distribution";
              body = gd.total
                ? distBarsHtml(gd, gd.total + " solves recorded")
                : '<p class="stats-empty">No guesses recorded yet — captured automatically when you share this game (or add one below).</p>';
            } else if (t === "correct") {
              var avgC = gameAvgCorrect(g.id);
              heading = "Accuracy";
              body = avgC != null
                ? '<p class="stats-empty">Average: ' + formatResultValue("correct", avgC) + " correct</p>"
                : '<p class="stats-empty">Nothing recorded yet — captured automatically when you share this game (or add one below).</p>';
            } else {
              var avg = gameAvgValue(g.id, t);
              heading = t === "time" ? "Times" : t === "hints" ? "Hints" : "Scores";
              var avgNoun = t === "time" ? "time" : t === "hints" ? "hints used" : "score";
              body = avg != null
                ? '<p class="stats-empty">Average ' + avgNoun + ": " + formatResultValue(t, avg) + "</p>"
                : '<p class="stats-empty">Nothing recorded yet — captured automatically when you share this game (or add one below).</p>';
            }
            return '<h3 class="stats-h">' + heading + '</h3>' + body;
          }).join("");
        })() +
        '<h3 class="stats-h">Track</h3>' +
        '<div class="type-picker">' +
          ALL_TYPES.map(function (t) {
            var on = types.indexOf(t) !== -1;
            return '<button class="type-chip' + (on ? " active" : "") + '" data-type-toggle="' + t + '">' +
              (on ? "✓ " : "+ ") + TYPE_LABELS[t] + "</button>";
          }).join("") +
        "</div>" +
        (function () {
          var values = {};
          types.forEach(function (t) { values[t] = valueToday(g.id, t); });
          var editor = resultEditorHtml({ solved: done, failed: failed, types: types, values: values });
          return '<h3 class="stats-h">Log today\'s result</h3>' + editor;
        })() +
        (related.length
          ? '<h3 class="stats-h">More ' + escapeHtml(g.category) + "</h3>" +
            '<div class="related">' +
            related.map(function (r) {
              var rc = colorFor(r.category);
              var ri = faviconUrl(r.url);
              var rl = escapeHtml((r.name[0] || "?").toUpperCase());
              return '<button class="rel" data-related-id="' + r.id + '">' +
                (ri ? '<img src="' + ri + '" alt="">' : '<span class="rel-fb" style="background:' + rc + '">' + rl + "</span>") +
                '<span class="rel-name">' + escapeHtml(r.name) + "</span></button>";
            }).join("") +
            "</div>"
          : "") +
      "</div>" +
      (hasScoreTab
        ? '<div class="tab-panel"' + (currentDetailTab !== "score" ? " hidden" : "") + '>' +
            '<h3 class="stats-h">Score history</h3>' + scoreHistoryHtml(g.id) +
          "</div>"
        : "")
    );
  }
  function openDetail(id) {
    navigateTo("g=" + encodeURIComponent(id));
  }
  function renderGamePage(id) {
    var g = gameById[id] || DATA.find(function (x) { return x.id === id; });
    if (!g) { navigateTo(""); return; }
    if (id !== currentDetailId) currentDetailTab = "overview";
    currentDetailId = id;
    showPage(g.name, detailBody(g));
  }
  function refreshDetail() {
    var g = DATA.find(function (x) { return x.id === currentDetailId; });
    if (!g || !pageBodyEl) return;
    pageBodyEl.innerHTML = detailBody(g);
  }
  function handleDetailAct(act) {
    var id = currentDetailId;
    if (act === "play") {
      var g = DATA.find(function (x) { return x.id === id; });
      if (g) openGame(g.url, g.id);
      return;
    }
    if (act === "fav") {
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      saveFavorites();
      if (prefs.favOnly || prefs.sort === "fav") render(); else patchCard(id);
    } else if (act === "done") {
      if (isDoneToday(id)) unmarkDoneToday(id); else markDoneToday(id);
      if (prefs.completion !== "all") render(); else patchCard(id);
    } else if (act === "fail") {
      if (isFailedToday(id)) clearFailToday(id); else markFailedToday(id);
      if (prefs.completion !== "all") render(); else patchCard(id);
    } else if (act === "routine") {
      toggleRoutine(id);
      if (prefs.routineOnly) render();
    }
    refreshDetail();
  }

  // ---------- settings / backup modal ----------
  function encodeData(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  function decodeData(s) { return JSON.parse(decodeURIComponent(escape(atob(s)))); }

  function collectBackup() {
    return {
      app: "dle-hub", version: 1, exportedAt: new Date().toISOString(),
      favorites: Array.from(favorites),
      history: history,
      fails: fails,
      guesses: guesses,
      routine: routine,
      activeTypes: manualTypes,
    };
  }
  function applyBackup(obj) {
    if (!obj || (obj.app !== "dle-hub" && !obj.favorites && !obj.history)) {
      throw new Error("This file isn't a DLE Hub backup.");
    }
    var favAdd = 0, days = 0;
    if (Array.isArray(obj.favorites)) {
      obj.favorites.forEach(function (id) { if (!favorites.has(id)) { favorites.add(id); favAdd++; } });
      saveFavorites();
    }
    if (obj.history && typeof obj.history === "object") {
      Object.keys(obj.history).forEach(function (date) {
        var incoming = obj.history[date] || [];
        var arr = history[date] || (history[date] = []);
        incoming.forEach(function (id) { if (arr.indexOf(id) === -1) arr.push(id); });
        if (!history[date].length) delete history[date];
        days++;
      });
      saveHistory();
    }
    if (obj.fails && typeof obj.fails === "object") {
      Object.keys(obj.fails).forEach(function (date) {
        var incoming = obj.fails[date] || [];
        var arr = fails[date] || (fails[date] = []);
        incoming.forEach(function (id) { if (arr.indexOf(id) === -1) arr.push(id); });
        if (!fails[date].length) delete fails[date];
      });
      saveFails();
    }
    if (obj.guesses && typeof obj.guesses === "object") {
      Object.keys(obj.guesses).forEach(function (date) {
        var incoming = obj.guesses[date] || {};
        var day = guesses[date] || (guesses[date] = {});
        Object.keys(incoming).forEach(function (id) {
          var incomingEntry = incoming[id];
          if (incomingEntry == null) return;
          // Merge per measurement type, not per game — a game can track more than one type
          // at once (e.g. score AND guesses), so a naive "skip if anything's there locally"
          // would silently drop whichever type wasn't already recorded on this device.
          if (typeof incomingEntry !== "object") {
            if (day[id] == null) day[id] = incomingEntry; // very old export, type unknown
            return;
          }
          if ("n" in incomingEntry && "m" in incomingEntry) incomingEntry = { correct: incomingEntry };
          var localEntry = (day[id] && typeof day[id] === "object") ? day[id] : (day[id] = {});
          Object.keys(incomingEntry).forEach(function (type) {
            if (localEntry[type] == null) localEntry[type] = incomingEntry[type];
          });
        });
      });
      saveGuesses();
    }
    if (Array.isArray(obj.routine)) {
      obj.routine.forEach(function (id) { if (routine.indexOf(id) === -1) routine.push(id); });
      saveRoutine();
    }
    if (obj.activeTypes && typeof obj.activeTypes === "object") {
      // Union per game — if one device tracks "score" and another independently started
      // tracking "guesses" for the same game, both devices should end up tracking both.
      Object.keys(obj.activeTypes).forEach(function (id) {
        var incoming = obj.activeTypes[id];
        if (!Array.isArray(incoming)) return;
        var local = manualTypes[id] || [];
        incoming.forEach(function (t) { if (local.indexOf(t) === -1) local.push(t); });
        manualTypes[id] = local;
      });
      saveManualTypes();
    }
    return { favAdd: favAdd, days: days };
  }
  function downloadBackup() {
    var blob = new Blob([JSON.stringify(collectBackup(), null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "dle-hub-backup-" + TODAY + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function importFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var res = applyBackup(JSON.parse(reader.result));
        render();
        modalBody().querySelector(".import-result").textContent =
          "Imported ✓ Added " + res.favAdd + " favorite(s), merged " + res.days + " day(s) of history.";
      } catch (e) {
        modalBody().querySelector(".import-result").textContent = "Import failed: " + e.message;
      }
    };
    reader.readAsText(file);
  }
  function shareLink() {
    return location.origin + location.pathname + "#dle=" + encodeData(collectBackup());
  }
  function handleSetAct(act) {
    if (act === "export") { downloadBackup(); return; }
    if (act === "import") { var f = modalBody().querySelector("#importFile"); if (f) f.click(); return; }
    if (act === "link") {
      var url = shareLink();
      var out = modalBody().querySelector(".link-out");
      var input = out.querySelector("input");
      out.hidden = false;
      input.value = url;
      input.select();
      var note = out.querySelector(".link-note");
      var large = url.length > 8000;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { note.textContent = large ? "Copied — note: this link is large; a file export is more reliable." : "Copied to clipboard ✓"; },
          function () { note.textContent = "Select the text above and copy it manually."; }
        );
      } else {
        note.textContent = "Select the text above and copy it manually.";
      }
    }
  }
  function settingsBody() {
    return (
      '<h3 class="stats-h">Backup &amp; transfer</h3>' +
      '<p class="settings-note">Your favorites and daily progress live only in this browser. ' +
      "Export a file (or copy a link) to back them up or move them to another device. " +
      "Importing <b>merges</b> with what's already here — it never deletes anything.</p>" +
      '<div class="settings-row">' +
        '<button class="btn" data-set-act="export">⬇️ Export file</button>' +
        '<button class="btn" data-set-act="import">⬆️ Import file</button>' +
        '<button class="btn" data-set-act="link">🔗 Shareable link</button>' +
      "</div>" +
      '<input type="file" accept="application/json,.json" id="importFile" hidden>' +
      '<p class="import-result"></p>' +
      '<div class="link-out" hidden><input type="text" readonly><p class="link-note"></p></div>' +
      '<h3 class="stats-h">Keyboard shortcuts</h3>' +
      '<ul class="shortcuts">' +
        "<li><kbd>/</kbd><span>Focus search</span></li>" +
        "<li><kbd>↑</kbd><kbd>↓</kbd><span>Move between games</span></li>" +
        "<li><kbd>Enter</kbd><span>Play the focused game</span></li>" +
        "<li><kbd>Esc</kbd><span>Close a dialog / clear search</span></li>" +
      "</ul>"
    );
  }
  function openSettings() { showModal("Settings & backup", settingsBody()); }

  // ---------- paste-a-result modal ----------
  // Analyse a share string. Reads the emoji grid ("the picture") for guesses/win,
  // and cross-checks an explicit "n/m" score line when present. When there's no grid
  // and no n/m score, falls back to detecting a time (mm:ss), a bare score ("1,234 pts"),
  // an explicit "N/M correct" (accuracy games), or plain solved/failed wording — so games
  // that aren't guess-count based still work.
  function extractCorrectFraction(text) {
    // Explicit "N/M correct" (or "correct: N/M", "N of M correct") — has its own total.
    var m = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})\s*correct\b/i) ||
      text.match(/correct[:\s]+(\d{1,3})\s*\/\s*(\d{1,3})\b/i) ||
      text.match(/(\d{1,3})\s*(?:of|out of)\s*(\d{1,3})\s*correct\b/i);
    if (m) {
      var n = parseInt(m[1], 10), tot = parseInt(m[2], 10);
      return (tot >= 1 && tot <= 100 && n >= 0 && n <= tot) ? { n: n, m: tot } : null;
    }
    // Bare "N correct" with no explicit total (e.g. "3 correct") — infer the total by
    // counting per-item right/wrong marks (✅❌✔️✖️☑️✘) elsewhere in the same text.
    var bare = text.match(/\b(\d{1,3})\s*correct\b/i);
    if (!bare) return null;
    var n2 = parseInt(bare[1], 10);
    var MARK = /[✅✔☑❌✖✘](?:️)?/g;
    var marks = text.match(MARK);
    var total = marks ? marks.length : 0;
    if (total < 2 || total < n2) return null; // need real per-item marks, and total >= n
    return { n: n2, m: total };
  }
  function extractTimeSeconds(text) {
    var m = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (m) {
      return m[3] != null
        ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
        : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    m = text.match(/\b(\d+)\s*(?:m|min|mins|minutes?)\s*(\d+)\s*(?:s|sec|secs|seconds?)\b/i);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/i);
    if (m) return Math.round(parseFloat(m[1]));
    return null;
  }
  function extractScore(text) {
    var m = text.match(/\bscore[:\s]+(\d{1,3}(?:,\d{3})*|\d{1,6})\b/i);
    if (m) return parseInt(m[1].replace(/,/g, ""), 10);
    m = text.match(/\b(\d{1,3}(?:,\d{3})*|\d{2,6})\s*(?:pts?|points?)\b/i);
    if (m) return parseInt(m[1].replace(/,/g, ""), 10);
    return null;
  }
  function extractHints(text) {
    // "Hints: 3" / "Hints used: 3" / "Hint 1"
    var m = text.match(/hints?\s*(?:used)?[:\s]+(\d{1,3})\b/i);
    if (m) return parseInt(m[1], 10);
    // "3 hints used"
    m = text.match(/\b(\d{1,3})\s*hints?\s*used\b/i);
    if (m) return parseInt(m[1], 10);
    // "used 3 hints"
    m = text.match(/\bused\s*(\d{1,3})\s*hints?\b/i);
    if (m) return parseInt(m[1], 10);
    return null;
  }
  function parseShareText(text) {
    if (!text || text.length > 8000) return null;

    // "N/M correct" (trivia grids, category-style games) — checked first since the explicit
    // "correct" keyword is unambiguous and would otherwise be misread as a guess count.
    var cf = extractCorrectFraction(text);
    if (cf) return { solved: cf.n / cf.m > 0.5, value: cf, resultType: "correct", nameHint: extractNameHint(text) };

    var CELL = /[\u{1F7E5}-\u{1F7EB}\u{2B1B}\u{2B1C}]/gu; // 🟥🟦🟧🟨🟩🟪🟫 ⬛ ⬜
    var GREEN = /\u{1F7E9}/u;

    // grid rows = lines that are made of cell emojis
    var rows = [];
    text.split("\n").forEach(function (ln) {
      var cs = ln.match(CELL);
      if (cs && cs.length >= 2) rows.push(cs);
    });
    var hasGrid = rows.length > 0;

    // explicit score "N/M" or "X/M" — guard against dates/percentages
    var fSolved = null, fGuess = null;
    var fm = text.match(/(?:^|[\s(#])(X|x|[1-9]\d?)\s*\/\s*([1-9]\d?)(?![\d/])/);
    if (fm) {
      var mx = parseInt(fm[2], 10);
      if (mx >= 1 && mx <= 30) {
        if (/x/i.test(fm[1])) { fSolved = false; }
        else { var n = parseInt(fm[1], 10); if (n <= mx) { fSolved = true; fGuess = n; } }
      }
    }

    if (!hasGrid && fSolved === null) {
      // No grid, no n/m — try a time, hints used, then a score, then plain solved/failed wording.
      var nameHint = extractNameHint(text);
      var timeSec = extractTimeSeconds(text);
      if (timeSec != null) return { solved: true, value: timeSec, resultType: "time", nameHint: nameHint };
      var hints = extractHints(text);
      if (hints != null) return { solved: true, value: hints, resultType: "hints", nameHint: nameHint };
      var score = extractScore(text);
      if (score != null) return { solved: true, value: score, resultType: "score", nameHint: nameHint };
      if (/\b(solved|won|win|success|complete|completed)\b/i.test(text)) {
        return { solved: true, value: null, resultType: "winloss", nameHint: nameHint };
      }
      if (/\b(failed|lost|lose|unsolved|didn.?t (?:get|guess) it)\b/i.test(text)) {
        return { solved: false, value: null, resultType: "winloss", nameHint: nameHint };
      }
      return null;
    }

    var solved, guesses = null;
    if (hasGrid && rows.length === 1) {
      // single-row game (e.g. Framed): a green square marks the correct guess
      var row = rows[0], gi = -1;
      for (var i = 0; i < row.length; i++) { if (GREEN.test(row[i])) { gi = i; break; } }
      solved = gi !== -1;
      guesses = solved ? gi + 1 : null;
    } else if (hasGrid) {
      // multi-row grid (Wordle-like): last row all-green = solved, rows = guesses
      var last = rows[rows.length - 1];
      var allGreen = last.length >= 3 && last.every(function (c) { return GREEN.test(c); });
      solved = allGreen;
      guesses = solved ? rows.length : null;
    } else {
      solved = fSolved;
      guesses = fSolved ? fGuess : null;
    }

    // Reconcile with the explicit score when we have one.
    if (fSolved !== null) {
      if (fSolved === false) { solved = false; guesses = null; }
      else { solved = true; if (fGuess) guesses = fGuess; } // the game's own count wins
    }

    return { solved: solved, value: guesses, resultType: "guesses", nameHint: extractNameHint(text) };
  }
  function extractNameHint(text) {
    var line = (text.split("\n")[0] || "").trim().replace(/^#/, "");
    var m = line.match(/^[^\d#(:]+/); // leading letters before a number / # / ( / :
    return (m ? m[0] : line).trim();
  }
  function normName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function matchGameByName(hint) {
    if (!hint) return null;
    var key = normName(hint);
    if (!key) return null;
    if (gameById[key]) return gameById[key];
    var best = null;
    for (var i = 0; i < DATA.length; i++) {
      var nk = normName(DATA[i].name);
      if (nk === key) return DATA[i];
      if (!best && (nk.indexOf(key) === 0 || key.indexOf(nk) === 0)) best = DATA[i];
      if (!best && key.length >= 4 && (nk.indexOf(key) !== -1 || key.indexOf(nk) !== -1)) best = DATA[i];
    }
    return best;
  }
  // Reusable "confirm the result" editor: paste box + Solved/Failed toggle + one value field
  // per tracked measurement (a game can track several at once, e.g. guesses AND score).
  // Used by the global paste modal AND each game's detail, so auto-detect is always editable
  // before recording (guarantees accuracy).
  function valueFieldHtml(type, val, disabled) {
    var isTime = type === "time";
    var isCorrect = type === "correct";
    var isText = isTime || isCorrect;
    var prefix = type === "score" ? "scoring" : type === "hints" ? "using" : "in";
    var unit = type === "score" ? "points" : type === "time" ? "" : type === "correct" ? "correct" : type === "hints" ? "hints" : "guesses";
    var display = val != null ? (isText ? formatResultValue(type, val) : val) : "";
    return (
      '<span class="res-g" data-restype="' + type + '">' + prefix + ' ' +
      '<input type="' + (isText ? "text" : "number") + '" class="guess-input res-value-input" data-restype="' + type + '" ' +
      (isTime ? 'placeholder="m:ss"' : isCorrect ? 'placeholder="3/6"' : 'min="0" max="9999" placeholder="?"') +
      ' value="' + escapeHtml(String(display)) + '"' + (disabled ? " disabled" : "") + "> " + unit + "</span>"
    );
  }
  function resultEditorHtml(state) {
    state = state || {};
    var types = state.types || [];
    var values = state.values || {};
    var sel = state.failed ? "failed" : "solved";
    var fields = types.map(function (t) { return valueFieldHtml(t, values[t], sel === "failed"); }).join("");
    return (
      (state.paste !== false
        ? '<textarea id="pasteBox" class="paste-input" rows="3" placeholder="Paste the game’s Share text to auto-fill ↓ (or just set it manually)"></textarea>'
        : "") +
      '<p class="res-preview" id="resPreview"></p>' +
      '<div class="res-editor" id="resFields">' +
        '<button class="btn res-solved' + (sel === "solved" ? " active" : "") + '" data-res="solved">✓ Solved</button>' +
        '<button class="btn res-failed' + (sel === "failed" ? " active" : "") + '" data-res="failed">✗ Failed</button>' +
        fields +
        '<button class="btn btn-primary" data-record="1">Record</button>' +
      "</div>" +
      '<p class="import-result" id="resMsg"></p>'
    );
  }
  // Fills the field for `type` if the editor already has one; otherwise injects a new one
  // just before the Record button (e.g. a paste implies a measurement the game isn't
  // formally tracking yet — handleRecord will add it to the game's active types on Record).
  function upsertValueField(type, val, disabled) {
    var input = document.querySelector('#resFields .res-value-input[data-restype="' + type + '"]');
    if (input) {
      input.value = val != null ? formatResultValue(type, val) : "";
      input.disabled = disabled;
      return;
    }
    var recordBtn = document.querySelector("#resFields [data-record]");
    if (recordBtn) recordBtn.insertAdjacentHTML("beforebegin", valueFieldHtml(type, val, disabled));
  }
  function setResSelection(sel) {
    var s = document.querySelector(".res-solved"), f = document.querySelector(".res-failed");
    if (!s || !f) return;
    s.classList.toggle("active", sel === "solved");
    f.classList.toggle("active", sel === "failed");
    document.querySelectorAll("#resFields .res-value-input").forEach(function (inp) {
      inp.disabled = sel === "failed";
    });
  }
  function populateFromPaste(text) {
    var p = parseShareText(text);
    var prev = document.getElementById("resPreview");
    if (!p) { if (prev) prev.textContent = text.trim() ? "Couldn’t read a result from that yet…" : ""; return; }
    setResSelection(p.solved ? "solved" : "failed");
    if (p.value != null) upsertValueField(p.resultType, p.value, !p.solved);
    var name = currentDetailId ? (gameById[currentDetailId] || {}).name : (matchGameByName(p.nameHint) || {}).name;
    var valTxt = p.solved && p.value != null ? " " + describeResultValue(p.resultType, p.value) : "";
    if (prev) prev.textContent = "Detected: " + (name ? name + " · " : "") + (p.solved ? "solved" + valTxt : "failed") + " — fix below if wrong.";
  }
  function handleRecord() {
    var msg = document.getElementById("resMsg");
    var solvedBtn = document.querySelector(".res-solved");
    var solved = solvedBtn && solvedBtn.classList.contains("active");
    var g;
    if (currentDetailId) {
      g = gameById[currentDetailId];
    } else {
      var pb = document.getElementById("pasteBox");
      var p = pb && parseShareText(pb.value);
      if (!p) { if (msg) msg.textContent = "Paste a game’s share text first."; return; }
      g = matchGameByName(p.nameHint);
      if (!g) { if (msg) msg.textContent = "Couldn’t match a game from that text. Open it in the hub and log it from its ⓘ."; return; }
    }
    if (!g) return;
    var recordedBits = [];
    if (solved) {
      document.querySelectorAll("#resFields .res-value-input").forEach(function (inp) {
        var type = inp.dataset.restype;
        var val = parseResultValueInput(type, inp.value);
        if (val == null) return;
        setValueToday(g.id, type, val);
        ensureTypeActive(g.id, type);
        recordedBits.push(formatResultValue(type, val) + (type === "correct" ? " correct" : type === "score" ? " pts" : type === "guesses" ? " guesses" : type === "hints" ? " hints" : ""));
      });
    }
    removePending(g.id);
    if (solved) markDoneToday(g.id); else markFailedToday(g.id);
    patchCard(g.id);
    if (prefs.completion !== "all" || prefs.favOnly || prefs.routineOnly) render();
    if (currentDetailId) { refreshDetail(); }
    else if (msg) msg.textContent = "Recorded ✓ " + g.name + " — " + (solved ? "solved" + (recordedBits.length ? " (" + recordedBits.join(", ") + ")" : "") : "failed") + ".";
  }
  function pasteBody() {
    return (
      '<p class="settings-note">Finished a game? Hit its <b>Share</b> button and paste the text below — ' +
      "the hub reads the grid to detect solved/failed and your guesses (or a time/score for games that use those), and matches the game by name. " +
      "<b>Check it's right, then Record.</b></p>" +
      resultEditorHtml({})
    );
  }
  function openPaste() {
    showModal("Paste a result", pasteBody());
    var ta = document.getElementById("pasteBox");
    if (ta) ta.focus();
  }

  // ---------- keyboard shortcuts ----------
  document.addEventListener("keydown", function (e) {
    var t = e.target, tag = (t.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
    if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (e.key === "Escape" && t === searchEl) { searchEl.blur(); return; }
    if (e.key === "Escape" && document.body.classList.contains("page-open") && !typing) { navigateTo(""); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      var cards = Array.prototype.slice.call(grid.querySelectorAll(".card"));
      if (!cards.length) return;
      e.preventDefault();
      var cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".card") : null;
      var idx = cur ? cards.indexOf(cur) : -1;
      idx = e.key === "ArrowDown" ? Math.min(cards.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (idx < 0) idx = 0;
      cards[idx].focus();
      cards[idx].scrollIntoView({ block: "nearest" });
    }
  });

  // ---------- import from a shared link (#dle=...) ----------
  function checkImportHash() {
    var m = location.hash.match(/[#&]dle=([^&]+)/);
    if (!m) return;
    try {
      var obj = decodeData(m[1]);
      var favN = (obj.favorites || []).length;
      var dayN = obj.history ? Object.keys(obj.history).length : 0;
      if (window.confirm("Import DLE Hub backup from this link?\n\n" + favN + " favorite(s) and " + dayN + " day(s) of progress will be merged into this browser.")) {
        applyBackup(obj);
        render();
      }
    } catch (e) { /* ignore malformed link */ }
    window.history.replaceState(null, "", location.pathname + location.search);
  }

  // ---------- interactions ----------
  function openGame(url, id) {
    window.open(url, "_blank", "noopener");
    if (id && prefs.askOnReturn) addPending(id);
  }

  // Ingest a result captured by the browser extension (from a game's share text).
  // payload: { host, name?, solved:bool, guesses?:number }
  function recordResult(payload) {
    if (!payload || !payload.host) return { matched: false };
    var host = String(payload.host).replace(/^www\./, "").toLowerCase();
    var candidates = gamesByHost[host];
    if (!candidates || !candidates.length) return { matched: false };
    var g = candidates[0];
    if (candidates.length > 1 && payload.name) {
      var nm = String(payload.name).toLowerCase();
      var hit = candidates.filter(function (c) {
        var cn = c.name.toLowerCase();
        return cn === nm || cn.indexOf(nm) !== -1 || nm.indexOf(cn) !== -1;
      });
      if (hit.length) g = hit[0];
    }
    removePending(g.id);
    if (payload.solved) {
      markDoneToday(g.id);
      if (payload.guesses > 0) { setValueToday(g.id, "guesses", payload.guesses); ensureTypeActive(g.id, "guesses"); }
    } else {
      markFailedToday(g.id);
    }
    // refresh UI
    if (currentDetailId === g.id) refreshDetail();
    render();
    return { matched: true, name: g.name, solved: !!payload.solved, guesses: payload.guesses || null };
  }

  grid.addEventListener("click", function (e) {
    var card = e.target.closest(".card");
    if (!card) return;
    var id = card.dataset.id;

    var btn = e.target.closest("button[data-act]");
    if (btn) {
      e.stopPropagation();
      if (btn.dataset.act === "fav") {
        if (favorites.has(id)) favorites.delete(id);
        else favorites.add(id);
        saveFavorites();
        // update just this card + stats without full re-render (unless fav filter active)
        if (prefs.favOnly || prefs.sort === "fav") render();
        else { patchCard(id); }
      } else if (btn.dataset.act === "done") {
        if (isDoneToday(id)) unmarkDoneToday(id);
        else markDoneToday(id);
        if (prefs.completion !== "all") render();
        else patchCard(id);
      } else if (btn.dataset.act === "fail") {
        if (isFailedToday(id)) clearFailToday(id);
        else markFailedToday(id);
        if (prefs.completion !== "all") render();
        else patchCard(id);
      } else if (btn.dataset.act === "info") {
        openDetail(id);
      }
      return;
    }
    // clicked the card body -> play
    openGame(card.dataset.url, id);
  });

  // keyboard: Enter/Space on a focused card plays it
  grid.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var card = e.target.closest(".card");
    if (card && !e.target.closest("button")) {
      e.preventDefault();
      openGame(card.dataset.url, card.dataset.id);
    }
  });

  // Replace one card in place (keeps scroll position on toggle).
  function patchCard(id) {
    var g = itemById[id];
    if (!g) return;
    var old = grid.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    // Not currently rendered (lazy list or filtered out) — just refresh stats;
    // the card will reflect live state whenever it next renders. Avoids a full
    // re-render that would reset scroll position.
    if (!old) { updateStats(currentList.length); return; }
    var tmp = document.createElement("div");
    tmp.innerHTML = cardHtml(g);
    old.replaceWith(tmp.firstChild);
    updateStats(currentList.length);
  }

  // search (debounced so typing doesn't re-render on every keystroke)
  var searchTimer = null;
  searchEl.addEventListener("input", function () {
    clearSearchBtn.hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTerm = searchEl.value;
      render();
    }, 140);
  });
  clearSearchBtn.addEventListener("click", function () {
    searchEl.value = "";
    searchTerm = "";
    clearSearchBtn.hidden = true;
    searchEl.focus();
    render();
  });

  // toggles
  favFilterBtn.addEventListener("click", function () {
    prefs.favOnly = !prefs.favOnly;
    favFilterBtn.setAttribute("aria-pressed", prefs.favOnly);
    savePrefs();
    render();
  });
  statusEl.addEventListener("change", function () {
    prefs.completion = statusEl.value;
    savePrefs();
    render();
  });
  routineFilterBtn.addEventListener("click", function () {
    prefs.routineOnly = !prefs.routineOnly;
    routineFilterBtn.setAttribute("aria-pressed", prefs.routineOnly);
    savePrefs();
    render();
  });
  playRoutineBtn.addEventListener("click", playRoutine);
  sortEl.addEventListener("change", function () {
    prefs.sort = sortEl.value;
    savePrefs();
    render();
  });
  $("askReturn").addEventListener("click", function () {
    prefs.askOnReturn = !prefs.askOnReturn;
    $("askReturn").setAttribute("aria-pressed", prefs.askOnReturn);
    savePrefs();
    if (!prefs.askOnReturn) hidePrompt();
  });
  $("viewToggle").addEventListener("click", function () {
    prefs.view = prefs.view === "grid" ? "list" : "grid";
    savePrefs();
    applyView();
    render();
  });
  $("resetFilters").addEventListener("click", function () {
    prefs.category = "all"; prefs.favOnly = false; prefs.completion = "all"; prefs.routineOnly = false;
    searchTerm = ""; searchEl.value = ""; clearSearchBtn.hidden = true;
    savePrefs();
    syncControls();
    buildChips();
    render();
  });

  function savePrefs() { write(LS.prefs, prefs); }

  // Open every routine game that isn't solved/failed yet today (in new tabs).
  function playRoutine() {
    var todo = routine.filter(function (id) { return gameById[id] && !isDoneToday(id) && !isFailedToday(id); });
    if (!todo.length) { alert(routine.length ? "All your routine games are done for today. 🎉" : "Your routine is empty — add games from a game's ⓘ details."); return; }
    if (todo.length > 6 && !confirm("Open " + todo.length + " routine games in new tabs?")) return;
    todo.forEach(function (id) { var g = gameById[id]; if (g) { window.open(g.url, "_blank", "noopener"); if (prefs.askOnReturn) addPending(id); } });
  }
  function updateRoutineControls() {
    routineFilterBtn.hidden = routine.length === 0;
    playRoutineBtn.hidden = routine.length === 0;
    routineFilterBtn.setAttribute("aria-pressed", prefs.routineOnly);
  }

  function applyView() {
    var grd = prefs.view === "grid";
    grid.classList.toggle("view-grid", grd);
    var b = $("viewToggle");
    b.textContent = grd ? "☰ List" : "▦ Grid";
    b.setAttribute("aria-pressed", grd);
  }

  function syncControls() {
    favFilterBtn.setAttribute("aria-pressed", prefs.favOnly);
    statusEl.value = prefs.completion;
    $("askReturn").setAttribute("aria-pressed", prefs.askOnReturn);
    sortEl.value = prefs.sort;
    applyView();
    updateRoutineControls();
  }

  // ---------- "did you finish?" prompt when you return to the hub ----------
  var promptEl = null;
  var promptShowingId = null;

  function ensurePromptEl() {
    if (promptEl) return promptEl;
    promptEl = document.createElement("div");
    promptEl.className = "finish-prompt";
    promptEl.setAttribute("role", "dialog");
    promptEl.setAttribute("aria-live", "polite");
    document.body.appendChild(promptEl);
    promptEl.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-fp]");
      if (!b) return;
      var id = promptShowingId;
      if (b.dataset.fp === "yes") {
        markDoneToday(id);
        removePending(id);
        if (prefs.completion !== "all") render();
        else patchCard(id);
      } else {
        removePending(id);
      }
      hidePrompt();
      setTimeout(processPending, 260); // show next queued game, if any
    });
    return promptEl;
  }

  function hidePrompt() {
    if (promptEl) promptEl.classList.remove("show");
    promptShowingId = null;
  }

  function showPrompt(id) {
    var g = DATA.find(function (x) { return x.id === id; });
    if (!g) { removePending(id); return; }
    promptShowingId = id;
    var el = ensurePromptEl();
    var col = colorFor(g.category);
    var fIco = faviconUrl(g.url);
    var letter = escapeHtml((g.name[0] || "?").toUpperCase());
    var icon = fIco
      ? '<img class="fp-ico" src="' + fIco + '" alt="">'
      : '<span class="fp-ico fp-fallback" style="background:' + col + '">' + letter + "</span>";
    el.innerHTML =
      icon +
      '<div class="fp-text"><span class="fp-q">Did you finish today?</span>' +
      '<span class="fp-name">' + escapeHtml(g.name) + "</span></div>" +
      '<div class="fp-acts">' +
        '<button class="fp-yes" data-fp="yes">Yes ✓</button>' +
        '<button class="fp-no" data-fp="no">Not yet</button>' +
      "</div>";
    // force a reflow so the entry transition plays, then reveal (no rAF dependency)
    void el.offsetHeight;
    el.classList.add("show");
  }

  function processPending() {
    if (!prefs.askOnReturn || promptShowingId) return;
    // drop any that were marked done in the meantime
    pendingStore.ids = pendingStore.ids.filter(function (id) { return !isDoneToday(id); });
    savePending();
    if (pendingStore.ids.length) showPrompt(pendingStore.ids[0]);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") processPending();
  });
  window.addEventListener("focus", processPending);

  // ---------- midnight auto-reset while the tab stays open ----------
  setInterval(function () {
    var now = todayStr();
    if (now !== TODAY) {
      TODAY = now;
      pendingStore = { date: TODAY, ids: [] };
      savePending();
      hidePrompt();
      render(); // done-today statuses now recompute against the new date
      if (currentDetailId) refreshDetail(); // an open game page also needs a fresh "today"
    }
  }, 60 * 1000);

  // ---------- lazy-render: load more as you approach the bottom ----------
  (function () {
    var sentinel = document.getElementById("scrollSentinel");
    if (sentinel && "IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0] && entries[0].isIntersecting) appendMore();
      }, { rootMargin: "800px" }).observe(sentinel);
    }
    // Belt-and-suspenders: a throttled scroll fallback so "load more" always works,
    // even where the observer is unreliable.
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (renderedCount < currentList.length &&
            window.innerHeight + window.scrollY >= document.body.offsetHeight - 900) {
          appendMore();
        }
      });
    }, { passive: true });
  })();

  // ---------- service worker (offline / installable PWA) ----------
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline unavailable */ });
    });
  }

  // ---------- sync bridge (used by sync.js if Supabase is configured) ----------
  window.DLEHub = {
    // current local state, in the same shape as a backup file
    getState: function () { return collectBackup(); },
    // merge cloud state into local (union — never deletes), then refresh the UI
    applyRemote: function (state) {
      suppressDirty = true;
      try { applyBackup(state); } catch (e) { /* ignore malformed */ } finally { suppressDirty = false; }
      syncControls();
      buildChips();
      render();
    },
    // called by the browser extension with a parsed game result
    recordResult: function (payload) { return recordResult(payload); },
  };

  // The extension delivers results by posting a message into this page.
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== "dle-extension" || !d.payload) return;
    recordResult(d.payload);
  });

  // ---------- boot ----------
  $("openStats").addEventListener("click", openStats);
  $("openSettings").addEventListener("click", openSettings);
  $("pasteResult").addEventListener("click", openPaste);
  $("pageBack").addEventListener("click", function () { navigateTo(""); });
  $("pageShare").addEventListener("click", copyPageLink);
  window.addEventListener("hashchange", applyRoute);
  syncControls();
  buildChips();
  render();
  applyRoute(); // deep link on load, e.g. #g=wordle or #h=brawldle.gg
  checkImportHash();
  // If you opened a game earlier today and reloaded the hub, ask on load too.
  if (document.visibilityState === "visible") setTimeout(processPending, 500);
})();
