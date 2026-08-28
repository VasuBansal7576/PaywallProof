import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {serve} from '@hono/node-server';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReferenceApp} from '../../reference/src/index.ts';
import {ReferenceTargetAdapter,TargetTransport} from '../../adapters/src/network.ts';
import {probeRepairSecurity,SECURITY_CONTROLS} from './controls.ts';

// Implementation-aware controls test against a real loopback HTTP target.
// Billing events and credentials are synthetic. No model or provider is called.
let directory:string,reference:ReturnType<typeof createReferenceApp>,server:ReturnType<typeof serve>;
let input:Parameters<typeof probeRepairSecurity>[0],target:ReferenceTargetAdapter;
let fault:'none'|'public-export'|'mutate-and-deny'|'server-error',requests:number;
beforeEach(async()=>{
  vi.stubEnv('NODE_ENV','test');fault='none';requests=0;
  directory=await mkdtemp(join(tmpdir(),'pp-security-controls-'));
  const adapterToken='synthetic-adapter',replaySecret='synthetic-replay-secret',webhookSecret='synthetic-other-secret',runId=randomUUID();
  reference=createReferenceApp({databasePath:join(directory,'target.sqlite'),stagingEnabled:true,adapterToken,replaySecret,webhookSecret,priceId:'price_synthetic',buildId:'a'.repeat(40)});
  const origin=await new Promise<string>((resolve,reject)=>{
    server=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
      requests++;const path=new URL(request.url).pathname;
      if(fault==='public-export'&&path==='/api/export')return Response.json({fixtureMarker:'synthetic-leak'});
      if(fault==='server-error'&&path==='/api/me')return Response.json({error:'SYNTHETIC_FAILURE'},{status:500});
      if(fault==='mutate-and-deny'&&path==='/staging/replay'&&!request.headers.has('Authorization')){
        const headers=new Headers(request.headers);headers.set('Authorization',`Bearer ${adapterToken}`);
        await reference.app.fetch(new Request(request,{headers}));
        return Response.json({error:'AUTH_REQUIRED'},{status:401});
      }
      return reference.app.fetch(request);
    }},info=>resolve(`http://127.0.0.1:${info.port}`));
    server.once('error',reject);
  });
  const transport=new TargetTransport({origin,allowLoopback:true});target=new ReferenceTargetAdapter(transport,adapterToken);
  const principal=await target.createUser({runId,operationId:randomUUID(),fixtureMarker:randomUUID()}),customerId=`cus_replay_${randomUUID().replaceAll('-','')}`;
  await target.linkCustomer({runId,principalId:principal.principalId,customerId});
  const now=Math.floor(Date.now()/1000),subscriptionId=`sub_replay_${randomUUID().replaceAll('-','')}`;
  const activationPayload=JSON.stringify({id:`evt_repair_${runId}`,type:'customer.subscription.created',livemode:false,created:now,data:{object:{id:subscriptionId,object:'subscription',livemode:false,customer:customerId,metadata:{runId},status:'active',cancel_at_period_end:false,items:{data:[{price:{id:'price_synthetic',livemode:false},current_period_end:now+3600}],has_more:false},latest_invoice:{id:'in_synthetic',object:'invoice',livemode:false,status:'paid',customer:customerId,billing_reason:'subscription_create',parent:{subscription_details:{subscription:subscriptionId}}}}}});
  input={transport,adapterToken,replaySecret,webhookSecret,runId,principalId:principal.principalId,activationPayload,signal:new AbortController().signal};
});
afterEach(async()=>{
  if(server?.listening)await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());if('closeAllConnections' in server)server.closeAllConnections();});
  reference.close();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});
});
describe('repair security controls against real local handlers',()=>{
  it('requires all fourteen negative controls and unchanged billing state',async()=>{
    const results=await probeRepairSecurity(input);
    expect(results.map(result=>result.id)).toEqual(SECURITY_CONTROLS);
    expect(results.filter(result=>result.outcome!=='pass')).toEqual([]);
    expect(await target.snapshot({runId:input.runId,principalId:input.principalId})).toMatchObject({status:'none',initialPaymentConfirmed:false});
  });
  it('rejects an export route that grants access without a session',async()=>{
    fault='public-export';
    expect((await probeRepairSecurity(input)).filter(result=>result.outcome==='fail').map(result=>result.id)).toEqual(['AUTH_EXPORT_MISSING','AUTH_EXPORT_INVALID']);
  });
  it('detects a billing write hidden behind a denial response',async()=>{
    fault='mutate-and-deny';
    expect((await probeRepairSecurity(input)).find(result=>result.id==='REPLAY_AUTH_MISSING')).toMatchObject({actualStatus:401,expectedStatus:401,outcome:'fail'});
    expect(await target.snapshot({runId:input.runId,principalId:input.principalId})).toMatchObject({status:'active'});
  });
  it('does not treat server errors as successful authorization denial',async()=>{
    fault='server-error';
    expect((await probeRepairSecurity(input)).filter(result=>result.outcome==='fail').map(result=>result.id)).toEqual(['AUTH_ME_MISSING','AUTH_ME_INVALID']);
  });
  it('honors cancellation before sending any control requests',async()=>{
    const abort=new AbortController();abort.abort();const before=requests;
    await expect(probeRepairSecurity({...input,signal:abort.signal})).rejects.toThrow();
    expect(requests).toBe(before);
  });
});
