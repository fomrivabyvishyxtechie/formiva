import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import { createSyntheticClerk } from '../../apps/api/test/support/synthetic-clerk.js';
import { staticKeyProvider } from '../../packages/crypto/src/index.js';
import { storeSensitiveValue } from '../../apps/api/src/services/sensitive-values.js';
import { runMigrations } from '../../packages/db/src/index.js';

// Phase 4.1 and 4.2 exit tests: claim race, original AI result kept, corrections append, approvals durable,
// reveal checked and audited. Synthetic data only.
const requireFromApi = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const { Pool } = requireFromApi('pg') as typeof import('pg');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL must point to the ephemeral PostgreSQL 16 test database');

const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const appPool = new Pool({ connectionString: databaseUrl, max: 8 });
appPool.on('connect', (client) => void client.query('SET ROLE formiva_app'));

const fx = randomUUID().slice(0, 8);
const wsA = randomUUID();
const wsB = randomUUID();
const keys = staticKeyProvider({ k1: randomBytes(32) }, 'k1');
const SYNTHETIC_ID = '123412341234'; // a made-up 12 digit string, not a real ID number

type Actor = { id: string; token: string };
const actors: Record<string, Actor> = {};
let app: Awaited<ReturnType<typeof buildApp>>;
let appNoKeys: Awaited<ReturnType<typeof buildApp>>;
let caseNo = 1000;

const call = (
  who: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  instance = app,
) =>
  instance.inject({
    method,
    url,
    payload: payload as object | undefined,
    headers: { authorization: `Bearer ${actors[who].token}`, ...headers },
  });

