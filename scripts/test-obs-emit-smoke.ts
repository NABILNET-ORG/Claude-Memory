import { supabase } from "../src/supabase.js";

async function main() {
  const sb = supabase;
  const { data, error } = await sb
    .from("daemon_telemetry")
    .select("id, project_id, daemon, event_type, payload, created_at")
    .limit(1);
  if (error) throw new Error(`schema check failed: ${error.message}`);
  console.log("ok: daemon_telemetry schema reachable, sample rows:", data?.length ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
