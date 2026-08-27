import Stripe from 'stripe';
import { z } from 'zod';
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
    priceId: item.price.id, status: subscription.status, initialInvoicePaid: false,
    cancelAtPeriodEnd: subscription.cancel_at_period_end, periodEnd: item.current_period_end,
  };
}

export function replayBilling(event: VerifiedEvent, user: User, priceId: string): BillingUpdate {
  if (!event.type.startsWith('customer.subscription.')) throw new TargetError('REPLAY_REQUIRES_SUBSCRIPTION_EVENT', 422);
  const subscription = subscriptionSchema.parse(event.data.object);
  const billing = normalizeSubscription(subscription, user, priceId);
  const invoice = replayInvoiceSchema.parse(subscription.latest_invoice);
  if (invoice.customer && resourceId(invoice.customer) !== billing.customerId) throw new TargetError('INVOICE_CUSTOMER_MISMATCH', 403);
  const invoiceSubscription = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  if (invoiceSubscription && resourceId(invoiceSubscription) !== billing.subscriptionId) throw new TargetError('INVOICE_SUBSCRIPTION_MISMATCH', 403);
  // A first paid creation invoice establishes this fact; renewals cannot erase it.
  const paidCreation = invoice.status === 'paid' && (!invoice.billing_reason || invoice.billing_reason === 'subscription_create');
  billing.initialInvoicePaid = paidCreation || (user.subscription_id === billing.subscriptionId && user.initial_invoice_paid === 1);
  if (event.type === 'customer.subscription.deleted' && billing.status !== 'canceled') throw new TargetError('EVENT_STATUS_MISMATCH', 422);
  return billing;
}

export function createStripeReader(key: string | undefined): Stripe | undefined {
  if (!key) return undefined;
  if (!/^(sk|rk)_test_/.test(key)) throw new TargetError('TEST_STRIPE_KEY_REQUIRED', 400);
  return new Stripe(key, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 1, timeout: 10_000 });
}

export async function verifyCustomer(stripe: Stripe, customerId: string, runId: string): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted || customer.livemode !== false || customer.metadata.runId !== runId) throw new TargetError('CUSTOMER_NOT_OWNED', 403);
}

export async function providerBilling(stripe: Stripe, subscriptionId: string, user: User, priceId: string): Promise<BillingUpdate> {
  if (!user.customer_id) throw new TargetError('CUSTOMER_NOT_OWNED', 403);
  await verifyCustomer(stripe, user.customer_id, user.run_id);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
  const billing = normalizeSubscription(subscription, user, priceId);
  // Validate each provider resource before allowing it to contribute to entitlement.
  const [item] = subscription.items.data;
  if (!item || item.price.livemode !== false) throw new TargetError('LIVE_MODE_REJECTED', 403);
  const subscriptions = await stripe.subscriptions.list({ customer: user.customer_id, status: 'all', limit: 2 });
  if (subscriptions.has_more || subscriptions.data.length !== 1 || subscriptions.data[0]?.id !== subscriptionId) throw new TargetError('MULTIPLE_SUBSCRIPTIONS_UNSUPPORTED', 422);
  if (subscriptions.data.some(candidate => candidate.livemode !== false)) throw new TargetError('LIVE_MODE_REJECTED', 403);
  const invoices = await stripe.invoices.list({ customer: user.customer_id, subscription: subscriptionId, limit: 100 });
  if (invoices.data.some(invoice => invoice.livemode !== false)) throw new TargetError('LIVE_MODE_REJECTED', 403);
  const initialInvoices = invoices.data.filter(invoice => invoice.billing_reason === 'subscription_create');
  if (initialInvoices.length !== 1) throw new TargetError('INITIAL_INVOICE_UNRESOLVED', 422);
  const [initial] = initialInvoices;
  if (!initial || !initial.customer || resourceId(initial.customer) !== user.customer_id || initial.parent?.subscription_details?.subscription !== subscriptionId) throw new TargetError('INVOICE_IDENTITY_MISMATCH', 403);
  billing.initialInvoicePaid = initial.status === 'paid';
  return billing;
}
