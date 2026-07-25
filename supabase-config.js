// ---------------------------------------------------------------------------
// Cloud sync configuration (optional).
//
// Leave these blank and the app works exactly as before — everything stays
// local to your device, and the account button is hidden.
//
// To enable accounts + cross-device sync, paste YOUR Supabase project values:
//   Supabase dashboard → Project Settings → API
//     • url     = "Project URL"      (e.g. https://abcdefgh.supabase.co)
//     • anonKey = "anon public" key  (a long token starting with "eyJ...")
//
// The anon key is SAFE to put here and commit — it's designed to be public and
// your data is protected by Row-Level Security. NEVER put the "service_role"
// key here; that one is secret.
// ---------------------------------------------------------------------------
window.SUPABASE_CONFIG = {
  url: "",
  anonKey: "",
};
