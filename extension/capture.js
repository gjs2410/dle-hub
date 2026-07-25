// Content script (isolated world) on every page.
// Injects page-hook.js, receives captured share text, parses it into a result,
// and queues it in extension storage for delivery to the hub.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;

  // inject the page-world hook
  try {
    var s = document.createElement("script");
    s.src = api.runtime.getURL("page-hook.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { s.remove(); };
  } catch (e) {}

  // Parse a Wordle-style share string into { solved, guesses }.
  // Returns null if the text doesn't look like a -dle result.
  function parseShare(text) {
    if (!text || text.length > 4000) return null;
    var grid = /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(text); // 🟩🟨⬛⬜🟦🟧🟥🟪
    var frac = text.match(/(^|\s)(\d{1,2}|X|x)\s*\/\s*(\d{1,2})(\s|$)/);
    if (!frac && !grid) return null;
    if (frac) {
      var a = frac[2];
      if (/x/i.test(a)) return { solved: false, guesses: null };
      return { solved: true, guesses: parseInt(a, 10) || null };
    }
    // Only an emoji grid, no "n/m": best-effort — assume solved, guesses = grid rows.
    var rows = text.split("\n").filter(function (ln) {
      return /[🟩🟨⬛⬜🟦🟧🟥🟪]/.test(ln);
    }).length;
    return { solved: true, guesses: rows || null };
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__dleShare !== true) return;
    var res = parseShare(d.text);
    if (!res) return;
    var entry = {
      host: location.host.replace(/^www\./, ""),
      name: (document.title || "").split(/[|\-–—:•·]/)[0].trim().slice(0, 60),
      solved: res.solved,
      guesses: res.guesses,
      ts: Date.now(),
    };
    api.storage.local.get({ queue: [] }, function (o) {
      var q = o.queue || [];
      q.push(entry);
      if (q.length > 100) q = q.slice(-100);
      api.storage.local.set({ queue: q });
    });
  });
})();
