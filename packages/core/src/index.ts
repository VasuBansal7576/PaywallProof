import { createHash } from 'node:crypto';
import { z } from 'zod';

export const identifier = z.string().min(1).refine(value => value.trim() === value, 'Padded identifier');
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const policyInputSchema = z.strictObject({
  schemaVersion: z.literal(2),
  priceId: identifier,
  featureId: identifier,
  featureConfigHash: digest,
  cancellation: z.literal('allow_until_period_end'),
  requireInitialPaymentConfirmed: z.literal(true),
  syncWindowSeconds: z.number().int().min(5).max(300),
  predicateVersion: identifier,
});
export const policySchema = policyInputSchema.extend({ hash: digest });
export type AccessPolicy = Readonly<z.infer<typeof policySchema>>;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Validate descriptors before reading values; validation must not execute accessors. */
export function parseJson(value: unknown, maximumDepth = 32): Json {
  const ancestors = new Set<object>();
  let count = 0;
  function visit(node: unknown, depth: number): Json {
    if (++count > 100_000) throw new Error('JSON_NODE_LIMIT');
    if (depth > maximumDepth) throw new Error('JSON_DEPTH_LIMIT');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node !== 'object' || node === null) throw new Error('INVALID_JSON_VALUE');
    if (ancestors.has(node)) throw new Error('CYCLIC_JSON');
    const prototype: unknown = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_JSON_OBJECT');
    if (Array.isArray(node) && prototype !== Array.prototype) throw new Error('INVALID_JSON_ARRAY');
    ancestors.add(node);
    const descriptors = Object.getOwnPropertyDescriptors(node);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error('JSON_SYMBOL_PROPERTY');
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new Error('JSON_ACCESSOR');
      if (Array.isArray(node) && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('JSON_ARRAY_PROPERTY');
      if (key !== 'length' && !descriptor.enumerable) throw new Error('JSON_HIDDEN_PROPERTY');
    }
    let result: Json;
    if (Array.isArray(node)) {
      const output: Json[] = [];
      for (let i = 0; i < node.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) throw new Error('JSON_ARRAY_HOLE');
        output.push(visit(descriptor.value, depth + 1));
      }
      result = output;
    } else {
      const output: { [key: string]: Json } = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = output;
    }
    ancestors.delete(node);
    return result;
  }
  return visit(value, 0);
}

