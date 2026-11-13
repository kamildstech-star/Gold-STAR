// Run with: node supabase/tests/remove-proposal-sent-stage.pglite.mjs <existing PGlite dist/index.js>
// In-memory fixtures only. No connection string, network access or live writes.
//
// Migration 20261108120000 (READ FROM THE FILE) takes "Proposal sent" off the
// pipelines: the cards on it go back to the stage before it, a health pointer
// at it is cleared, the stage is deleted, the later stages close the gap, and
// a second run changes nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const sql = readFileSync(
  new URL("../migrations/20261108120000_remove_proposal_sent_stage.sql", import.meta.url),
  "utf8",
);

await db.exec(`
  CREATE TABLE public.pipeline_stages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id uuid NOT NULL, key text NOT NULL, name text NOT NULL,
    sort_order int NOT NULL, is_won boolean NOT NULL DEFAULT false,
    is_lost boolean NOT NULL DEFAULT false
  );
  CREATE TABLE public.accounts (
    id serial PRIMARY KEY, stage text,
    stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT,
    health_stage_id uuid REFERENCES public.pipeline_stages(id)
  );
  CREATE TABLE public.jobs (
    id serial PRIMARY KEY,
    stage_id uuid REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT
  );
  CREATE FUNCTION sync_stage() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    SELECT key INTO NEW.stage FROM public.pipeline_stages WHERE id = NEW.stage_id;
    RETURN NEW;
  END $$;
  CREATE TRIGGER t BEFORE INSERT OR UPDATE ON public.accounts
    FOR EACH ROW EXECUTE FUNCTION sync_stage();

  INSERT INTO public.pipeline_stages (pipeline_id, key, name, sort_order, is_won) VALUES
    ('22222222-2222-4222-8222-222222222222', 'ready', 'Ready', 10, false),
    ('22222222-2222-4222-8222-222222222222', 'conversation_established', 'Conversation Established', 30, false),
    ('22222222-2222-4222-8222-222222222222', 'proposal_sent', 'Proposal sent', 40, false),
    ('22222222-2222-4222-8222-222222222222', 'active_client', 'Active Client', 50, true),
    ('11111111-1111-4111-8111-111111111111', 'meeting_held', 'Meeting held', 60, false),
    ('11111111-1111-4111-8111-111111111111', 'proposal_sent', 'Proposal sent', 70, false),
    ('11111111-1111-4111-8111-111111111111', 'vendor_onboarding', 'Vendor onboarding', 80, false);
  INSERT INTO public.accounts (stage_id, health_stage_id)
    SELECT id, id FROM public.pipeline_stages WHERE key = 'proposal_sent';
  INSERT INTO public.accounts (stage_id)
    SELECT id FROM public.pipeline_stages WHERE key = 'ready';
`);

await db.exec(sql);

const rows = async (q) => (await db.query(q)).rows;

assert.equal((await rows(`SELECT 1 FROM pipeline_stages WHERE key = 'proposal_sent'`)).length, 0);
assert.deepEqual(
  (await rows(`SELECT stage, health_stage_id FROM accounts ORDER BY id`)).map((r) => [
    r.stage,
    r.health_stage_id,
  ]),
  [
    ["conversation_established", null],
    ["meeting_held", null],
    ["ready", null],
  ],
);
assert.deepEqual(
  (await rows(`SELECT key, sort_order FROM pipeline_stages ORDER BY pipeline_id, sort_order`)).map(
    (r) => `${r.key}:${r.sort_order}`,
  ),
  ["meeting_held:60", "vendor_onboarding:70", "ready:10", "conversation_established:30", "active_client:40"],
);

await db.exec(sql); // a second run is a no-op
assert.equal((await rows(`SELECT count(*)::int AS n FROM pipeline_stages`))[0].n, 5);

console.log("remove-proposal-sent-stage: ok");
