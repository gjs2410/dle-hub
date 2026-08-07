// Content script (isolated world) on every page.
// Injects page-hook.js + game-detect.js, receives captured share text / auto-detected
// results, parses them, and queues in extension storage for delivery to the hub.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;

  function injectScript(file) {
    try {
      var s = document.createElement("script");
      s.src = api.runtime.getURL(file);
      (document.head || document.documentElement).appendChild(s);
      s.onload = function () { s.remove(); };
    } catch (e) {}
  }

  injectScript("page-hook.js");
  injectScript("game-detect.js");

  function parseShare(text) {
    if (!text || text.length > 4000) return null;
    var grid = /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(text);
    var frac = text.match(/(^|\s)(\d{1,2}|X|x)\s*\/\s*(\d{1,2})(\s|$)/);
    if (!frac && !grid) return null;
    if (frac) {
      var a = frac[2];
      if (/x/i.test(a)) return { solved: false, guesses: null };
      return { solved: true, guesses: parseInt(a, 10) || null };
    }
    var rows = text.split("\n").filter(function (ln) {
      return /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(ln);
    }).length;
    return { solved: true, guesses: rows || null };
  }

  function queueEntry(entry) {
    api.storage.local.get({ queue: [] }, function (o) {
      var q = o.queue || [];
      var sig = entry.host + "|" + entry.solved + "|" + (entry.guesses || "") + "|" + (entry.resultType || "") + "|" + (entry.source || "");
      var dupe = q.some(function (e) {
        return e.host === entry.host && e.solved === entry.solved &&
          (e.guesses || null) === (entry.guesses || null) &&
          Date.now() - (e.ts || 0) < 3600000;
      });
      if (dupe) return;
      q.push(entry);
      if (q.length > 100) q = q.slice(-100);
      api.storage.local.set({ queue: q });
    });
  }

  function makeEntry(res, extra) {
    extra = extra || {};
    return {
      host: location.host.replace(/^www\./, ""),
      name: (document.title || "").split(/[|\-–—:•·]/)[0].trim().slice(0, 60),
      solved: res.solved,
      guesses: res.guesses,
      resultType: res.resultType || (res.guesses != null ? "guesses" : undefined),
      value: res.value != null ? res.value : res.guesses,
      source: res.source || extra.source || "share",
      ts: Date.now(),
    };
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;

    if (d && d.__dleResult === true && d.payload) {
      var p = d.payload;
      if (typeof p.solved !== "boolean") return;
      queueEntry(makeEntry(p, { source: p.source || "detect" }));
      return;
    }

    if (!d || d.__dleShare !== true) return;
    var res = parseShare(d.text);
    if (!res) return;
    queueEntry(makeEntry(res, { source: "share" }));
  });
})();