async function seedActor(name: string, workspaceId: string, role: string, perms: string[]) {
  const id = randomUUID();
  const roleId = randomUUID();
  const subject = `synthetic_${fx}_${name}`;
  await adminPool.query(
    `INSERT INTO users (id, auth_subject, email, display_name) VALUES ($1,$2,$3,$4)`,
    [id, subject, `${fx}-${name}@example.invalid`, `Synthetic ${name}`],
  );
  await adminPool.query(
    `INSERT INTO roles (id, workspace_id, name, is_system) VALUES ($1,$2,$3,false)`,
    [roleId, workspaceId, `${role}-${name}`],
  );
  for (const p of perms)
    await adminPool.query(
      `INSERT INTO role_permissions (workspace_id, role_id, permission_key) VALUES ($1,$2,$3)`,
      [workspaceId, roleId, p],
    );
  await adminPool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role_id, status, joined_at) VALUES ($1,$2,$3,'active',now())`,
    [workspaceId, id, roleId],
  );
  return { id, subject };
}

let versionId = '';
let modelId = '';

async function seedTask(opts: { sensitive?: boolean } = {}) {
  const caseId = randomUUID();
  const docId = randomUUID();
  const jobId = randomUUID();
  const execId = randomUUID();
  const resultId = randomUUID();
  const decisionId = randomUUID();
  const taskId = randomUUID();
  const q = (sql: string, v: unknown[]) => adminPool.query(sql, v);
  await q(
    `INSERT INTO cases (id, workspace_id, case_number, form_version_id, status) VALUES ($1,$2,$3,$4,'review_queued')`,
    [caseId, wsA, ++caseNo, versionId],
  );
  await q(
    `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes, sha256, doc_class, status, retain_until)
     VALUES ($1,$2,$3,'synthetic-bucket',$4,'synthetic.pdf','application/pdf',10,decode(repeat('ab',32),'hex'),'identity','clean',now()+interval '30 days')`,
    [docId, wsA, caseId, `k/${docId}`],
  );
  await q(
    `INSERT INTO ai_jobs (id, workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version, status) VALUES ($1,$2,$3,$4,$5,decode(repeat('ab',32),'hex'),'synthetic-policy-v1','completed')`,
    [jobId, wsA, caseId, docId, `job-${jobId}`],
  );
  await q(
    `INSERT INTO ai_executions (id, workspace_id, ai_job_id, attempt_no, model_registry_id, engine_version, ocr_runtime_version, prompt_template_version, status, duration_ms) VALUES ($1,$2,$3,1,$4,'engine-1','ocr-1','prompt-1','succeeded',1200)`,
    [execId, wsA, jobId, modelId],
  );
  await q(
    `INSERT INTO ai_results (id, workspace_id, ai_execution_id, document_class, detected_language, confidence, confidence_components, sensitivity, routing_recommendation, routing_reasons, schema_version)
     VALUES ($1,$2,$3,'identity','en',0.5,'{"ocr":0.4,"model":0.6,"rule_agreement":0.5}','sensitive','human_review','["low_confidence"]','v1')`,
    [resultId, wsA, execId],
  );
  await q(
    `INSERT INTO source_evidence (workspace_id, document_id, ai_result_id, evidence_type, page, redacted_excerpt) VALUES ($1,$2,$3,'ocr_region',1,'Synthetic excerpt')`,
    [wsA, docId, resultId],
  );
  await q(
    `INSERT INTO routing_decisions (id, workspace_id, case_id, document_id, ai_result_id, decision_key, rule_version, policy_version, action, route, reasons)
     VALUES ($1,$2,$3,$4,$5,$6,'rules-1','synthetic-policy-v1','route','human_review','["low_confidence"]')`,
    [decisionId, wsA, caseId, docId, resultId, `d-${decisionId}`],
  );
  await q(
    `INSERT INTO review_tasks (id, workspace_id, case_id, document_id, routing_decision_id, reason_codes, priority) VALUES ($1,$2,$3,$4,$5,ARRAY['low_confidence'],2)`,
    [taskId, wsA, caseId, docId, decisionId],
  );
  await q(
    `INSERT INTO case_values (workspace_id, case_id, field_key, revision, sensitivity, value_json, source) VALUES ($1,$2,'employer_name',1,'internal','"Synthetic Original Co"','ai_extraction')`,
    [wsA, caseId],
  );
  await q(
    `INSERT INTO case_values (workspace_id, case_id, field_key, revision, sensitivity, value_json, source) VALUES ($1,$2,'home_address',1,'sensitive','"1 Synthetic Lane"','respondent')`,
    [wsA, caseId],
  );
  if (opts.sensitive !== false) {
    const c = await adminPool.connect();
    try {
      await storeSensitiveValue(c, keys, {
        workspaceId: wsA,
        caseId,
        fieldKey: 'id_number',
        revision: 1,
        plaintext: SYNTHETIC_ID,
        source: 'ai_extraction',
      });
    } finally {
      c.release();
    }
  }
  return { caseId, taskId, resultId, docId };
}

// The state machine only allows real transitions, so fixtures walk them too.
const walk = async (id: string, ...to: string[]) => {
  for (const status of to) await adminPool.query(`UPDATE cases SET status=$2 WHERE id=$1`, [id, status]);
};
const caseStatus = async (id: string) =>
  (await adminPool.query(`SELECT status FROM cases WHERE id=$1`, [id])).rows[0].status;
const claim = async (who: string, taskId: string) =>
  call(who, 'POST', `/v1/review-tasks/${taskId}/claim`, {});
async function claimed(who = 'r1') {
  const t = await seedTask();
  const res = await claim(who, t.taskId);
  expect(res.statusCode).toBe(200);
  return { ...t, rowVersion: res.json().row_version as number };
}

beforeAll(async () => {
  await runMigrations(adminPool);
  for (const [id, slug] of [
    [wsA, 'a'],
    [wsB, 'b'],
  ])
    await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1,$2,$3)`, [
      id,
      `ra-${fx}-${slug}`,
      `Synthetic ${slug}`,
    ]);
  const review = ['case.read', 'case.review', 'case.correct', 'document.read_sensitive'];
  const defs: [string, string, string, string[]][] = [
    ['r1', wsA, 'reviewer', review],
    ['r2', wsA, 'reviewer', review],
    ['viewer', wsA, 'viewer', ['case.read']],
    ['admin', wsA, 'admin', ['case.read', 'case.reassign', 'case.review']],
    ['ap1', wsA, 'approver', ['case.read', 'case.approve']],
    ['ap2', wsA, 'approver', ['case.read', 'case.approve']],
    ['ap3', wsA, 'approver', ['case.read', 'case.approve']],
    ['nonap', wsA, 'staff', ['case.read']],
    ['foreign', wsB, 'reviewer', [...review, 'case.approve']],
  ];
  const clerk = await createSyntheticClerk();
  for (const [name, w, role, perms] of defs) {
    const a = await seedActor(name, w, role, perms);
    actors[name] = { id: a.id, token: await clerk.createToken(a.subject) };
  }
  const templateId = randomUUID();
  versionId = randomUUID();
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1,$2,$3,'Synthetic form')`,
    [templateId, wsA, `form-${fx}`],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number) VALUES ($1,$2,$3,1)`,
    [versionId, wsA, templateId],
  );
  modelId = randomUUID();
  await adminPool.query(
    `INSERT INTO ai_model_registry (id, model_key, version, digest, runtime, license) VALUES ($1,$2,'1','synthetic-digest','synthetic-runtime','synthetic')`,
    [modelId, `model-${fx}`],
  );
  const env = {
    NODE_ENV: 'test',
    CLERK_ISSUER: clerk.issuer,
    CLERK_AUDIENCE: clerk.audience,
    CLERK_JWKS_URL: 'https://review-approvals.synthetic.invalid/jwks.json',
    CLERK_AUTHORIZED_PARTIES: clerk.authorizedParty,
  };
  app = await buildApp(env, {
    pool: appPool,
    keyProvider: keys,
    auth: { jwksFetch: clerk.jwksFetch },
  });
  appNoKeys = await buildApp(env, { pool: appPool, auth: { jwksFetch: clerk.jwksFetch } });
  await app.ready();
  await appNoKeys.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await appNoKeys?.close();
  await appPool.end();
  await adminPool.end();
});

