// Content script on the DLE Hub page. Tells the hub the tracker is installed, delivers
// queued results into the page (the hub listens for these messages and records them),
// then clears the queue.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;
  var version = (api.runtime.getManifest && api.runtime.getManifest().version) || "";

  // Lets the hub show "Auto-tracking on" instead of its install prompt.
  function hello() {
    window.postMessage({ source: "dle-extension", hello: true, version: version }, location.origin);
  }

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
            path: entry.path,
            name: entry.name,
            solved: entry.solved,
            guesses: entry.guesses,
            resultType: entry.resultType,
            value: entry.value,
            text: entry.text,
          },
        }, location.origin);
      });
      api.storage.local.set({ queue: [] });
    });
  }

  hello();
  setTimeout(hello, 1500); // in case the hub's listener wasn't attached yet
  deliver();
  setInterval(deliver, 4000);
  window.addEventListener("focus", deliver);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") deliver();
  });
})();