export function canonicalJson(value: unknown): string {
  function encode(node: Json): string {
    if (node === null || typeof node !== 'object') return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(encode).join(',')}]`;
    return `{${Object.keys(node).sort().map(key => `${JSON.stringify(key)}:${encode(node[key] ?? null)}`).join(',')}}`;
  }
  return encode(parseJson(value));
}
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function hashValue(value: unknown): string { return sha256(canonicalJson(value)); }

export function createPolicy(input: unknown): AccessPolicy {
  const fields = policyInputSchema.parse(parseJson(input));
  return Object.freeze({ ...fields, hash: hashValue(fields) });
}
export function parsePolicy(input: unknown): AccessPolicy {
  const { hash, ...fields } = policySchema.parse(parseJson(input));
  const policy = createPolicy(fields);
  if (hash !== policy.hash) throw new Error('POLICY_HASH_MISMATCH');
  return policy;
}

export const subscriptionSchema = z.strictObject({
  id: identifier, customerId: identifier, priceId: identifier, status: identifier,
  initialPaymentConfirmed: z.boolean(), cancelAtPeriodEnd: z.boolean(),
  periodEnd: safeTime, billingTime: safeTime,
});
export const billingSchema = z.strictObject({
  livemode: z.boolean(), identityResolved: z.boolean(), noSubscriptionConfirmed: z.boolean(),
  customerId: identifier.nullable(), subscription: subscriptionSchema.nullable(),
});
export type Billing = z.infer<typeof billingSchema>;
export const expectationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('allow') }),
  z.strictObject({ kind: z.literal('deny') }),
  z.strictObject({ kind: z.literal('unknown'), code: identifier }),
]);
export type ExpectedAccess = z.infer<typeof expectationSchema>;
const accessInputSchema = z.strictObject({ policy: policySchema, billing: billingSchema });

export function expectedAccess(input: unknown): ExpectedAccess {
  const parsed = accessInputSchema.parse(parseJson(input));
  const policy = parsePolicy(parsed.policy);
  const billing = parsed.billing;
  const unknown = (code: string): ExpectedAccess => ({ kind: 'unknown', code });
  if (billing.livemode) return unknown('LIVE_MODE_REJECTED');
  if (!billing.identityResolved) return unknown('IDENTITY_UNRESOLVED');
  const subscription = billing.subscription;
  if (!subscription) return billing.noSubscriptionConfirmed ? { kind: 'deny' } : unknown('ABSENCE_UNCONFIRMED');
  if (billing.noSubscriptionConfirmed) return unknown('CONTRADICTORY_BILLING');
  if (billing.customerId !== subscription.customerId) return unknown('CUSTOMER_MISMATCH');
  if (subscription.priceId !== policy.priceId) return unknown('PRICE_MISMATCH');
  if (subscription.status === 'canceled') return { kind: 'deny' };
  if (subscription.status !== 'active') return unknown('UNSUPPORTED_STATUS');
  if (!subscription.initialPaymentConfirmed) return unknown('INITIAL_INVOICE_UNPAID');
  if (subscription.cancelAtPeriodEnd && subscription.billingTime >= subscription.periodEnd) return unknown('CANCELLATION_UNCONFIRMED');
  return { kind: 'allow' };
}

export const verdictSchema = z.enum(['pass', 'fail', 'inconclusive', 'unsupported', 'skipped']);
export type Verdict = z.infer<typeof verdictSchema>;
export type RunOutcome = 'passed' | 'failed' | 'inconclusive';
export function aggregateVerdicts(input: unknown): RunOutcome {
  const verdicts = z.array(verdictSchema).parse(input);
  if (verdicts.includes('fail')) return 'failed';
  return verdicts.length > 0 && verdicts.every(value => value === 'pass') ? 'passed' : 'inconclusive';
}

const probeFields = {
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
  denialStatuses: z.array(z.number().int().min(400).max(499)).min(1).refine(values => new Set(values).size === values.length),
};
export const probeSchema = z.discriminatedUnion('transportError',[
  z.strictObject({...probeFields,transportError:z.literal(false)}),
  z.strictObject({...probeFields,status:probeFields.status.nullable(),transportError:z.literal(true)}),
]);
const probeInputSchema = z.strictObject({ expected: expectationSchema, probe: probeSchema, fixtureMarker: identifier });
export type ProbeResult = { verdict: Verdict; code: string };

export function evaluateProbe(input: unknown): ProbeResult {
  // Validate the body separately so its depth is independent of envelope nesting.
  if (typeof input !== 'object' || input === null) throw new Error('INVALID_PROBE');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const probeDescriptor = descriptors.probe;
  if (!probeDescriptor || !('value' in probeDescriptor)) throw new Error('INVALID_PROBE');
  const probeValue: unknown = probeDescriptor.value;
  if (typeof probeValue !== 'object' || probeValue === null) throw new Error('INVALID_PROBE');
  const bodyDescriptor = Object.getOwnPropertyDescriptor(probeValue, 'body');
  if (!bodyDescriptor || !('value' in bodyDescriptor)) throw new Error('INVALID_BODY');
  const body = parseJson(bodyDescriptor.value);
  const { expected, probe, fixtureMarker } = probeInputSchema.parse(parseJson(input, 36));
  if (expected.kind === 'unknown') return { verdict: 'inconclusive', code: expected.code };
  if (probe.transportError) return { verdict: 'inconclusive', code: 'TRANSPORT_ERROR' };
  function containsMarker(node: Json): boolean {
    if (typeof node === 'string') return node.includes(fixtureMarker);
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(containsMarker);
    return Object.entries(node).some(([key, value]) => key.includes(fixtureMarker) || containsMarker(value));
  }
  const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const allows = probe.status === 200 && record?.fixtureMarker === fixtureMarker;
  const leaks = containsMarker(body);
  const denies = probe.denialStatuses.includes(probe.status) && record?.error === 'ACCESS_DENIED' && !leaks;
  if (expected.kind === 'deny' && leaks) return { verdict: 'fail', code: 'PROTECTED_DATA_LEAK' };
  if (expected.kind === 'allow' && allows) return { verdict: 'pass', code: 'ACCESS_ALLOWED' };
  if (expected.kind === 'deny' && denies) return { verdict: 'pass', code: 'ACCESS_DENIED' };
  if (expected.kind === 'allow' && denies) return { verdict: 'fail', code: 'PAID_ACCESS_DENIED' };
  return { verdict: 'inconclusive', code: 'UNRECOGNIZED_RESPONSE' };
}
