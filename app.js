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
  function setGuessToday(id, n) {
    if (!(n > 0)) return;
    (guesses[TODAY] = guesses[TODAY] || {})[id] = n;
    saveGuesses();
  }
  function guessToday(id) { return guesses[TODAY] && guesses[TODAY][id]; }
  function gameAvgGuesses(id) {
    var sum = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      if (guesses[k][id] != null) { sum += guesses[k][id]; n++; }
    });
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }
  function overallAvgGuesses() {
    var sum = 0, n = 0;
    Object.keys(guesses).forEach(function (k) {
      Object.keys(guesses[k]).forEach(function (id) { sum += guesses[k][id]; n++; });
    });
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }
  // Distribution of solves by guess count: buckets 1..6 and "7+".
  function guessDistribution() {
    var dist = {}, max = 0, total = 0;
    Object.keys(guesses).forEach(function (date) {
      var day = guesses[date];
      Object.keys(day).forEach(function (id) {
        var n = day[id];
        if (!(n >= 1)) return;
        var b = n >= 7 ? 7 : n;
        dist[b] = (dist[b] || 0) + 1;
        total++;
        if (dist[b] > max) max = dist[b];
      });
    });
    return { dist: dist, max: max, total: total };
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
  (function initTheme() {
    var saved = read(LS.theme, "auto");
    document.documentElement.setAttribute("data-theme", saved);
    $("themeToggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var order = ["auto", "light", "dark"];
      var next = order[(order.indexOf(cur) + 1) % order.length];
      document.documentElement.setAttribute("data-theme", next);
      write(LS.theme, next);
      $("themeToggle").title = "Theme: " + next + " (click to change)";
    });
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

  // ---------- group same-site games into "hubs" (modes / multi-game sites) ----------
  // Generic hosts that just host lots of unrelated games are never grouped.
  var SHARED_HOSTS = /(?:^|\.)(github\.io|itch\.io|vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|glitch\.me|herokuapp\.com|replit\.dev|repl\.co|surge\.sh|neocities\.org|onrender\.com|fly\.dev|gitlab\.io)$/;
  var ITEMS = [];        // what the grid iterates: hubs + standalone games
  var itemById = {};     // grid-item id -> hub or game
  var gameById = {};     // every game id -> game (incl. hub members)
  var hubIdOfMember = {}; // member game id -> its hub's id
  var gamesByHost = {};  // host -> [games] (for extension result matching)

  function hubLabel(members, host) {
    var first = members[0].name.split(/[\s:]+/)[0];
    var common = first && first.length >= 2 && members.every(function (m) {
      return m.name.split(/[\s:]+/)[0].toLowerCase() === first.toLowerCase();
    });
    if (common) return first;
    var lbl = host.split(".")[0];
    return lbl.charAt(0).toUpperCase() + lbl.slice(1);
  }
  function hubCategory(members) {
    var c = members[0].category;
    return members.every(function (m) { return m.category === c; }) ? c : "Various";
  }
  (function buildItems() {
    DATA.forEach(function (g) { gameById[g.id] = g; });
    var byHost = {};
    DATA.forEach(function (g) { var h = hostOf(g.url); (byHost[h] = byHost[h] || []).push(g); });
    gamesByHost = byHost;
    Object.keys(byHost).forEach(function (h) {
      var members = byHost[h];
      if (members.length >= 2 && h && !SHARED_HOSTS.test(h)) {
        members.sort(function (a, b) { return a.name.localeCompare(b.name); });
        var hub = { isHub: true, id: "hub:" + h, host: h, name: hubLabel(members, h), members: members, category: hubCategory(members) };
        ITEMS.push(hub);
        itemById[hub.id] = hub;
        members.forEach(function (m) { hubIdOfMember[m.id] = hub.id; });
      } else {
        members.forEach(function (m) { ITEMS.push(m); itemById[m.id] = m; });
      }
    });
  })();

  // accessors that work for both a hub and a plain game
  function itemPopularity(it) {
    return it.isHub ? it.members.reduce(function (m, g) { return Math.max(m, g.popularity || 0); }, 0) : (it.popularity || 0);
  }
  function itemFavorited(it) {
    return it.isHub ? it.members.some(function (g) { return favorites.has(g.id); }) : favorites.has(it.id);
  }
  function itemInRoutine(it) {
    return it.isHub ? it.members.some(function (g) { return inRoutine(g.id); }) : inRoutine(it.id);
  }
  function itemAllDone(it) {
    return it.isHub ? it.members.every(function (g) { return isDoneToday(g.id); }) : isDoneToday(it.id);
  }
  function itemDoneCount(it) {
    return it.isHub ? it.members.filter(function (g) { return isDoneToday(g.id); }).length : (isDoneToday(it.id) ? 1 : 0);
  }
  function itemMatchesCat(it, cat) {
    if (cat === "all") return true;
    return it.isHub ? it.members.some(function (g) { return g.category === cat; }) : it.category === cat;
  }
  function itemHay(it) {
    if (it.isHub) return (it.name + " " + it.host + " " + it.members.map(function (g) { return g.name + " " + g.description; }).join(" ")).toLowerCase();
    return (it.name + " " + it.description + " " + it.category).toLowerCase();
  }

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
    return it.isHub ? hubCardHtml(it) : gameCardHtml(it);
  }

  function hubCardHtml(hub) {
    var col = hub.category === "Various" ? "#64748b" : colorFor(hub.category);
    var fIco = faviconUrl(hub.members[0].url);
    var letter = escapeHtml((hub.name[0] || "?").toUpperCase());
    var fallback = '<span class=&quot;favicon-fallback&quot; style=&quot;background:' + col + '&quot;>' + letter + "</span>";
    var icon = fIco
      ? '<img class="favicon" src="' + fIco + '" alt="" loading="lazy" onerror="this.outerHTML=\'' + fallback + '\'">'
      : '<span class="favicon-fallback" style="background:' + col + '">' + letter + "</span>";
    var n = hub.members.length;
    var doneN = itemDoneCount(hub);
    var favN = hub.members.filter(function (g) { return favorites.has(g.id); }).length;
    var thumbG = null;
    for (var i = 0; i < hub.members.length; i++) { if (hub.members[i].thumbnail) { thumbG = hub.members[i]; break; } }
    var thumbStyle = thumbG ? "background-color:" + col + ";background-image:url('" + encodeURI(thumbG.thumbnail) + "')" : "background-color:" + col;
    var donePill = doneN > 0 ? '<span class="streak-pill" title="' + doneN + ' of ' + n + ' done today">✓ ' + doneN + "/" + n + "</span>" : "";
    return (
      '<article class="card hub-card' + (itemAllDone(hub) ? " is-done" : "") + '" data-id="' + hub.id + '" tabindex="0" role="button" aria-label="' + escapeHtml(hub.name) + ", " + n + ' modes">' +
        '<div class="card-thumb" style="' + thumbStyle + '" aria-hidden="true"></div>' +
        '<div class="card-body">' +
          '<div class="card-line">' +
            icon +
            '<span class="card-title">' + escapeHtml(hub.name) + "</span>" +
            '<span class="card-badge" style="background:' + col + '">' + escapeHtml(hub.category) + "</span>" +
          "</div>" +
          '<p class="card-desc">' + n + " modes on " + escapeHtml(hub.host) + (favN ? " · ★ " + favN : "") + "</p>" +
        "</div>" +
        '<div class="card-acts">' +
          donePill +
          '<span class="hub-count">' + n + " modes ▸</span>" +
        "</div>" +
      "</article>"
    );
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
    body.innerHTML =
      '<div class="stats-tiles">' +
        '<div class="stats-tile"><span class="st-big">🔥 ' + currentStreak() + '</span><span class="st-label">Current streak</span></div>' +
        '<div class="stats-tile"><span class="st-big">🏆 ' + longestStreak() + '</span><span class="st-label">Longest streak</span></div>' +
        '<div class="stats-tile"><span class="st-big">' + solved + '</span><span class="st-label">Solved</span></div>' +
        '<div class="stats-tile"><span class="st-big">' + failed + '</span><span class="st-label">Failed</span></div>' +
        '<div class="stats-tile"><span class="st-big">' + (solved + failed ? winRate(solved, failed) + "%" : "–") + '</span><span class="st-label">Win rate</span></div>' +
        '<div class="stats-tile"><span class="st-big">' + (overallAvgGuesses() != null ? overallAvgGuesses() : "–") + '</span><span class="st-label">Avg guesses</span></div>' +
        '<div class="stats-tile"><span class="st-big">' + Object.keys(distinct).length + '</span><span class="st-label">Games played</span></div>' +
      "</div>" +
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
      var n = guesses[date][id];
      if (!(n >= 1)) return;
      var b = n >= 7 ? 7 : n;
      dist[b] = (dist[b] || 0) + 1;
      total++;
      if (dist[b] > max) max = dist[b];
    });
    return { dist: dist, max: max, total: total };
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

  // ---------- generic modal (used by detail + settings + hub) ----------
  var genericModal = null, genericEsc = null, currentDetailId = null, currentHubId = null;

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
    currentDetailId = null;
    currentHubId = null;
  }
  function modalBody() { return genericModal.querySelector(".modal-body"); }

  function onModalClick(e) {
    if (e.target === genericModal || e.target.closest(".modal-close")) { hideModal(); return; }
    var rel = e.target.closest("[data-related-id]");
    if (rel) { openDetail(rel.dataset.relatedId); return; }
    var d = e.target.closest("[data-detail-act]");
    if (d && currentDetailId) { handleDetailAct(d.dataset.detailAct); return; }
    var m = e.target.closest("[data-mode-act]");
    if (m) { var row = e.target.closest("[data-mode-id]"); if (row) handleModeAct(row.dataset.modeId, m.dataset.modeAct); return; }
    var s = e.target.closest("[data-set-act]");
    if (s) { handleSetAct(s.dataset.setAct); return; }
    var p = e.target.closest("[data-paste-act]");
    if (p) { handlePasteRecord(); return; }
  }
  function onModalChange(e) {
    if (e.target.id === "importFile" && e.target.files && e.target.files[0]) {
      importFromFile(e.target.files[0]);
    }
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
        var wins = gameTimesPlayed(g.id), losses = gameLosses(g.id), avg = gameAvgGuesses(g.id);
        return '<div class="detail-gamestats">' +
          '<div class="gs-tile"><b>🔥 ' + gs + '</b><span>Current streak</span></div>' +
          '<div class="gs-tile"><b>🏆 ' + gameLongestStreak(g.id) + '</b><span>Best streak</span></div>' +
          '<div class="gs-tile"><b>' + wins + " / " + losses + '</b><span>Solved / failed</span></div>' +
          '<div class="gs-tile"><b>' + (wins + losses ? winRate(wins, losses) + "%" : "–") + '</b><span>Win rate</span></div>' +
          '<div class="gs-tile"><b>' + (avg != null ? avg : "–") + '</b><span>Avg guesses</span></div>' +
        "</div>";
      })() +
      '<div class="detail-actions">' +
        '<button class="btn btn-primary" data-detail-act="play">▶ Play</button>' +
        '<button class="btn' + (fav ? " on" : "") + '" data-detail-act="fav">' + (fav ? "★ Favorited" : "☆ Favorite") + "</button>" +
        '<button class="btn' + (done ? " on-done" : "") + '" data-detail-act="done">' + (done ? "✓ Solved today" : "Mark solved") + "</button>" +
        '<button class="btn' + (failed ? " on-fail" : "") + '" data-detail-act="fail">' + (failed ? "✗ Failed today" : "Mark failed") + "</button>" +
        '<button class="btn' + (rt ? " on-routine" : "") + '" data-detail-act="routine">' + (rt ? "🎯 In routine" : "🎯 Add to routine") + "</button>" +
      "</div>" +
      (function () {
        var gd = gameGuessDistribution(g.id);
        var body = gd.total
          ? distBarsHtml(gd, gd.total + " solves recorded")
          : '<p class="stats-empty">No guesses recorded yet — captured automatically when you share this game (or add one below).</p>';
        var todayG = guessToday(g.id);
        var entry =
          '<div class="guess-entry">' +
            '<label for="guessInput">Guesses today</label>' +
            '<input type="number" min="1" max="20" step="1" id="guessInput" class="guess-input" placeholder="e.g. 4" value="' + (todayG || "") + '">' +
            '<button class="btn" data-detail-act="logguess">Save</button>' +
          "</div>" +
          '<div class="detail-paste">' +
            '<textarea id="detailPaste" class="paste-input" rows="2" placeholder="…or paste this game\'s Share text — reads solved/failed + guesses"></textarea>' +
            '<div class="settings-row"><button class="btn" data-detail-act="pasteHere">Record from paste</button></div>' +
            '<p class="import-result" id="detailPasteMsg"></p>' +
          "</div>";
        return '<h3 class="stats-h">Guess distribution</h3>' + body + entry;
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
        : "")
    );
  }
  function openDetail(id) {
    var g = gameById[id] || DATA.find(function (x) { return x.id === id; });
    if (!g) return;
    currentDetailId = id;
    currentHubId = null;
    showModal(g.name, detailBody(g));
  }
  function refreshDetail() {
    var g = DATA.find(function (x) { return x.id === currentDetailId; });
    if (!g || !genericModal) return;
    modalBody().innerHTML = detailBody(g);
  }
  function handleDetailAct(act) {
    var id = currentDetailId;
    if (act === "play") {
      var g = DATA.find(function (x) { return x.id === id; });
      hideModal();
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
    } else if (act === "logguess") {
      var input = document.getElementById("guessInput");
      var n = input ? parseInt(input.value, 10) : NaN;
      if (n >= 1) { markDoneToday(id); setGuessToday(id, n); patchCard(id); }
    } else if (act === "routine") {
      toggleRoutine(id);
      if (prefs.routineOnly) render();
    } else if (act === "pasteHere") {
      var ta = document.getElementById("detailPaste");
      var pr = ta && parseShareText(ta.value);
      if (!pr) {
        var m = document.getElementById("detailPasteMsg");
        if (m) m.textContent = "That doesn't look like a game result — paste the game's Share text.";
        return; // keep the box + message (don't refresh)
      }
      if (pr.solved) { markDoneToday(id); if (pr.guesses) setGuessToday(id, pr.guesses); }
      else markFailedToday(id);
      patchCard(id);
      if (prefs.completion !== "all" || prefs.routineOnly || prefs.favOnly) render();
    }
    refreshDetail();
  }

  // ---------- hub (multi-mode) detail modal ----------
  function modeRow(g) {
    var fav = favorites.has(g.id), done = isDoneToday(g.id), failed = isFailedToday(g.id), rt = inRoutine(g.id), gs = gameStreak(g.id);
    var col = colorFor(g.category);
    var fIco = faviconUrl(g.url);
    var ico = fIco ? '<img class="mode-ico" src="' + fIco + '" alt="">' : '<span class="mode-ico" style="background:' + col + '"></span>';
    return (
      '<div class="mode-row' + (done ? " is-done" : "") + (failed ? " is-failed" : "") + '" data-mode-id="' + g.id + '">' +
        ico +
        '<div class="mode-info"><span class="mode-name">' + escapeHtml(g.name) + "</span>" +
          '<span class="mode-sub">' + escapeHtml(g.category) + (gs >= 1 ? " · 🔥 " + gs : "") +
          (guessToday(g.id) ? " · " + guessToday(g.id) + " guesses" : "") + "</span></div>" +
        '<button class="act-btn mode-fav' + (fav ? " on" : "") + '" data-mode-act="fav" title="' + (fav ? "Unfavorite" : "Favorite") + '" aria-pressed="' + fav + '">' + (fav ? "★" : "☆") + "</button>" +
        '<button class="act-btn mode-routine' + (rt ? " on-routine" : "") + '" data-mode-act="routine" title="' + (rt ? "In routine" : "Add to routine") + '">🎯</button>' +
        '<button class="act-btn mode-fail' + (failed ? " on-fail" : "") + '" data-mode-act="fail" title="Mark failed today">✗</button>' +
        '<button class="act-btn mode-done' + (done ? " on-done" : "") + '" data-mode-act="done" title="Mark solved today">' + (done ? "✓" : "Solve") + "</button>" +
        '<button class="btn btn-primary mode-play" data-mode-act="play" title="Play ' + escapeHtml(g.name) + '">▶</button>' +
      "</div>"
    );
  }
  function hubDetailBody(hub) {
    var col = hub.category === "Various" ? "#64748b" : colorFor(hub.category);
    var n = hub.members.length, doneN = itemDoneCount(hub);
    return (
      '<div class="detail-hero" style="background:linear-gradient(135deg,' + col + ",color-mix(in srgb," + col + ' 55%, #000))">' +
        '<span class="detail-ico detail-fallback" style="background:rgba(0,0,0,.25)">' + escapeHtml((hub.name[0] || "?").toUpperCase()) + "</span>" +
        '<div class="detail-hero-txt"><span class="detail-cat">' + n + " modes · " + escapeHtml(hub.host) + "</span>" +
          '<span class="detail-streak">✓ ' + doneN + "/" + n + " done today</span></div>" +
      "</div>" +
      '<p class="settings-note">Each mode tracks its own streak, favorite and daily completion.</p>' +
      '<div class="mode-list">' + hub.members.map(modeRow).join("") + "</div>"
    );
  }
  function openHubDetail(hub) {
    if (!hub) return;
    currentHubId = hub.id;
    currentDetailId = null;
    showModal(hub.name, hubDetailBody(hub));
  }
  function refreshHubDetail() {
    var hub = itemById[currentHubId];
    if (!hub || !genericModal) return;
    modalBody().innerHTML = hubDetailBody(hub);
  }
  function handleModeAct(id, act) {
    var g = gameById[id];
    if (!g) return;
    if (act === "play") { hideModal(); openGame(g.url, g.id); return; }
    if (act === "fav") {
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      saveFavorites();
    } else if (act === "done") {
      if (isDoneToday(id)) unmarkDoneToday(id); else markDoneToday(id);
    } else if (act === "fail") {
      if (isFailedToday(id)) clearFailToday(id); else markFailedToday(id);
    } else if (act === "routine") {
      toggleRoutine(id);
    }
    refreshHubDetail();
    // reflect on the grid: re-render if a filter could change membership, else patch the hub card
    if (prefs.favOnly || prefs.routineOnly || prefs.completion !== "all" || prefs.sort === "fav") render();
    else patchCard(currentHubId);
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
        Object.keys(incoming).forEach(function (id) { if (day[id] == null) day[id] = incoming[id]; });
      });
      saveGuesses();
    }
    if (Array.isArray(obj.routine)) {
      obj.routine.forEach(function (id) { if (routine.indexOf(id) === -1) routine.push(id); });
      saveRoutine();
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
  function openSettings() { currentDetailId = null; currentHubId = null; showModal("Settings & backup", settingsBody()); }

  // ---------- paste-a-result modal ----------
  function parseShareText(text) {
    if (!text || text.length > 5000) return null;
    var grid = /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(text);
    var frac = text.match(/(^|\s)(\d{1,2}|X|x)\s*\/\s*(\d{1,2})(\s|$)/);
    if (!frac && !grid) return null;
    var solved, gc = null;
    if (frac) {
      var a = frac[2];
      if (/x/i.test(a)) { solved = false; }
      else { solved = true; gc = parseInt(a, 10) || null; }
    } else {
      solved = true;
      gc = text.split("\n").filter(function (ln) { return /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(ln); }).length || null;
    }
    return { solved: solved, guesses: gc, nameHint: extractNameHint(text) };
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
  function pastePreview(text) {
    var p = parseShareText(text);
    var el = document.getElementById("pastePreview");
    if (!el) return;
    if (!text.trim()) { el.textContent = ""; return; }
    if (!p) { el.textContent = "🤔 Doesn't look like a game result yet."; return; }
    var g = matchGameByName(p.nameHint);
    if (!g) { el.textContent = '⚠️ Parsed ' + (p.solved ? "a solve" : "a fail") + ", but couldn't match a game from “" + p.nameHint + "”."; return; }
    el.textContent = "→ " + g.name + " · " + (p.solved ? "solved" + (p.guesses ? " in " + p.guesses : "") : "failed");
  }
  function handlePasteRecord() {
    var ta = document.getElementById("pasteInput");
    var msg = document.getElementById("pasteMsg");
    var p = ta && parseShareText(ta.value);
    if (!p) { if (msg) msg.textContent = "That doesn't look like a game's share text."; return; }
    var g = matchGameByName(p.nameHint);
    if (!g) { if (msg) msg.textContent = 'Couldn\'t match a game from “' + p.nameHint + "”. Open it in the hub and log it from its ⓘ."; return; }
    removePending(g.id);
    if (p.solved) { markDoneToday(g.id); if (p.guesses) setGuessToday(g.id, p.guesses); }
    else markFailedToday(g.id);
    render();
    if (msg) msg.textContent = "Recorded ✓ " + g.name + " — " + (p.solved ? "solved" + (p.guesses ? " in " + p.guesses : "") : "failed") + ".";
    if (ta) ta.value = "";
    pastePreview("");
  }
  function pasteBody() {
    return (
      '<p class="settings-note">Finished a game? Hit its <b>Share</b> button, then paste the copied text here — ' +
      "the hub reads whether you solved it and in how many guesses, and matches the game by name.</p>" +
      '<textarea id="pasteInput" class="paste-input" rows="4" placeholder="e.g.  Wordle 1,234 4/6&#10;🟩🟨⬛⬛⬛&#10;🟩🟩🟩🟩🟩"></textarea>' +
      '<p id="pastePreview" class="paste-preview"></p>' +
      '<div class="settings-row"><button class="btn btn-primary" data-paste-act="record">Record result</button></div>' +
      '<p class="import-result" id="pasteMsg"></p>'
    );
  }
  function openPaste() {
    currentDetailId = null; currentHubId = null;
    showModal("Paste a result", pasteBody());
    var ta = document.getElementById("pasteInput");
    if (ta) { ta.addEventListener("input", function () { pastePreview(ta.value); }); ta.focus(); }
  }

  // ---------- keyboard shortcuts ----------
  document.addEventListener("keydown", function (e) {
    var t = e.target, tag = (t.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
    if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (e.key === "Escape" && t === searchEl) { searchEl.blur(); return; }
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
      if (payload.guesses > 0) setGuessToday(g.id, payload.guesses);
    } else {
      markFailedToday(g.id);
    }
    // refresh UI
    if (currentHubId && itemById[currentHubId] && hubIdOfMember[g.id] === currentHubId) refreshHubDetail();
    if (currentDetailId === g.id) refreshDetail();
    render();
    return { matched: true, name: g.name, solved: !!payload.solved, guesses: payload.guesses || null };
  }

  grid.addEventListener("click", function (e) {
    var card = e.target.closest(".card");
    if (!card) return;
    var id = card.dataset.id;

    // hub card → open its list of modes
    if (id.indexOf("hub:") === 0) { openHubDetail(itemById[id]); return; }

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
      var id = card.dataset.id;
      if (id.indexOf("hub:") === 0) openHubDetail(itemById[id]);
      else openGame(card.dataset.url, id);
    }
  });

  // Replace one card in place (keeps scroll position on toggle).
  // A hub member's change repaints its hub card.
  function patchCard(id) {
    var targetId = hubIdOfMember[id] || id;
    var g = itemById[targetId];
    if (!g) return;
    var old = grid.querySelector('.card[data-id="' + CSS.escape(targetId) + '"]');
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
  syncControls();
  buildChips();
  render();
  checkImportHash();
  // If you opened a game earlier today and reloaded the hub, ask on load too.
  if (document.visibilityState === "visible") setTimeout(processPending, 500);
})();
