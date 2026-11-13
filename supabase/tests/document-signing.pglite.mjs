// In-memory PostgreSQL only. Usage: node this-file <PGlite dist/index.js>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const migration = readFileSync(new URL('../migrations/20260908014000_atomic_document_signing.sql', import.meta.url), 'utf8');
const packet = '00000000-0000-4000-8000-000000000001';
const doc = '00000000-0000-4000-8000-000000000002';
const office = '00000000-0000-4000-8000-000000000003';
const attempt = '00000000-0000-4000-8000-000000000004';
const secondPacket = '00000000-0000-4000-8000-000000000005';
const evidence = [{ document_id: doc, name: 'Contract', rendered_body: 'Original body', requires_signature: true,
  pdf_path: `${doc}/${attempt}/signed.pdf`, signature_path: `${doc}/${attempt}/signature.png`, size_bytes: 1, hash: 'sha256' }];
const submission = { signer_name: 'Customer', field_values: {}, signed_at: new Date().toISOString(),
  packet_scope: { location_id: office, job_id: null, recipient_name: null, recipient_email: null } };
let tests = 0;
const test = async (name, fn) => { await reset(); await fn(); tests++; console.log(`PASS ${name}`); };
const call = (ev = evidence, sub = submission, pk = packet) => db.query(
  'SELECT complete_document_signing_atomic($1,$2,$3,$4,$5) AS n', ['token', pk, attempt, JSON.stringify(ev), JSON.stringify(sub)]);