describe('4.1 review tasks', () => {
  it('lets exactly one of two reviewers claim a task', async () => {
    const t = await seedTask();
    const [a, b] = await Promise.all([claim('r1', t.taskId), claim('r2', t.taskId)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await caseStatus(t.caseId)).toBe('review_in_progress');
    const row = (
      await adminPool.query(`SELECT assignee_user_id FROM review_tasks WHERE id=$1`, [t.taskId])
    ).rows[0];
    expect([actors.r1.id, actors.r2.id]).toContain(row.assignee_user_id);
  });

  it('lets a lapsed lease be taken over and a live one not', async () => {
    const t = await claimed('r1');
    expect((await claim('r2', t.taskId)).statusCode).toBe(409);
    await adminPool.query(
      `UPDATE review_tasks SET lease_until = now() - interval '1 minute' WHERE id=$1`,
      [t.taskId],
    );
    expect((await claim('r2', t.taskId)).statusCode).toBe(200);
    const late = await call('r1', 'POST', `/v1/review-tasks/${t.taskId}/resolve`, {
      resolution: 'approved',
    });
    expect(late.statusCode).toBe(409);
  });

  it('refuses callers without the permission and callers from another workspace', async () => {
    const t = await seedTask();
    expect(
      (await call('viewer', 'POST', `/v1/review-tasks/${t.taskId}/claim`, {})).statusCode,
    ).toBe(403);
    expect(
      (await call('foreign', 'POST', `/v1/review-tasks/${t.taskId}/claim`, {})).statusCode,
    ).toBe(404);
    expect((await call('foreign', 'GET', `/v1/review-tasks/${t.taskId}`)).statusCode).toBe(404);
    expect((await call('foreign', 'GET', `/v1/cases/${t.caseId}/values`)).statusCode).toBe(404);
  });

  it('shows the AI result, evidence, model metadata and masked values', async () => {
    const t = await seedTask();
    const res = await call('r1', 'GET', `/v1/review-tasks/${t.taskId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ai_result.confidence_components).toEqual({
      ocr: 0.4,
      model: 0.6,
      rule_agreement: 0.5,
    });
    expect(body.ai_result.engine_version).toBe('engine-1');
    expect(body.source_evidence).toHaveLength(1);
    const byKey = Object.fromEntries(body.values.map((v: any) => [v.field_key, v]));
    expect(byKey.employer_name.value).toBe('Synthetic Original Co');
    expect(byKey.home_address.value).toBeNull();
    expect(byKey.id_number.masked).toBe(true);
    expect(res.body).not.toContain(SYNTHETIC_ID);
    expect(res.body).not.toContain('1 Synthetic Lane');
  });

  it('lists tasks by status and priority', async () => {
    const t = await seedTask();
    const res = await call('r1', 'GET', '/v1/review-tasks?status=open&priority=2&limit=100');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((i: any) => i.id === t.taskId)).toBe(true);
    expect((await call('r1', 'GET', '/v1/review-tasks?priority=9')).statusCode).toBe(400);
  });

  it('keeps the original AI result and appends a correction, a revision and a superseding decision', async () => {
    const t = await claimed();
    const before = JSON.stringify(
      (await adminPool.query(`SELECT * FROM ai_results WHERE id=$1`, [t.resultId])).rows,
    );
    const evBefore = JSON.stringify(
      (await adminPool.query(`SELECT * FROM source_evidence WHERE ai_result_id=$1`, [t.resultId]))
        .rows,
    );
    const res = await call('r1', 'POST', `/v1/review-tasks/${t.taskId}/correct`, {
      row_version: t.rowVersion,
      reason: 'Synthetic employer was not grounded by the OCR text.',
      corrections: [
        { field: 'employer_name', value: 'Synthetic Corrected Co' },
        { field: 'id_number', value: '432143214321' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(
      JSON.stringify(
        (await adminPool.query(`SELECT * FROM ai_results WHERE id=$1`, [t.resultId])).rows,
      ),
    ).toBe(before);
    expect(
      JSON.stringify(
        (await adminPool.query(`SELECT * FROM source_evidence WHERE ai_result_id=$1`, [t.resultId]))
          .rows,
      ),
    ).toBe(evBefore);
    const vals = (
      await adminPool.query(
        `SELECT field_key, revision, source FROM case_values WHERE case_id=$1 ORDER BY field_key, revision`,
        [t.caseId],
      )
    ).rows;
    expect(
      vals.filter((v: any) => v.field_key === 'employer_name').map((v: any) => v.revision),
    ).toEqual([1, 2]);
    expect(
      vals.filter((v: any) => v.field_key === 'id_number').map((v: any) => v.revision),
    ).toEqual([1, 2]);
    const corr = (
      await adminPool.query(`SELECT * FROM human_corrections WHERE review_task_id=$1`, [t.taskId])
    ).rows;
    expect(corr).toHaveLength(2);
    expect(JSON.stringify(corr)).not.toContain('432143214321');
    const decisions = (
      await adminPool.query(
        `SELECT supersedes_id, action FROM routing_decisions WHERE case_id=$1 ORDER BY created_at`,
        [t.caseId],
      )
    ).rows;
    expect(decisions).toHaveLength(2);
    expect(decisions[1].action).toBe('human_correction');
    expect(decisions[1].supersedes_id).not.toBeNull();
    const detail = await call('r1', 'GET', `/v1/review-tasks/${t.taskId}`);
    expect(detail.body).not.toContain('432143214321');
    expect(detail.body).not.toContain('"enc"');
    expect(detail.json().corrections).toHaveLength(2);
    // the same row_version cannot be used twice
    const again = await call('r1', 'POST', `/v1/review-tasks/${t.taskId}/correct`, {
      row_version: t.rowVersion,
      reason: 'Synthetic repeat',
      corrections: [{ field: 'employer_name', value: 'X' }],
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses corrections without a claim, a reason, a current version or key custody', async () => {
    const open = await seedTask();
    const body = {
      row_version: 1,
      reason: 'Synthetic reason',
      corrections: [{ field: 'employer_name', value: 'X' }],
    };
    expect(
      (await call('r1', 'POST', `/v1/review-tasks/${open.taskId}/correct`, body)).statusCode,
    ).toBe(409);
    const t = await claimed();
    const url = `/v1/review-tasks/${t.taskId}/correct`;
    expect(
      (await call('r1', 'POST', url, { ...body, row_version: t.rowVersion, reason: '' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('r1', 'POST', url, { ...body, row_version: t.rowVersion + 5 })).statusCode,
    ).toBe(409);
    expect((await call('r2', 'POST', url, { ...body, row_version: t.rowVersion })).statusCode).toBe(
      409,
    );
    expect(
      (await call('viewer', 'POST', url, { ...body, row_version: t.rowVersion })).statusCode,
    ).toBe(403);
    expect(
      (
        await call('r1', 'POST', url, {
          ...body,
          row_version: t.rowVersion,
          corrections: [{ field: 'nope', value: 'X' }],
        })
      ).statusCode,
    ).toBe(422);
    const noKeys = await call(
      'r1',
      'POST',
      url,
      { ...body, row_version: t.rowVersion, corrections: [{ field: 'id_number', value: '1' }] },
      {},
      appNoKeys,
    );
    expect(noKeys.statusCode).toBe(503);
    expect(
      (await adminPool.query(`SELECT 1 FROM human_corrections WHERE review_task_id=$1`, [t.taskId]))
        .rowCount,
    ).toBe(0);
  });

  it('resolves with the right rules and answers a repeat the same way', async () => {
    const t = await claimed();
    const url = `/v1/review-tasks/${t.taskId}/resolve`;
    expect((await call('r1', 'POST', url, { resolution: 'quarantined' })).statusCode).toBe(400);
    expect(
      (await call('r1', 'POST', url, { resolution: 'rework', reason: 'Synthetic' })).statusCode,
    ).toBe(400);
    expect(
      (await call('r1', 'POST', url, { resolution: 'corrected', reason: 'Synthetic fix' }))
        .statusCode,
    ).toBe(409);
    expect((await call('r2', 'POST', url, { resolution: 'approved' })).statusCode).toBe(409);
    const ok = await call('r1', 'POST', url, { resolution: 'approved' });
    expect(ok.statusCode).toBe(200);
    expect(await caseStatus(t.caseId)).toBe('workflow_ready');
    const replay = await call('r1', 'POST', url, { resolution: 'approved' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(
      (
        await call('r1', 'POST', url, {
          resolution: 'quarantined',
          reason: 'Synthetic late change',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('quarantines a case and returns a released task to the queue', async () => {
    const q = await claimed();
    expect(
      (
        await call('r1', 'POST', `/v1/review-tasks/${q.taskId}/resolve`, {
          resolution: 'quarantined',
          reason: 'Synthetic unsafe file',
        })
      ).statusCode,
    ).toBe(200);
    expect(await caseStatus(q.caseId)).toBe('quarantined');
    const r = await claimed();
    expect((await call('r2', 'POST', `/v1/review-tasks/${r.taskId}/release`)).statusCode).toBe(409);
    expect((await call('r1', 'POST', `/v1/review-tasks/${r.taskId}/release`)).statusCode).toBe(200);
    expect(await caseStatus(r.caseId)).toBe('review_queued');
    expect((await claim('r2', r.taskId)).statusCode).toBe(200);
  });

  it('keeps a case in review while another task is still open', async () => {
    const t = await claimed();
    const second = randomUUID();
    const decision = (
      await adminPool.query(`SELECT routing_decision_id FROM review_tasks WHERE id=$1`, [t.taskId])
    ).rows[0].routing_decision_id;
    await adminPool.query(
      `INSERT INTO review_tasks (id, workspace_id, case_id, routing_decision_id, reason_codes) VALUES ($1,$2,$3,$4,ARRAY['x'])`,
      [second, wsA, t.caseId, decision],
    );
    await call('r1', 'POST', `/v1/review-tasks/${t.taskId}/resolve`, { resolution: 'approved' });
    expect(await caseStatus(t.caseId)).toBe('review_in_progress');
  });
});

describe('4.1 sensitive reveal', () => {
  it('checks permission, needs a reason, and audits without the value', async () => {
    const t = await seedTask();
    const url = `/v1/cases/${t.caseId}/values/id_number/reveal`;
    expect((await call('viewer', 'POST', url, { reason: 'Synthetic check' })).statusCode).toBe(403);
    expect((await call('r1', 'POST', url, {})).statusCode).toBe(400);
    expect((await call('foreign', 'POST', url, { reason: 'Synthetic check' })).statusCode).toBe(
      404,
    );
    expect(
      (await call('r1', 'POST', url, { reason: 'Synthetic check' }, {}, appNoKeys)).statusCode,
    ).toBe(503);
    const ok = await call('r1', 'POST', url, { reason: 'Synthetic identity check' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe(SYNTHETIC_ID);
    expect(ok.headers['cache-control']).toBe('no-store');
    const audits = (
      await adminPool.query(
        `SELECT * FROM audit_events WHERE workspace_id=$1 AND action='case_value.revealed' AND object_id=$2`,
        [wsA, t.caseId],
      )
    ).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe(actors.r1.id);
    expect(audits[0].reason).toBe('Synthetic identity check');
    expect(JSON.stringify(audits)).not.toContain(SYNTHETIC_ID);
    const plain = await call('r1', 'POST', `/v1/cases/${t.caseId}/values/home_address/reveal`, {
      reason: 'Synthetic check',
    });
    expect(plain.json().value).toBe('1 Synthetic Lane');
    expect(
      (
        await call('r1', 'POST', `/v1/cases/${t.caseId}/values/missing/reveal`, {
          reason: 'Synthetic check',
        })
      ).statusCode,
    ).toBe(404);
  });
});

async function readyCase() {
  const t = await seedTask();
  await walk(t.caseId, 'review_in_progress', 'workflow_ready');
  return t.caseId;
}
async function round(caseId: string, who: string[]) {
  const res = await call('admin', 'POST', `/v1/cases/${caseId}/approvals`, {
    workflow_step_key: 'manager_review',
    approver_user_ids: who.map((w) => actors[w].id),
  });
  expect(res.statusCode).toBe(201);
  const rows = (
    await adminPool.query(
      `SELECT id, approver_user_id FROM approvals WHERE case_id=$1 AND decision='pending'`,
      [caseId],
    )
  ).rows;
  return Object.fromEntries(
    who.map((w) => [w, rows.find((r: any) => r.approver_user_id === actors[w].id).id as string]),
  );
}
const decide = (who: string, id: string, body: object) =>
  call(who, 'POST', `/v1/approvals/${id}/decide`, body);

describe('4.2 approvals', () => {
  it('creates a round only for a ready case and real approvers', async () => {
    const t = await seedTask();
    const body = { workflow_step_key: 'manager_review', approver_user_ids: [actors.ap1.id] };
    expect((await call('admin', 'POST', `/v1/cases/${t.caseId}/approvals`, body)).statusCode).toBe(
      409,
    );
    await walk(t.caseId, 'review_in_progress', 'workflow_ready');
    expect((await call('ap1', 'POST', `/v1/cases/${t.caseId}/approvals`, body)).statusCode).toBe(
      403,
    );
    expect(
      (
        await call('admin', 'POST', `/v1/cases/${t.caseId}/approvals`, {
          ...body,
          approver_user_ids: [actors.nonap.id],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('admin', 'POST', `/v1/cases/${t.caseId}/approvals`, {
          ...body,
          approver_user_ids: [actors.foreign.id],
        })
      ).statusCode,
    ).toBe(422);
    expect((await call('admin', 'POST', `/v1/cases/${t.caseId}/approvals`, body)).statusCode).toBe(
      201,
    );
    expect(await caseStatus(t.caseId)).toBe('approval_pending');
    expect((await call('admin', 'POST', `/v1/cases/${t.caseId}/approvals`, body)).statusCode).toBe(
      409,
    );
  });

  it('needs every approver, and the database refuses to run a sensitive case before then', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1', 'ap2']);
    const inbox = await call('ap1', 'GET', '/v1/approvals');
    expect(inbox.json().items.some((i: any) => i.id === ids.ap1)).toBe(true);
    expect((await call('nonap', 'GET', '/v1/approvals')).statusCode).toBe(403);
    expect((await decide('ap1', ids.ap1, { decision: 'approve' })).json().round_complete).toBe(
      false,
    );
    await expect(
      adminPool.query(`UPDATE cases SET status='action_executing' WHERE id=$1`, [caseId]),
    ).rejects.toThrow(/complete approval/);
    expect((await decide('ap2', ids.ap2, { decision: 'approve' })).json().round_complete).toBe(
      true,
    );
    await adminPool.query(`UPDATE cases SET status='action_executing' WHERE id=$1`, [caseId]);
    const list = await call('viewer', 'GET', `/v1/cases/${caseId}/approvals`);
    expect(list.json().items.map((i: any) => i.decision)).toEqual(['approved', 'approved']);
  });

  it('records a rejection with a reason and closes the round for everyone else', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1', 'ap2']);
    expect((await decide('ap1', ids.ap1, { decision: 'reject' })).statusCode).toBe(400);
    expect((await decide('ap2', ids.ap1, { decision: 'approve' })).statusCode).toBe(403);
    expect((await decide('foreign', ids.ap1, { decision: 'approve' })).statusCode).toBe(404);
    const rej = await decide('ap1', ids.ap1, {
      decision: 'reject',
      reason: 'Synthetic: figures do not match',
    });
    expect(rej.statusCode).toBe(200);
    expect(await caseStatus(caseId)).toBe('rejected');
    expect((await decide('ap2', ids.ap2, { decision: 'approve' })).statusCode).toBe(409);
    await expect(
      adminPool.query(`UPDATE approvals SET decision='approved' WHERE id=$1`, [ids.ap1]),
    ).rejects.toThrow(/final/);
    await expect(adminPool.query(`DELETE FROM approvals WHERE id=$1`, [ids.ap1])).rejects.toThrow();
    expect(
      (await call('ap2', 'GET', '/v1/approvals')).json().items.some((i: any) => i.id === ids.ap2),
    ).toBe(false);
  });

  it('sends a case back for rework with a new task, and a new round starts at round 2', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1']);
    const res = await decide('ap1', ids.ap1, {
      decision: 'rework',
      reason: 'Synthetic: attach the missing page',
    });
    expect(res.json().case_status).toBe('review_queued');
    const task = (
      await adminPool.query(
        `SELECT status, reason_codes FROM review_tasks WHERE case_id=$1 AND 'approval_rework'=ANY(reason_codes)`,
        [caseId],
      )
    ).rows;
    expect(task).toHaveLength(1);
    expect(task[0].status).toBe('open');
    const dec = (
      await adminPool.query(
        `SELECT action, supersedes_id FROM routing_decisions WHERE case_id=$1 AND action='approval_rework'`,
        [caseId],
      )
    ).rows;
    expect(dec).toHaveLength(1);
    expect(dec[0].supersedes_id).not.toBeNull();
    await walk(caseId, 'review_in_progress', 'workflow_ready');
    await round(caseId, ['ap1']);
    expect(
      (await adminPool.query(`SELECT max(round) AS r FROM approvals WHERE case_id=$1`, [caseId]))
        .rows[0].r,
    ).toBe(2);
  });

  it('answers a repeated decision the same way and refuses a changed one', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1', 'ap2']);
    expect((await decide('ap1', ids.ap1, { decision: 'approve' })).statusCode).toBe(200);
    const again = await decide('ap1', ids.ap1, { decision: 'approve' });
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
    expect(
      (await decide('ap1', ids.ap1, { decision: 'reject', reason: 'Synthetic change of mind' }))
        .statusCode,
    ).toBe(409);
  });

  it('delegates durably and only to another approver', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1', 'ap2']);
    const url = `/v1/approvals/${ids.ap1}/delegate`;
    expect(
      (
        await call('ap1', 'POST', url, {
          delegate_user_id: actors.ap1.id,
          reason: 'Synthetic self',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('ap1', 'POST', url, {
          delegate_user_id: actors.ap2.id,
          reason: 'Synthetic taken',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('ap1', 'POST', url, {
          delegate_user_id: actors.nonap.id,
          reason: 'Synthetic no right',
        })
      ).statusCode,
    ).toBe(422);
    expect((await call('ap1', 'POST', url, { delegate_user_id: actors.ap3.id })).statusCode).toBe(
      400,
    );
    const ok = await call('ap1', 'POST', url, {
      delegate_user_id: actors.ap3.id,
      reason: 'Synthetic: on leave',
    });
    expect(ok.statusCode).toBe(200);
    const newId = ok.json().new_approval_id;
    expect((await decide('ap1', ids.ap1, { decision: 'approve' })).statusCode).toBe(409);
    expect((await decide('ap2', newId, { decision: 'approve' })).statusCode).toBe(403);
    expect((await decide('ap3', newId, { decision: 'approve' })).statusCode).toBe(200);
    expect((await decide('ap2', ids.ap2, { decision: 'approve' })).json().round_complete).toBe(
      true,
    );
    const rows = (
      await adminPool.query(
        `SELECT decision, delegated_from FROM approvals WHERE case_id=$1 ORDER BY created_at`,
        [caseId],
      )
    ).rows;
    expect(rows.map((r: any) => r.decision)).toEqual(['delegated', 'approved', 'approved']);
    expect(rows[2].delegated_from).toBe(actors.ap1.id);
  });
});

describe('4.1/4.2 activity', () => {
  it('shows correlation-linked state changes without reasons or actors', async () => {
    const t = await seedTask();
    const corr = randomUUID();
    await call(
      'r1',
      'POST',
      `/v1/review-tasks/${t.taskId}/claim`,
      {},
      { 'x-correlation-id': corr },
    );
    await call('r1', 'POST', `/v1/cases/${t.caseId}/values/id_number/reveal`, {
      reason: 'Synthetic reveal reason',
    });
    const res = await call('viewer', 'GET', `/v1/cases/${t.caseId}/activity`);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toEqual([
      expect.objectContaining({ action: 'review_task.claimed', correlation_id: corr }),
    ]);
    expect(res.body).not.toContain('Synthetic reveal reason');
    expect(res.body).not.toContain(actors.r1.id);
    expect((await call('foreign', 'GET', `/v1/cases/${t.caseId}/activity`)).statusCode).toBe(404);
  });

  it('carries approval changes with from and to status', async () => {
    const caseId = await readyCase();
    const ids = await round(caseId, ['ap1']);
    await decide('ap1', ids.ap1, { decision: 'reject', reason: 'Synthetic rejection' });
    const items = (await call('viewer', 'GET', `/v1/cases/${caseId}/activity`)).json().items;
    expect(items.map((i: any) => i.action)).toEqual(['approval.round_created', 'approval.decided']);
    expect(items[1]).toMatchObject({ from_status: 'approval_pending', to_status: 'rejected' });
  });
});
