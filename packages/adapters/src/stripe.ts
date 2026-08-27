import Stripe from 'stripe';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { billingSchema, hashValue, type Billing } from '../../core/src/index.ts';

export const STRIPE_API_VERSION = '2026-08-26.dahlia';
export class ProviderError extends Error {
  constructor(readonly code:string) { super(code); }
}
const resourceSchema = z.object({id:z.string(),run_id:z.string(),kind:z.enum(['clock','customer','subscription']),parent_id:z.string().nullable(),receipt:z.string()});
type Resource = z.infer<typeof resourceSchema>;
export type StripeMutationKind = 'create_clock'|'create_customer'|'create_subscription'|'schedule_cancellation'|'advance_clock'|'cleanup';
function testMode(object: {livemode:boolean}) { if (object.livemode !== false) throw new ProviderError('LIVE_MODE_REJECTED'); }
function objectId(value: string | {id:string}):string { return typeof value === 'string' ? value : value.id; }

/** Credentials and resource inventory remain in the trusted worker, never the agent sandbox. */
export class StripeSandboxAdapter {
  private readonly stripe: Stripe;
  private readonly database:Database.Database;
  private readonly beforeMutation: ((runId:string,kind:StripeMutationKind)=>void)|undefined;
  private verifiedAccount: string | null = null;
  constructor(config:{key:string;databasePath:string;priceId:string;accountId:string;beforeMutation?:(runId:string,kind:StripeMutationKind)=>void}) {
    if (!/^(sk|rk)_test_/.test(config.key)) throw new ProviderError('LIVE_MODE_REJECTED');
    this.config = {priceId:config.priceId,accountId:config.accountId};
    this.beforeMutation = config.beforeMutation;
    this.stripe = new Stripe(config.key,{apiVersion:STRIPE_API_VERSION,timeout:30_000,maxNetworkRetries:1});
    this.database = new Database(config.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec('CREATE TABLE IF NOT EXISTS provider_resources(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT,receipt TEXT NOT NULL, UNIQUE(run_id,kind)); CREATE TABLE IF NOT EXISTS provider_intents(operation_id TEXT PRIMARY KEY,args_hash TEXT NOT NULL,started_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS provider_slots(run_id TEXT NOT NULL,kind TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(run_id,kind));');
  }
  readonly config:{priceId:string;accountId:string};
  async preflight() {
    const account = await this.stripe.accounts.retrieveCurrent();
    if (account.id !== this.config.accountId) throw new ProviderError('ACCOUNT_MISMATCH');
    const price = await this.stripe.prices.retrieve(this.config.priceId);
    testMode(price);
    if (!price.active || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.billing_scheme !== 'per_unit') throw new ProviderError('UNSUPPORTED_PRICE');
    this.verifiedAccount = account.id;
    return {accountId:account.id,priceId:price.id,livemode:false,apiVersion:STRIPE_API_VERSION};
  }
  private guard() { if (this.verifiedAccount !== this.config.accountId) throw new ProviderError('PREFLIGHT_REQUIRED'); }
  private slot(runId:string,kind:string,operationId:string) {
    this.guard();
    this.database.transaction(()=>{
      const row=this.database.prepare('SELECT operation_id FROM provider_slots WHERE run_id=? AND kind=?').get(runId,kind);
      if(row&&z.object({operation_id:z.string()}).parse(row).operation_id!==operationId)throw new ProviderError('RECONCILIATION_REQUIRED');
      if(!row)this.database.prepare('INSERT INTO provider_slots VALUES(?,?,?)').run(runId,kind,operationId);
    }).immediate();
  }
  private intent(operationId:string,args:unknown):string {
    this.guard();
    const hash = hashValue(args);
    const row = this.database.prepare('SELECT args_hash,started_at FROM provider_intents WHERE operation_id=?').get(operationId);
    if (row) {
      const previous = z.object({args_hash:z.string(),started_at:z.number()}).parse(row);
      if (hash !== previous.args_hash) throw new ProviderError('OPERATION_CONFLICT');
      if (Date.now()-previous.started_at >= 23*60*60*1000) throw new ProviderError('RECONCILIATION_REQUIRED');
    } else this.database.prepare('INSERT INTO provider_intents VALUES(?,?,?)').run(operationId,hash,Date.now());
    return `paywallproof:${operationId}:${hash}`;
  }
  private record(runId:string,kind:Resource['kind'],id:string,parent:string|null,receipt:unknown) {
    const existing = this.database.prepare('SELECT * FROM provider_resources WHERE run_id=? AND kind=?').get(runId,kind);
    if (existing && resourceSchema.parse(existing).id !== id) throw new ProviderError('RESOURCE_LIMIT');
    this.database.prepare('INSERT INTO provider_resources VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id,runId,kind,parent,JSON.stringify(receipt));
    return id;
  }
  resource(runId:string,kind:Resource['kind']):Resource {
    const row = this.database.prepare('SELECT * FROM provider_resources WHERE run_id=? AND kind=?').get(runId,kind);
    if (!row) throw new ProviderError('OWNERSHIP_MISMATCH');
    return resourceSchema.parse(row);
  }
  listOwned(runId:string) {
    return this.database.prepare('SELECT * FROM provider_resources WHERE run_id=? ORDER BY kind,id').all(runId).map(row=>{
      const resource=resourceSchema.parse(row);
      return {id:resource.id,runId:resource.run_id,kind:resource.kind,parentId:resource.parent_id};
    });
  }
  private async clock(runId:string) {
    const owned = this.resource(runId,'clock');
    const clock = await this.stripe.testHelpers.testClocks.retrieve(owned.id);
    testMode(clock);
    if (clock.id !== owned.id) throw new ProviderError('OWNERSHIP_MISMATCH');
    return clock;
  }
  private async customer(runId:string) {
    const owned = this.resource(runId,'customer');
    const customer = await this.stripe.customers.retrieve(owned.id);
    if (customer.deleted) throw new ProviderError('RESOURCE_DELETED');
    testMode(customer);
    if(customer.metadata.runId!==runId||!customer.test_clock||objectId(customer.test_clock)!==this.resource(runId,'clock').id) throw new ProviderError('OWNERSHIP_MISMATCH');
    return customer;
  }
  async createClock(runId:string,operationId:string) {
    this.slot(runId,'clock',operationId);
    const args = {runId,kind:'clock'};
    const key = this.intent(operationId,args);
    // Persist the frozen time in the intent receipt before a retry can choose a different timestamp.
    const row = z.object({started_at:z.number()}).parse(this.database.prepare('SELECT started_at FROM provider_intents WHERE operation_id=?').get(operationId));
    const params = {frozen_time:Math.floor(row.started_at/1000),name:`PaywallProof ${runId}`};
    const options = {idempotencyKey:key,maxNetworkRetries:0};
    this.beforeMutation?.(runId,'create_clock');
    const clock = await this.stripe.testHelpers.testClocks.create(params,options);
    testMode(clock);
    this.record(runId,'clock',clock.id,null,clock);
    return {clockId:clock.id,billingTime:clock.frozen_time};
  }
  async createCustomer(runId:string,operationId:string) {
    this.slot(runId,'customer',operationId);
    const clock = await this.clock(runId);
    if (clock.status !== 'ready') throw new ProviderError('CLOCK_NOT_READY');
    const args = {test_clock:clock.id,metadata:{runId},payment_method:'pm_card_visa',invoice_settings:{default_payment_method:'pm_card_visa'}};
    const options = {idempotencyKey:this.intent(operationId,args),maxNetworkRetries:0};
    this.beforeMutation?.(runId,'create_customer');
    const customer = await this.stripe.customers.create(args,options);
    testMode(customer);
    if (!customer.test_clock||objectId(customer.test_clock)!==clock.id||customer.metadata.runId!==runId) throw new ProviderError('OWNERSHIP_MISMATCH');
    this.record(runId,'customer',customer.id,clock.id,customer);
    return {customerId:customer.id};
  }
  async createSubscription(runId:string,operationId:string) {
    this.slot(runId,'subscription',operationId);
    const customer = await this.customer(runId);
    const args = {customer:customer.id,items:[{price:this.config.priceId}],metadata:{runId},payment_behavior:'error_if_incomplete',billing_mode:{type:'classic'}} satisfies Stripe.SubscriptionCreateParams;
    const options = {idempotencyKey:this.intent(operationId,args),maxNetworkRetries:0};
    this.beforeMutation?.(runId,'create_subscription');
    const subscription = await this.stripe.subscriptions.create(args,options);
    testMode(subscription);
    if (objectId(subscription.customer)!==customer.id||subscription.metadata.runId!==runId) throw new ProviderError('OWNERSHIP_MISMATCH');
    this.record(runId,'subscription',subscription.id,customer.id,subscription);
    return {subscriptionId:subscription.id};
  }
  async scheduleCancellation(runId:string,operationId:string) {
    this.slot(runId,'schedule',operationId);
    await this.observe(runId);
    const subscription = this.resource(runId,'subscription');
    const args = {id:subscription.id,cancel_at_period_end:true};
    const options = {idempotencyKey:this.intent(operationId,args),maxNetworkRetries:0};
    this.beforeMutation?.(runId,'schedule_cancellation');
    const updated = await this.stripe.subscriptions.update(subscription.id,{cancel_at_period_end:true},options);
    testMode(updated);
    return {subscriptionId:updated.id,cancelAtPeriodEnd:updated.cancel_at_period_end};
  }
  async advanceClock(runId:string,operationId:string) {
    this.slot(runId,'advance',operationId);
    const billing = await this.observe(runId);
    if (!billing.subscription || !billing.subscription.cancelAtPeriodEnd || billing.subscription.status!=='active') throw new ProviderError('CANCELLATION_REQUIRED');
    const clock = await this.clock(runId);
    if(clock.status!=='ready') throw new ProviderError('CLOCK_NOT_READY');
    const frozenTime = billing.subscription.periodEnd+1;
    if(frozenTime<=clock.frozen_time||frozenTime-clock.frozen_time>63*86400) throw new ProviderError('CLOCK_ADVANCEMENT_BOUND');
    const args = {id:clock.id,frozen_time:frozenTime};
    const options = {idempotencyKey:this.intent(operationId,args),maxNetworkRetries:0};
    this.beforeMutation?.(runId,'advance_clock');
    const updated = await this.stripe.testHelpers.testClocks.advance(clock.id,{frozen_time:frozenTime},options);
    testMode(updated);
    return {clockId:updated.id,status:updated.status,billingTime:updated.frozen_time};
  }
  async observe(runId:string):Promise<Billing> {
    this.guard();
    const customer = await this.customer(runId);
    const clock = await this.clock(runId);
    if(clock.status!=='ready') throw new ProviderError('CLOCK_NOT_READY');
    const subscriptions = await this.stripe.subscriptions.list({customer:customer.id,status:'all',limit:2});
    if(subscriptions.has_more||subscriptions.data.length!==1) throw new ProviderError('SUBSCRIPTION_IDENTITY_UNRESOLVED');
    const subscription = subscriptions.data[0];
    if(!subscription) throw new ProviderError('SUBSCRIPTION_IDENTITY_UNRESOLVED');
    testMode(subscription);
    if(subscription.id!==this.resource(runId,'subscription').id||subscription.metadata.runId!==runId||objectId(subscription.customer)!==customer.id) throw new ProviderError('OWNERSHIP_MISMATCH');
    if(subscription.items.has_more||subscription.items.data.length!==1) throw new ProviderError('UNSUPPORTED_SUBSCRIPTION');
    const item = subscription.items.data[0];
    if(!item) throw new ProviderError('UNSUPPORTED_SUBSCRIPTION');
    testMode(item.price);
    if(item.price.id!==this.config.priceId) throw new ProviderError('PRICE_MISMATCH');
    const invoices = await this.stripe.invoices.list({customer:customer.id,subscription:subscription.id,limit:100});
    invoices.data.forEach(testMode);
    const initial = invoices.data.filter(invoice=>invoice.billing_reason==='subscription_create');
    const invoice = initial[0];
    if(invoices.has_more||initial.length!==1||!invoice||!invoice.customer||objectId(invoice.customer)!==customer.id||!invoice.parent?.subscription_details||objectId(invoice.parent.subscription_details.subscription)!==subscription.id) throw new ProviderError('INITIAL_INVOICE_UNRESOLVED');
    return billingSchema.parse({livemode:false,identityResolved:true,noSubscriptionConfirmed:false,customerId:customer.id,subscription:{id:subscription.id,customerId:customer.id,priceId:item.price.id,status:subscription.status,initialInvoicePaid:invoice.status==='paid',cancelAtPeriodEnd:subscription.cancel_at_period_end,periodEnd:item.current_period_end,billingTime:clock.frozen_time}});
  }
  async cleanup(runId:string) {
    this.guard();
    const clock = await this.clock(runId);
    if(clock.status!=='ready')throw new ProviderError('CLOCK_NOT_READY');
    const owned = this.listOwned(runId);
    const expectedCustomers = owned.filter(resource=>resource.kind==='customer');
    const expectedSubscriptions = owned.filter(resource=>resource.kind==='subscription');
    // List through the clock: unfiltered customer lists omit test-clock customers.
    // The approved scope is one customer/subscription, so extra pages are a failure, not truncation.
    const customers = await this.stripe.customers.list({test_clock:clock.id,limit:2});
    if(customers.has_more||customers.data.length!==expectedCustomers.length)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
    const seenSubscriptions = new Set<string>();
    for(const customer of customers.data) {
      testMode(customer);
      const recorded = expectedCustomers.find(resource=>resource.id===customer.id);
      if(!recorded||recorded.parentId!==clock.id||customer.metadata.runId!==runId||!customer.test_clock||objectId(customer.test_clock)!==clock.id)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
      const subscriptions = await this.stripe.subscriptions.list({customer:customer.id,status:'all',limit:2});
      const expected = expectedSubscriptions.filter(resource=>resource.parentId===customer.id);
      if(subscriptions.has_more||subscriptions.data.length!==expected.length)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
      for(const subscription of subscriptions.data) {
        testMode(subscription);
        if(!expected.some(resource=>resource.id===subscription.id)||subscription.metadata.runId!==runId||objectId(subscription.customer)!==customer.id||!subscription.test_clock||objectId(subscription.test_clock)!==clock.id)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
        if(subscription.items.has_more||subscription.items.data.length!==1)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
        for(const item of subscription.items.data) {
          testMode(item.price);
          if(item.price.id!==this.config.priceId)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
        }
        seenSubscriptions.add(subscription.id);
      }
      // Invoices generated by our subscription inherit its ownership; standalone or
      // foreign-subscription invoices are not part of the approved simulation.
      const invoices = await this.stripe.invoices.list({customer:customer.id,limit:100});
      if(invoices.has_more)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
      for(const invoice of invoices.data) {
        testMode(invoice);
        const parent = invoice.parent?.subscription_details?.subscription;
        if(!invoice.customer||objectId(invoice.customer)!==customer.id||!parent||!seenSubscriptions.has(objectId(parent)))throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
      }
      // Period-end cancellation does not create a Subscription Schedule. Any such
      // schedule belongs to work outside this product's recorded resource inventory.
      const schedules = await this.stripe.subscriptionSchedules.list({customer:customer.id,limit:1});
      schedules.data.forEach(testMode);
      if(schedules.has_more||schedules.data.length>0)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
    }
    if(seenSubscriptions.size!==expectedSubscriptions.length)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
    // This product never creates quotes, but a quote can be attached directly to a clock.
    const quotes = await this.stripe.quotes.list({test_clock:clock.id,limit:1});
    quotes.data.forEach(testMode);
    if(quotes.has_more||quotes.data.length>0)throw new ProviderError('CLEANUP_OWNERSHIP_UNRESOLVED');
    this.beforeMutation?.(runId,'cleanup');
    const result = await this.stripe.testHelpers.testClocks.del(clock.id,{},{maxNetworkRetries:0});
    if(result.id!==clock.id||result.deleted!==true)throw new ProviderError('CLEANUP_OUTCOME_UNKNOWN');
    return {clockId:result.id,deleted:result.deleted};
  }
  close() { this.database.close(); }
}