const reset = async () => {
  await db.exec('RESET ROLE; TRUNCATE document_signatures, document_events, document_send_items, document_send_packets, documents, job_notes;');
  await db.query(`INSERT INTO document_send_packets(id, token, location_id, expires_at) VALUES ($1,'token',$2,now()+interval '1 day')`, [packet, office]);
  await db.query(`INSERT INTO documents(id,location_id,name,rendered_body,status) VALUES ($1,$2,'Contract','Original body','draft')`, [doc, office]);
  await db.query('INSERT INTO document_send_items VALUES ($1,$2,true)', [packet, doc]);
  await db.exec('SET ROLE service_role');
};
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TYPE document_status AS ENUM ('draft','signed','active');
    CREATE TYPE document_event_type AS ENUM ('signed','generated');
    CREATE TABLE document_send_packets(id uuid PRIMARY KEY, token text, location_id uuid, job_id uuid,
      recipient_name text, recipient_email text, revoked_at timestamptz, expires_at timestamptz,
      completed_at timestamptz, single_use boolean DEFAULT true, required_fields jsonb DEFAULT '[]',
      field_values jsonb, submission_count integer DEFAULT 0);
    CREATE TABLE documents(id uuid PRIMARY KEY, location_id uuid, name text, rendered_body text,
      status document_status, locked_at timestamptz, storage_bucket text, storage_path text,
      mime text, size_bytes bigint, signed_at timestamptz, content_hash text,
      template_id uuid, template_version_id uuid, merge_data jsonb);
    CREATE TABLE document_send_items(packet_id uuid REFERENCES document_send_packets(id),
      document_id uuid REFERENCES documents(id), requires_signature boolean, PRIMARY KEY(packet_id,document_id));
    CREATE TABLE document_signatures(document_id uuid, signer_name text, signer_role text, signer_email text,
      signed_at timestamptz, signature_path text, provider text, user_agent text, ip inet);
    CREATE TABLE document_events(document_id uuid, event_type document_event_type, actor_label text, user_agent text, detail jsonb);
    CREATE TABLE job_notes(job_id uuid, body text CHECK(body NOT LIKE '%FAIL_NOTE%'));
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  `);
  // Use the production immutability and signature triggers, not mock equivalents.
  const contracts = readFileSync(new URL('../migrations/20260804185343_1b92ce7e-f686-4a26-97e4-0d63d2c4b221.sql', import.meta.url), 'utf8');
  const immutable = contracts.match(/CREATE OR REPLACE FUNCTION public.enforce_document_immutability\(\)[\s\S]*?EXECUTE FUNCTION public.enforce_document_immutability\(\);/);
  assert.ok(immutable);
  await db.exec(immutable[0]);
  const originals = readFileSync(new URL('../migrations/20260731003140_56cc0268-7389-44fb-8528-cdefb08d6dbd.sql', import.meta.url), 'utf8');
  const signatureTrigger = originals.match(/CREATE OR REPLACE FUNCTION public.tg_document_signed\(\)[\s\S]*?EXECUTE FUNCTION public.tg_document_signed\(\);/);
  assert.ok(signatureTrigger);
  await db.exec(signatureTrigger[0]);
  await db.exec(migration);
  await db.exec(migration); // idempotent definition and restricted grants
  await test('two submitted requests consume a single-use token once', async () => {
    const result = await Promise.allSettled([call(), call()]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await db.query('SELECT * FROM document_signatures')).rows.length, 1);
    assert.equal((await db.query('SELECT submission_count FROM document_send_packets')).rows[0].submission_count, 1);
  });
  await test('another packet cannot replace an already signed document', async () => {
    await db.query(`INSERT INTO document_send_packets(id,token,location_id,expires_at) VALUES($1,'token',$2,now()+interval '1 day')`, [secondPacket,office]);
    await db.query('INSERT INTO document_send_items VALUES($1,$2,true)', [secondPacket,doc]);
    await call();
    await assert.rejects(call(evidence, submission, secondPacket), /already signed/);
    assert.equal((await db.query('SELECT * FROM document_signatures')).rows.length, 1);
  });
  await test('downstream failure rolls back evidence and token consumption', async () => {
    await db.query('UPDATE document_send_packets SET job_id=$1', [office]);
    await assert.rejects(call(evidence, { ...submission, signer_name: 'FAIL_NOTE', packet_scope: { ...submission.packet_scope, job_id: office } }), /check constraint/);
    assert.equal((await db.query('SELECT status FROM documents')).rows[0].status, 'draft');
    assert.equal((await db.query('SELECT * FROM document_signatures')).rows.length, 0);
    assert.equal((await db.query('SELECT completed_at FROM document_send_packets')).rows[0].completed_at, null);
    await db.exec('UPDATE document_send_packets SET job_id=NULL');
    assert.equal((await call()).rows[0].n, 1);
  });
  await test('revocation is rechecked at commit', async () => {
    await db.exec('UPDATE document_send_packets SET revoked_at=now()');
    await assert.rejects(call(), /unavailable/);
  });
  await test('expiry is rechecked at commit', async () => {
    await db.exec("UPDATE document_send_packets SET expires_at=now()-interval '1 second'");
    await assert.rejects(call(), /unavailable/);
  });
  await test('null expiry fails closed', async () => {
    await db.exec('UPDATE document_send_packets SET expires_at=NULL');
    await assert.rejects(call(), /unavailable/);
  });
  await test('document edits after rendering reject stale evidence', async () => {
    await db.exec("UPDATE documents SET rendered_body='New wording'");
    await assert.rejects(call(), /does not match/);
  });
  await test('foreign office references are rejected', async () => {
    await db.query('UPDATE documents SET location_id=$1', [attempt]);
    await assert.rejects(call(), /outside packet scope/);
  });
  await test('required answers are checked inside transaction', async () => {
    await db.exec(`UPDATE document_send_packets SET required_fields='[{"key":"name","label":"Name"}]'`);
    await assert.rejects(call(), /Required answers/);
  });
  await test('duplicate evidence cannot omit another document', async () => {
    await assert.rejects(call([...evidence,...evidence]), /Documents changed/);
  });
  await test('multi-use packets retain immutable documents and count later answers', async () => {
    await db.exec('UPDATE document_send_packets SET single_use=false');
    await call();
    assert.equal((await call([])).rows[0].n, 0);
    assert.equal((await db.query('SELECT submission_count FROM document_send_packets')).rows[0].submission_count, 2);
    assert.equal((await db.query('SELECT * FROM document_signatures')).rows.length, 1);
  });
  for (const role of ['anon','authenticated']) await test(`${role} cannot call service RPC`, async () => {
    await db.exec(`RESET ROLE; SET ROLE ${role}`);
    await assert.rejects(call(), /permission denied/);
  });
  console.log(`${tests} PostgreSQL checks passed (in-memory; no live writes).`);
} finally { await db.close(); }
