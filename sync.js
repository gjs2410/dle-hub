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
      if (e.target.closest("#pwSignIn")) passwordSignIn();
      if (e.target.closest("#pwSignUp")) passwordSignUp();
      if (e.target.closest("#magicBtn")) sendMagicLink();
      if (e.target.closest("#setPw")) setPassword();
      if (e.target.closest("#syncSignOut")) supabase.auth.signOut();
    });
    // Enter key in the password field submits sign-in
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.closest("#syncPassword")) passwordSignIn();
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
        '<h3 class="stats-h">Password</h3>' +
        '<p class="settings-note">Set (or change) a password so you can log in on new devices instantly, without waiting for an email.</p>' +
        '<div class="sync-fields"><input type="password" id="setPwInput" class="sync-email" placeholder="New password (6+ characters)" autocomplete="new-password"></div>' +
        '<div class="settings-row"><button class="btn" id="setPw">Set password</button></div>' +
        '<p class="import-result" id="syncMsg"></p>' +
        '<div class="settings-row" style="margin-top:16px"><button class="btn" id="syncSignOut">Sign out</button></div>';
    } else {
      body.innerHTML =
        '<h3 class="stats-h">Cloud sync</h3>' +
        '<p class="settings-note">Sign in to sync your streaks, done games and favorites across ' +
        "devices. You stay signed in on this device afterward — no need to log in every time.</p>" +
        '<div class="sync-fields">' +
          '<input type="email" id="syncEmail" class="sync-email" placeholder="you@example.com" autocomplete="email">' +
          '<input type="password" id="syncPassword" class="sync-email" placeholder="Password (6+ characters)" autocomplete="current-password">' +
        "</div>" +
        '<div class="settings-row">' +
          '<button class="btn btn-primary" id="pwSignIn">Sign in</button>' +
          '<button class="btn" id="pwSignUp">Create account</button>' +
        "</div>" +
        '<p class="import-result" id="syncMsg"></p>' +
        '<button class="link-btn magic-alt" id="magicBtn">Prefer no password? Email me a magic link instead</button>';
    }
  }
  function openModal() { ensureModal(); renderModal(); modal.classList.add("show"); }
  function hideModal() { if (modal) modal.classList.remove("show"); }
  function setMsg(t) { const m = document.getElementById("syncMsg"); if (m) m.textContent = t; }

  function fieldVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function validEmail(e) { return e && e.indexOf("@") > 0; }

  async function passwordSignIn() {
    const email = fieldVal("syncEmail"), pw = fieldVal("syncPassword");
    if (!validEmail(email) || !pw) { setMsg("Enter your email and password."); return; }
    setMsg("Signing in…");
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    // On success, onAuthStateChange updates the UI + pulls your data.
    if (error) setMsg("Sign-in failed: " + error.message + ". New here? Tap “Create account”.");
  }

  async function passwordSignUp() {
    const email = fieldVal("syncEmail"), pw = fieldVal("syncPassword");
    if (!validEmail(email)) { setMsg("Enter a valid email."); return; }
    if (!pw || pw.length < 6) { setMsg("Password must be at least 6 characters."); return; }
    setMsg("Creating account…");
    const { data, error } = await supabase.auth.signUp({
      email, password: pw,
      options: { emailRedirectTo: location.href.split("#")[0] },
    });
    if (error) { setMsg("Sign-up failed: " + error.message); return; }
    if (data.session) setMsg("Account created — you're signed in ✓");
    else setMsg("Account created ✓ Check your email once to confirm, then tap Sign in.");
  }

  async function setPassword() {
    const pw = fieldVal("setPwInput");
    if (!pw || pw.length < 6) { setMsg("Password must be at least 6 characters."); return; }
    setMsg("Saving…");
    const { error } = await supabase.auth.updateUser({ password: pw });
    setMsg(error ? "Error: " + error.message : "Password set ✓ You can now sign in with it on other devices.");
  }

  async function sendMagicLink() {
    const email = fieldVal("syncEmail");
    if (!validEmail(email)) { setMsg("Enter a valid email first."); return; }
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
