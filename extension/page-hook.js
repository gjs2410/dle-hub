// Runs in the PAGE's own world (injected by capture.js). Catches the moment a
// game copies its share text — either via navigator.clipboard.writeText(...) or a
// classic copy event — and forwards the text to the extension via postMessage.
(function () {
  function emit(text) {
    try { window.postMessage({ __dleShare: true, text: String(text || "") }, "*"); } catch (e) {}
  }

  // 1) Programmatic clipboard writes (most modern -dle share buttons)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (t) { emit(t); return orig(t); };
    }
  } catch (e) {}

  // 2) execCommand('copy') / manual copy of a share box
  document.addEventListener("copy", function (e) {
    try {
      var t = (e.clipboardData && e.clipboardData.getData("text")) ||
              (window.getSelection && window.getSelection().toString());
      if (t) emit(t);
    } catch (err) {}
  }, true);
})();
