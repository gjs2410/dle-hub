// Content script on the DLE Hub page. Tells the hub the tracker is installed, delivers
// queued results into the page (the hub listens for these messages and records them),
// then clears the queue.
//
// Content scripts run in an isolated world: they share the page's DOM but not its JS
// globals (window.DLEHub is invisible from here in both Chrome and Firefox), so everything
// goes through window.postMessage. The hub pings on load ("dle-hub" / ping) and this script
// answers with a hello, so whichever side loads first, the handshake still happens.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;
  var version = (api.runtime.getManifest && api.runtime.getManifest().version) || "";
  // A file:// page's origin is the string "null", which postMessage rejects as a target.
  var target = location.origin && location.origin !== "null" ? location.origin : "*";
  var hubReady = false;

  function post(msg) {
    try { window.postMessage(msg, target); } catch (e) {}
  }

  // Lets the hub show "Auto-tracking on" instead of its install prompt.
  function hello() {
    post({ source: "dle-extension", hello: true, version: version });
  }

  function deliver() {
    if (!hubReady) return; // the hub's listener isn't up yet — results would be lost
    api.storage.local.get({ queue: [] }, function (o) {
      var q = o.queue || [];
      if (!q.length) return;
      q.forEach(function (entry) {
        post({
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
        });
      });
      api.storage.local.set({ queue: [] });
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.source !== "dle-hub") return;
    if (e.data.ping) {
      var first = !hubReady;
      hubReady = true;
      if (first) hello(); // the hub answers only its first hello, so this can't ping-pong
      deliver();
    }
  });

  hello();
  setTimeout(hello, 1500);
  setInterval(deliver, 4000);
  window.addEventListener("focus", deliver);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") deliver();
  });
})();
