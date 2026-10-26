// Content script (isolated world) on every page.
// Injects page-hook.js + game-detect.js, receives captured share text / auto-detected
// results, and queues them in extension storage for delivery to the hub.
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

  // Cheap gate so ordinary copies on ordinary sites aren't queued: the text has to look
  // like a game's share text (an emoji grid, an "n/6"-style score, a time, or result
  // wording). The hub does the real parsing with its own, richer parser.
  var SHARE_LIKE = /[🟩🟨⬛⬜🟦🟧🟥🟪🟫]|(^|\s)(\d{1,2}|X)\s*\/\s*\d{1,2}(\s|$)|\b\d{1,2}:\d{2}\b|\b(solved|guess(es)?|tries|attempts|score|points|streak|correct|failed|won|#\d{2,})\b/i;

  // Quick local read, used for de-duping and as a fallback for hubs without parseShareText.
  function parseShare(text) {
    var grid = /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(text);
    var frac = text.match(/(^|\s)(\d{1,2}|X|x)\s*\/\s*(\d{1,2})(\s|$)/);
    if (frac) {
      if (/x/i.test(frac[2])) return { solved: false, guesses: null };
      return { solved: true, guesses: parseInt(frac[2], 10) || null };
    }
    if (grid) {
      var rows = text.split("\n").filter(function (ln) { return /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(ln); }).length;
      return { solved: true, guesses: rows || null };
    }
    return { solved: !/\b(failed|lost|didn.?t get)\b/i.test(text), guesses: null };
  }

  function queueEntry(entry) {
    api.storage.local.get({ queue: [] }, function (o) {
      var q = o.queue || [];
      var dupe = q.some(function (e) {
        return e.host === entry.host && e.path === entry.path && e.solved === entry.solved &&
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
      path: location.pathname,
      name: (document.title || "").split(/[|\-–—:•·]/)[0].trim().slice(0, 60),
      solved: res.solved,
      guesses: res.guesses,
      resultType: res.resultType || (res.guesses != null ? "guesses" : undefined),
      value: res.value != null ? res.value : res.guesses,
      text: extra.text || undefined,
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
    var text = String(d.text || "");
    if (!text || text.length > 2000 || !SHARE_LIKE.test(text)) return;
    queueEntry(makeEntry(parseShare(text), { source: "share", text: text }));
  });
})();
