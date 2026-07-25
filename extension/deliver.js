// Content script on the DLE Hub page only. Delivers queued results into the page
// (the hub listens for these messages and records them), then clears the queue.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;
  api.storage.local.get({ queue: [] }, function (o) {
    var q = o.queue || [];
    if (!q.length) return;
    q.forEach(function (entry) {
      window.postMessage({
        source: "dle-extension",
        payload: { host: entry.host, name: entry.name, solved: entry.solved, guesses: entry.guesses },
      }, location.origin);
    });
    api.storage.local.set({ queue: [] });
  });
})();
