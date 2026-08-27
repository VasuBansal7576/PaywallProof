import Database from 'better-sqlite3';
import Stripe from 'stripe';
import { z } from 'zod';
import { billingSchema, type Billing } from '../../core/src/index.ts';
import { TargetTransport } from './network.ts';

/** Explicit synthetic lifecycle for local testing. This adapter never calls Stripe. */
export class LocalReplayAdapter {
  private readonly database:Database.Database;
  constructor(readonly config:{databasePath:string;priceId:string;adapterToken:string;replaySecret:string;transport:TargetTransport;beforeMutation?:(runId:string)=>void}) {
    this.database=new Database(config.databasePath);
    this.database.exec('CREATE TABLE IF NOT EXISTS replay_billing(run_id TEXT PRIMARY KEY,billing TEXT NOT NULL);');
  }
  createCustomer(runId:string) {return {customerId:`cus_replay_${runId}`};}
  async createSubscription(runId:string,operationId:string) {
    const existing=this.database.prepare('SELECT billing FROM replay_billing WHERE run_id=?').get(runId);
    const billing:Billing = existing ? billingSchema.parse(JSON.parse(z.object({billing:z.string()}).parse(existing).billing)) : {
      livemode:false,identityResolved:true,noSubscriptionConfirmed:false,customerId:`cus_replay_${runId}`,
      subscription:{id:`sub_replay_${runId}`,customerId:`cus_replay_${runId}`,priceId:this.config.priceId,status:'active',initialInvoicePaid:true,cancelAtPeriodEnd:false,periodEnd:Math.floor(Date.now()/1000)+30*86400,billingTime:Math.floor(Date.now()/1000)},
    };
    this.save(runId,billing);
    await this.deliver(runId,operationId,'customer.subscription.created',billing);
    return {subscriptionId:billing.subscription?.id,mode:'local_replay'};
  }
  private save(runId:string,billing:Billing) {this.database.prepare('INSERT INTO replay_billing VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET billing=excluded.billing').run(runId,JSON.stringify(billing));}
  observe(runId:string):Billing {
    const row=this.database.prepare('SELECT billing FROM replay_billing WHERE run_id=?').get(runId);
    if(!row) throw new Error('REPLAY_SUBSCRIPTION_MISSING');
    return billingSchema.parse(JSON.parse(z.object({billing:z.string()}).parse(row).billing));
  }
  async scheduleCancellation(runId:string,operationId:string) {
    const billing=this.observe(runId);
    if(!billing.subscription) throw new Error('REPLAY_SUBSCRIPTION_MISSING');
    billing.subscription.cancelAtPeriodEnd=true;this.save(runId,billing);
    await this.deliver(runId,operationId,'customer.subscription.updated',billing);
    return {subscriptionId:billing.subscription.id,mode:'local_replay'};
  }
  async advanceClock(runId:string,operationId:string) {
    const billing=this.observe(runId);
    if(!billing.subscription||!billing.subscription.cancelAtPeriodEnd) throw new Error('REPLAY_SCHEDULE_REQUIRED');
    billing.subscription.billingTime=billing.subscription.periodEnd+1;billing.subscription.status='canceled';this.save(runId,billing);
    await this.deliver(runId,operationId,'customer.subscription.deleted',billing);
    return {billingTime:billing.subscription.billingTime,mode:'local_replay'};
  }
  private async deliver(runId:string,operationId:string,type:string,billing:Billing) {
    const subscription=billing.subscription;
    if(!subscription) throw new Error('REPLAY_SUBSCRIPTION_MISSING');
    const event={id:`evt_replay_${operationId}`,object:'event',type,livemode:false,created:subscription.billingTime,data:{object:{
      id:subscription.id,object:'subscription',livemode:false,customer:subscription.customerId,metadata:{runId},status:subscription.status,cancel_at_period_end:subscription.cancelAtPeriodEnd,
      items:{data:[{price:{id:subscription.priceId,livemode:false},current_period_end:subscription.periodEnd}],has_more:false},
      latest_invoice:{id:`in_replay_${runId}`,object:'invoice',livemode:false,status:'paid',customer:subscription.customerId,billing_reason:'subscription_create',parent:{subscription_details:{subscription:subscription.id}}},
    }}};
    const payload=JSON.stringify(event);
    const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:this.config.replaySecret});
    const response=await this.config.transport.request('/staging/replay',{method:'POST',body:payload,headers:{Authorization:`Bearer ${this.config.adapterToken}`,'Content-Type':'application/json','Stripe-Signature':signature},beforeDispatch:()=>this.config.beforeMutation?.(runId)});
    if(response.status!==200) throw new Error(`REPLAY_DELIVERY_${response.status}`);
  }
  close(){this.database.close();}
}
