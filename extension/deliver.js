// Content script on the DLE Hub page. Delivers queued results into the page
// (the hub listens for these messages and records them), then clears the queue.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;

  function deliver() {
    if (!window.DLEHub) return;
    api.storage.local.get({ queue: [] }, function (o) {
      var q = o.queue || [];
      if (!q.length) return;
      q.forEach(function (entry) {
        window.postMessage({
          source: "dle-extension",
          payload: {
            host: entry.host,
            name: entry.name,
            solved: entry.solved,
            guesses: entry.guesses,
            resultType: entry.resultType,
            value: entry.value,
          },
        }, location.origin);
      });
      api.storage.local.set({ queue: [] });
    });
  }

  deliver();
  setInterval(deliver, 4000);
  window.addEventListener("focus", deliver);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") deliver();
  });
})();
