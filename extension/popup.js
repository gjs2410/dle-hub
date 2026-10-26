// Popup: whether the hub is reachable, what the current page is, and the last captured
// results with their delivery status. Everything shown comes from extension storage
// (written by capture.js / deliver.js). Page-derived text (titles, hosts) is only ever set
// via textContent, never parsed as HTML.
(function () {
  var api = (typeof browser !== "undefined") ? browser : chrome;
  var DEFAULT_HUB = "http://localhost:8777/";
  var $ = function (id) { return document.getElementById(id); };

  $("version").textContent = "v" + api.runtime.getManifest().version;

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + " h ago";
    var d = Math.round(h / 24);
    return d === 1 ? "yesterday" : d + " days ago";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderStatus(o) {
    var box = $("status");
    var waiting = (o.queue || []).length;
    var recent = o.hubSeen && Date.now() - o.hubSeen < 10 * 60 * 1000;
    var title, sub, ok;
    if (waiting) {
      ok = false;
      title = waiting + " result" + (waiting === 1 ? "" : "s") + " waiting";
      sub = "Open DLE Hub (or switch to its tab) to record " + (waiting === 1 ? "it" : "them") + ".";
    } else if (recent) {
      ok = true;
      title = "Connected to DLE Hub";
      sub = "Last seen " + ago(o.hubSeen) + ". New results are delivered within seconds.";
    } else if (o.hubSeen) {
      ok = true;
      title = "All results delivered";
      sub = "DLE Hub last seen " + ago(o.hubSeen) + ". Results wait here until you open it.";
    } else {
      ok = false;
      title = "DLE Hub not seen yet";
      sub = "Open it once so results have somewhere to go.";
    }
    box.className = "status " + (ok ? "status--ok" : "status--wait");
    box.textContent = "";
    box.appendChild(el("span", "dot"));
    var txt = el("div");
    txt.appendChild(el("b", null, title));
    txt.appendChild(el("span", null, sub));
    box.appendChild(txt);
  }

  function renderPage() {
    try {
      api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var t = tabs && tabs[0];
        if (!t || !t.url || !/^https?:/.test(t.url)) return;
        var host = new URL(t.url).host.replace(/^www\./, "");
        var p = $("page");
        p.textContent = "";
        p.appendChild(document.createTextNode("Watching "));
        p.appendChild(el("code", null, host));
        p.appendChild(document.createTextNode(" — finish the game or press Share."));
        p.hidden = false;
      });
    } catch (e) { /* tabs unavailable: just skip this line */ }
  }

  var STATUS_LABEL = { recorded: "Recorded", waiting: "Waiting", unmatched: "Not in DLE Hub" };

  function renderLog(o) {
    var log = o.log || [];
    var list = $("log");
    list.textContent = "";
    $("empty").hidden = log.length > 0;
    $("clearLog").hidden = log.length === 0;
    log.forEach(function (e) {
      var li = el("li", "row");
      li.appendChild(el("span", "mark " + (e.solved ? "mark--solved" : "mark--failed"), e.solved ? "✓" : "✕"));
      var what = el("div", "what");
      what.appendChild(el("b", null, e.game || e.name || e.host));
      var bits = [e.solved ? "Solved" + (e.detail ? " " + e.detail : (e.value != null && e.resultType === "guesses" ? " in " + e.value : "")) : "Failed"];
      bits.push(e.host);
      bits.push(ago(e.ts));
      what.appendChild(el("span", null, bits.join(" · ")));
      li.appendChild(what);
      var st = e.status || "waiting";
      li.appendChild(el("span", "tag tag--" + st, STATUS_LABEL[st] || st));
      li.title = e.source === "share" ? "Captured from the Share button" : "Spotted when the game ended";
      list.appendChild(li);
    });
  }

  function render() {
    api.storage.local.get({ log: [], queue: [], hubSeen: 0, hubUrl: "" }, function (o) {
      renderStatus(o);
      renderLog(o);
    });
  }

  $("openHub").addEventListener("click", function () {
    api.storage.local.get({ hubUrl: "" }, function (o) {
      api.tabs.create({ url: o.hubUrl || DEFAULT_HUB });
      window.close();
    });
  });
  $("clearLog").addEventListener("click", function () {
    api.storage.local.set({ log: [] }, render);
  });
  api.storage.onChanged.addListener(render); // live updates while the popup is open

  render();
  renderPage();
})();
