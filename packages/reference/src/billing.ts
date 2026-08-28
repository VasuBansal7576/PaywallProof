import { z } from 'zod';
import { PolarSandboxReader } from '../../adapters/src/polar.ts';
import { TargetError, type BillingUpdate, type User } from './store';

const id = z.string().min(1).max(255);
const unixTime = z.number().int().nonnegative().max(8_640_000_000_000);
const reference = z.union([id, z.object({ id })]);
const resourceId = (value: z.infer<typeof reference>) => typeof value === 'string' ? value : value.id;
export const eventSchema = z.object({
  id, type: id, livemode: z.literal(false), created: unixTime,
  data: z.object({ object: z.unknown() }),
});
const subscriptionSchema = z.object({
  id, object: z.literal('subscription'), livemode: z.literal(false), customer: reference,
  status: z.enum(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']),
  metadata: z.record(z.string(), z.string()), cancel_at_period_end: z.boolean(),
  items: z.object({ data: z.array(z.object({
    price: z.object({ id, livemode: z.literal(false).optional() }),
    current_period_end: unixTime,
  })).length(1), has_more: z.literal(false).optional() }),
  latest_invoice: z.unknown().optional(),
});
const replayInvoiceSchema = z.object({
  id: id.optional(), object: z.literal('invoice').optional(), livemode: z.literal(false),
  status: z.string().nullable(), customer: reference.optional(),
  billing_reason: z.string().nullable().optional(),
  subscription: reference.nullable().optional(),
  parent: z.object({ subscription_details: z.object({ subscription: reference }).nullable() }).nullable().optional(),
});
export type VerifiedEvent = z.infer<typeof eventSchema>;

export function eventSubscription(event: VerifiedEvent): { customerId: string; subscriptionId: string } | undefined {
  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
    const object = z.object({ id, customer: reference, object: z.literal('subscription') }).parse(event.data.object);
    return { customerId: resourceId(object.customer), subscriptionId: object.id };
  }
  if (['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type)) {
    const invoice = replayInvoiceSchema.parse(event.data.object);
    const subscription = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
    if (!subscription || !invoice.customer) throw new TargetError('UNSUPPORTED_INVOICE_SHAPE', 422);
    return { customerId: resourceId(invoice.customer), subscriptionId: resourceId(subscription) };
  }
  return undefined;
}

function normalizeSubscription(input: unknown, user: User, priceId: string): BillingUpdate {
  const subscription = subscriptionSchema.parse(input);
  if (resourceId(subscription.customer) !== user.customer_id || subscription.metadata.runId !== user.run_id) throw new TargetError('RUN_OWNERSHIP_MISMATCH', 403);
  const [item] = subscription.items.data;
  if (!item) throw new TargetError('UNSUPPORTED_SUBSCRIPTION_SHAPE', 422);
  if (item.price.id !== priceId) throw new TargetError('PRICE_MISMATCH', 422);
  return {
    customerId: resourceId(subscription.customer), subscriptionId: subscription.id,
    priceId: item.price.id, status: subscription.status, initialPaymentConfirmed: false,
    cancelAtPeriodEnd: subscription.cancel_at_period_end, periodEnd: item.current_period_end,
  };
}

export function replayBilling(event: VerifiedEvent, user: User, priceId: string): BillingUpdate {
  if (!event.type.startsWith('customer.subscription.')) throw new TargetError('REPLAY_REQUIRES_SUBSCRIPTION_EVENT', 422);
  const subscription = subscriptionSchema.parse(event.data.object);
  const billing = normalizeSubscription(subscription, user, priceId);
  const invoice = subscription.latest_invoice === undefined || subscription.latest_invoice === null ? null : replayInvoiceSchema.parse(subscription.latest_invoice);
  if (invoice?.customer && resourceId(invoice.customer) !== billing.customerId) throw new TargetError('INVOICE_CUSTOMER_MISMATCH', 403);
  for (const invoiceSubscription of [invoice?.parent?.subscription_details?.subscription, invoice?.subscription]) {
    if (invoiceSubscription && resourceId(invoiceSubscription) !== billing.subscriptionId) throw new TargetError('INVOICE_SUBSCRIPTION_MISMATCH', 403);
  }
  // A first paid creation invoice establishes this fact; renewals cannot erase it.
  const paidCreation = invoice?.status === 'paid' && (!invoice.billing_reason || invoice.billing_reason === 'subscription_create');
  billing.initialPaymentConfirmed = paidCreation || (user.subscription_id === billing.subscriptionId && user.initial_payment_confirmed === 1);
  if (event.type === 'customer.subscription.deleted' && billing.status !== 'canceled') throw new TargetError('EVENT_STATUS_MISMATCH', 422);
  return billing;
}

export function createPolarReader(config: { token?: string; organizationId?: string; productId?: string; priceId: string }): PolarSandboxReader | undefined {
  if (config.token === undefined && config.organizationId === undefined && config.productId === undefined) return undefined;
  return new PolarSandboxReader(config);
}

export async function verifyCustomer(provider: PolarSandboxReader, customerId: string, runId: string): Promise<void> {
  await provider.customer({ customerId, runId });
}

export async function providerBilling(provider: PolarSandboxReader, subscriptionId: string, user: User, priceId: string): Promise<BillingUpdate> {
  if (!user.customer_id) throw new TargetError('CUSTOMER_NOT_OWNED', 403);
  const facts = await provider.observe({ runId: user.run_id, customerId: user.customer_id, subscriptionId });
  if (facts.subscription.prices[0]?.id !== priceId) throw new TargetError('PRICE_MISMATCH', 422);
  return { customerId: facts.customer.id, subscriptionId: facts.subscription.id, priceId,
    status: facts.subscription.status, initialPaymentConfirmed: facts.initialPaymentConfirmed,
    cancelAtPeriodEnd: facts.subscription.cancel_at_period_end, periodEnd: facts.periodEnd };
}

export const polarEventSchema = z.object({ type: id, timestamp: z.iso.datetime({offset:true}), data: z.unknown() });
export function polarEventSubscription(event: z.infer<typeof polarEventSchema>) {
  if (event.type.startsWith('subscription.')) {
    const data = z.object({id:z.uuid(),customer_id:z.uuid()}).parse(event.data);
    return {customerId:data.customer_id,subscriptionId:data.id};
  }
  if (event.type.startsWith('order.')) {
    const data = z.object({customer_id:z.uuid(),subscription_id:z.uuid().nullable()}).parse(event.data);
    if (data.subscription_id) return {customerId:data.customer_id,subscriptionId:data.subscription_id};
  }
  return undefined;
}
