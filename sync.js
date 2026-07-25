// Cloud accounts + sync via Supabase (optional; enabled by supabase-config.js).
// Passwordless magic-link sign-in. On sign-in, remote state is MERGED into local
// (union — never deletes), then the merged union is pushed back so every device
// converges. Local changes push (debounced) while signed in.

const cfg = window.SUPABASE_CONFIG || {};
const btn = document.getElementById("accountBtn");

if (!cfg.url || !cfg.anonKey) {
  // Not configured — hide the account button; app stays fully local.
  if (btn) btn.style.display = "none";
} else {
  import("https://esm.sh/@supabase/supabase-js@2")
    .then(({ createClient }) => initSync(createClient))
    .catch((e) => {
      console.warn("Cloud sync unavailable:", e.message);
      if (btn) btn.title = "Cloud sync unavailable (offline?)";
    });
}

function initSync(createClient) {
  const supabase = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let user = null;
  let pushTimer = null;
  let modal = null;

  const getState = () => (window.DLEHub ? window.DLEHub.getState() : null);

  async function pull() {
    if (!user) return;
    const { data, error } = await supabase
      .from("user_state").select("favorites,history").eq("user_id", user.id).maybeSingle();
    if (error) { setMsg("Sync error: " + error.message); return; }
    if (data && window.DLEHub) {
      window.DLEHub.applyRemote({ favorites: data.favorites || [], history: data.history || {} });
    }
    await push(true); // upload the merged union so remote has everything too
  }

  function push(immediate) {
    if (!user) return Promise.resolve();
    clearTimeout(pushTimer);
    const doPush = async () => {
      const s = getState();
      if (!s) return;
      const { error } = await supabase.from("user_state").upsert({
        user_id: user.id,
        favorites: s.favorites || [],
        history: s.history || {},
        updated_at: new Date().toISOString(),
      });
      if (error) console.warn("sync push:", error.message);
      updateBtn();
    };
    if (immediate) return doPush();
    pushTimer = setTimeout(doPush, 1500);
    return Promise.resolve();
  }

  function onAuth(justSignedIn) {
    window.__dleOnDirty = user ? () => push(false) : null;
    updateBtn();
    if (modal && modal.classList.contains("show")) renderModal();
    if (justSignedIn) pull();
  }

  function updateBtn() {
    if (!btn) return;
    btn.textContent = user ? "🟢" : "👤";
    btn.title = user ? "Synced as " + user.email : "Sign in to sync across devices";
  }

  // ---- auth wiring ----
  supabase.auth.getSession().then(({ data }) => {
    user = (data.session && data.session.user) || null;
    onAuth(!!user); // pull on load if already signed in
  });
  supabase.auth.onAuthStateChange((event, session) => {
    const prevId = user && user.id;
    user = (session && session.user) || null;
    onAuth(event === "SIGNED_IN" && user && user.id !== prevId);
  });

  // ---- account modal ----
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Account">' +
        '<div class="modal-head"><h2>Account &amp; sync</h2><button class="modal-close" aria-label="Close">✕</button></div>' +
        '<div class="modal-body"></div>' +
      "</div>";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.closest(".modal-close")) hideModal();
      const si = e.target.closest("#syncSignIn");
      const so = e.target.closest("#syncSignOut");
      if (si) signIn();
      if (so) supabase.auth.signOut();
    });
    return modal;
  }
  function renderModal() {
    const body = ensureModal().querySelector(".modal-body");
    if (user) {
      body.innerHTML =
        '<h3 class="stats-h">Cloud sync</h3>' +
        '<p class="settings-note">Signed in as <b>' + esc(user.email) + "</b>. " +
        "Your streaks, done games and favorites sync automatically across your devices. ✓</p>" +
        '<div class="settings-row"><button class="btn" id="syncSignOut">Sign out</button></div>';
    } else {
      body.innerHTML =
        '<h3 class="stats-h">Cloud sync</h3>' +
        '<p class="settings-note">Sign in with your email to sync your streaks, done games and ' +
        "favorites across all your devices. We'll email you a magic link — no password.</p>" +
        '<div class="settings-row">' +
          '<input type="email" id="syncEmail" class="sync-email" placeholder="you@example.com" autocomplete="email">' +
          '<button class="btn btn-primary" id="syncSignIn">Send magic link</button>' +
        "</div>" +
        '<p class="import-result" id="syncMsg"></p>';
    }
  }
  function openModal() { ensureModal(); renderModal(); modal.classList.add("show"); }
  function hideModal() { if (modal) modal.classList.remove("show"); }
  function setMsg(t) { const m = document.getElementById("syncMsg"); if (m) m.textContent = t; }

  async function signIn() {
    const input = document.getElementById("syncEmail");
    const email = input && input.value.trim();
    if (!email || email.indexOf("@") === -1) { setMsg("Please enter a valid email."); return; }
    setMsg("Sending…");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.href.split("#")[0] },
    });
    setMsg(error ? "Error: " + error.message : "Check your inbox for the magic link ✉️");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  if (btn) { btn.style.display = ""; btn.addEventListener("click", openModal); }
}
