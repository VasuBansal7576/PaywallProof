import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { billingSchema, evaluateProbe, expectedAccess, hashValue, identifier, parseJson, parsePolicy, probeSchema, type Json, type ProbeResult } from '../../core/src/index.ts';

const sensitiveKey = /^(authorization|cookie|set-cookie|password|secret|token|api.?key|webhook.?secret|email|access.?token|refresh.?token)$/i;
export function redact(value: unknown, secrets: readonly string[] = []): Json {
  function cleanText(text: string) {
    let result = text.replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b|\bwhsec_[A-Za-z0-9_]+\b|\bgh[pousr]_[A-Za-z0-9]+\b|\bgithub_pat_[A-Za-z0-9_]+\b/g, '[REDACTED]');
    result = result.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED_AUTH]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
    for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  function visit(node: Json): Json {
    if (typeof node === 'string') return cleanText(node);
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit);
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [cleanText(key), sensitiveKey.test(key) ? '[REDACTED]' : visit(item)]));
  }
  return visit(parseJson(value));
}

export const observationInputSchema = z.strictObject({
  runId:identifier, scenarioId:z.enum(['SC01','SC02','SC03','SC04']), subjectId:identifier,
  source:z.enum(['stripe','application','api_probe','browser']), policyHash:z.string().regex(/^[a-f0-9]{64}$/),
  targetBuild:identifier, observedAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  billingTime:z.number().int().nonnegative().nullable(), mode:z.enum(['stripe_sandbox','local_replay']),payload:z.unknown(),
});
const observationSchema = observationInputSchema.extend({id:identifier,sha256:identifier});
export type Observation = z.infer<typeof observationSchema>;
export class EvidenceStore {
  private readonly database: Database.Database;
  constructor(path:string, private readonly secrets: readonly string[] = []) {
    this.database = new Database(path);
    this.database.pragma('journal_mode = WAL');
    this.database.exec('CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS observations_run ON observations(run_id);');
  }
  record(input:unknown): Observation {
    const fields = observationInputSchema.parse(parseJson(input));
    const payload = redact(fields.payload, this.secrets);
    const record = {...fields,payload,id:randomUUID(),sha256:hashValue(payload)};
    this.database.prepare('INSERT INTO observations(id,run_id,record) VALUES(?,?,?)').run(record.id,record.runId,JSON.stringify(record));
    return record;
  }
  get(id:string):Observation {
    const row = z.object({record:z.string()}).parse(this.database.prepare('SELECT record FROM observations WHERE id=?').get(id));
    const observation = observationSchema.parse(JSON.parse(row.record));
    if (hashValue(observation.payload) !== observation.sha256) throw new Error('EVIDENCE_HASH_MISMATCH');
    return observation;
  }
  list(runId:string):Observation[] {
    return this.database.prepare('SELECT id FROM observations WHERE run_id=? ORDER BY rowid').all(runId).map(row=>this.get(z.object({id:z.string()}).parse(row).id));
  }
  close() { this.database.close(); }
}

export const evaluationInputSchema = z.strictObject({
  runId:identifier, scenarioId:z.enum(['SC01','SC02','SC03','SC04']),subjectId:identifier,
  policy:z.unknown(),targetBuild:identifier,mode:z.enum(['stripe_sandbox','local_replay']),fixtureMarker:identifier,
  stripeId:identifier,applicationId:identifier,apiId:identifier,browserId:identifier,
  now:z.number().int().nonnegative(), notBefore:z.number().int().nonnegative(),
});
export type EvidenceEvaluation = {api:ProbeResult;browser:ProbeResult;state:ProbeResult;observationIds:string[]};
export function evaluateEvidence(store:EvidenceStore,input:unknown):EvidenceEvaluation {
  const request = evaluationInputSchema.parse(parseJson(input));
  const policy = parsePolicy(request.policy);
  const ids = [request.stripeId,request.applicationId,request.apiId,request.browserId];
  const inconclusive = (code:string):EvidenceEvaluation => ({api:{verdict:'inconclusive',code},browser:{verdict:'inconclusive',code},state:{verdict:'inconclusive',code},observationIds:ids});
  let records:Observation[];
  try { records = ids.map(id=>store.get(id)); } catch { return inconclusive('EVIDENCE_MISSING'); }
  const [stripe,application,api,browser] = records;
  if (!stripe || !application || !api || !browser || new Set(ids).size !== 4) return inconclusive('EVIDENCE_MISSING');
  if (stripe.source !== 'stripe' || application.source !== 'application' || api.source !== 'api_probe' || browser.source !== 'browser') return inconclusive('EVIDENCE_SOURCE_MISMATCH');
  for (const record of records) {
    if(record.runId!==request.runId||record.scenarioId!==request.scenarioId||record.subjectId!==request.subjectId||record.policyHash!==policy.hash||record.mode!==request.mode) return inconclusive('EVIDENCE_SCOPE_MISMATCH');
    if(record.targetBuild!==request.targetBuild) return inconclusive('TARGET_CHANGED');
    if(record.observedAt>request.now||record.observedAt<request.notBefore||request.now-record.observedAt>10_000) return inconclusive('EVIDENCE_STALE');
  }
  const billing = billingSchema.safeParse(stripe.payload);
  if (!billing.success) return inconclusive('INVALID_PROVIDER_EVIDENCE');
  const expected = expectedAccess({policy,billing:billing.data});
  const apiProbe = probeSchema.safeParse(api.payload), browserProbe = probeSchema.safeParse(browser.payload);
  if (!apiProbe.success || !browserProbe.success) return inconclusive('INVALID_PROBE_EVIDENCE');
  const appState = z.object({principalId:identifier,runId:identifier,customerId:identifier.nullable(),status:identifier,buildId:identifier}).safeParse(application.payload);
  if (!appState.success) return inconclusive('APPLICATION_STATE_UNKNOWN');
  let state:ProbeResult = {verdict:'inconclusive',code:'APPLICATION_STATE_UNKNOWN'};
  if (appState.success && expected.kind !== 'unknown') {
    if (appState.data.principalId!==request.subjectId||appState.data.runId!==request.runId||appState.data.customerId!==billing.data.customerId) return inconclusive('IDENTITY_UNRESOLVED');
    if (appState.data.buildId!==request.targetBuild) return inconclusive('TARGET_CHANGED');
    state = appState.data.status === (billing.data.subscription?.status ?? 'none') ? {verdict:'pass',code:'STATE_MATCHES'} : {verdict:'fail',code:'STATE_DRIFT'};
  }
  return { api:evaluateProbe({expected,probe:apiProbe.data,fixtureMarker:request.fixtureMarker}),browser:evaluateProbe({expected,probe:browserProbe.data,fixtureMarker:request.fixtureMarker}),state,observationIds:ids };
}
