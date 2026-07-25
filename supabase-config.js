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
  url: "https://pazahsfecpzhbpoehmbm.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhemFoc2ZlY3B6aGJwb2VobWJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODM3NzUsImV4cCI6MjEwMDU1OTc3NX0._Dmuxrwx1_2bMiP4rtGRNojQon9zvaROYigFEAKUo9g",
};
