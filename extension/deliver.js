// Content script on the DLE Hub page. Tells the hub the tracker is installed, delivers
// queued results into the page (the hub listens for these messages and records them),
// then clears the queue.
//
// Content scripts run in an isolated world: they share the page's DOM but not its JS
// globals (window.DLEHub is invisible from here in both Chrome and Firefox), so everything
// goes through window.postMessage. The hub pings on load ("dle-hub" / ping) and this script
// answers with a hello, so whichever side loads first, the handshake still happens. The hub
// acks each delivered result, which updates the popup's log.
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
            logId: entry.logId,
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

  // The hub's answer for one delivered result -> that entry's status in the popup's log.
  function applyAck(ack) {
    if (!ack || !ack.logId) return;
    api.storage.local.get({ log: [] }, function (o) {
      var log = (o.log || []).map(function (e) {
        if (e.logId !== ack.logId) return e;
        e.status = ack.matched ? "recorded" : "unmatched";
        if (ack.name) e.game = ack.name;
        if (ack.matched) { e.solved = ack.solved; e.detail = ack.detail || ""; }
        return e;
      });
      api.storage.local.set({ log: log });
    });
  }

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.source !== "dle-hub") return;
    if (e.data.ping) {
      var first = !hubReady;
      hubReady = true;
      // Remembered for the popup: when the hub was last seen and where it lives.
      api.storage.local.set({ hubSeen: Date.now(), hubUrl: location.origin + location.pathname });
      if (first) hello(); // the hub answers only its first hello, so this can't ping-pong
      deliver();
    }
    if (e.data.ack) applyAck(e.data.ack);
  });

  // Also mark the page itself: the DOM is shared with the page, so the hub can see this
  // even where a browser treats content-script messages differently (Firefox).
  try { document.documentElement.setAttribute("data-dle-tracker", version || "1"); } catch (e) {}

  hello();
  setTimeout(hello, 1500);
  setInterval(deliver, 4000);
  window.addEventListener("focus", deliver);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") deliver();
  });
})();
