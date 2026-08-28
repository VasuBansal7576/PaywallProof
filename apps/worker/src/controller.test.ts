import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller,type ControllerConfig} from './controller.ts';
import {createControlApp} from './http.ts';
import {createPolicy,hashValue} from '../../../packages/core/src/index.ts';
import {observeFeature} from '../../../packages/evidence/src/probe.ts';
import {TrueForgeAdapter,type RuntimeTurn,type RuntimeApproval} from '../../../packages/adapters/src/trueforge.ts';
import {patchHash,repairBranch} from '../../../packages/repair/src/index.ts';
import type {RepairJob} from './repairs.ts';
import {SECURITY_CONTROLS} from '../../../packages/repair/src/controls.ts';
import {artifactRetentionFromDays} from './artifacts.ts';

// Implementation-aware failure-injection tests. No provider or runtime evidence.
const opened:{controller:Controller;directory:string}[]=[];
const feature={id:'pro_export',method:'GET',path:'/api/export',denialStatuses:[403],browserPath:'/dashboard',actionTestId:'export-button',resultTestId:'export-result'} as const;
function setup(http=false,overrides:Pick<ControllerConfig,'artifactRetentionMs'>={}) {
  const directory=mkdtempSync(join(tmpdir(),'pp-startup-'));
  const config={databasePath:join(directory,'control.sqlite'),artifactDirectory:join(directory,'artifacts'),targetOrigin:'http://127.0.0.1:39981',workerOrigin:'http://127.0.0.1:39982',webOrigin:'http://127.0.0.1:39983',adapterToken:'synthetic-adapter',operatorToken:'synthetic-operator',replaySecret:'synthetic-replay',repository:'synthetic/repository',defaultRef:'a'.repeat(40),priceId:'price_synthetic',runtimeUrl:'http://127.0.0.1:39984',model:'synthetic'};
  const configured={...config,...overrides};
  const service=http?createControlApp(configured):null;
  const controller=service?.controller??new Controller(configured);
  opened.push({controller,directory});
  vi.spyOn(controller.target,'describe').mockResolvedValue({adapterVersion:'1',environment:'test',buildId:'a'.repeat(40),billingTimeModel:'provider_status',feature:{...feature,denialStatuses:[403]}});
  vi.spyOn(controller.runtime,'checkConnection').mockResolvedValue({model:'synthetic',local:true});
  const cancel=vi.spyOn(controller.runtime,'cancel').mockResolvedValue({});
  const project=controller.createProject({name:'Startup failure checks',repository:'synthetic/repository',ref:'a'.repeat(40),targetId:'reference',ownershipConfirmed:true,modelConsent:true});
  async function start(){const policy=await controller.proposePolicy(project.id,{schemaVersion:2,priceId:'price_synthetic',featureId:'pro_export',featureConfigHash:hashValue(feature),cancellation:'allow_until_period_end',requireInitialPaymentConfirmed:true,syncWindowSeconds:5,predicateVersion:'reference-export-v1'});return controller.createRun({projectId:project.id,policyHash:policy.hash,mode:'local_replay'});}
  return {controller,start,cancel,app:service?.app,directory};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const {controller,directory} of opened.splice(0)){controller.close();rmSync(directory,{recursive:true,force:true});}});
describe('runtime startup failure recovery',()=>{
  it.each([undefined,'7','30','60'])('parses an operator retention setting: %s',value=>{
    expect(artifactRetentionFromDays(value)).toBe(Number(value??7)*86400000);
  });
  it.each(['','0','-1','0.5','60.1',' 60','60 ','60days','Infinity','9007199254740991',null,[],60])('rejects an invalid retention setting: %s',value=>{
    expect(()=>artifactRetentionFromDays(value)).toThrow('The artifact service configuration is invalid.');
  });
  it.each([{readDelay:1000,verdict:'pass'},{readDelay:15000,verdict:'inconclusive'}])('keeps truthful completion timestamps after cold browser startup: $verdict',async({readDelay,verdict})=>{
    const {controller}=setup();
    const started=Date.now();vi.useFakeTimers();vi.setSystemTime(started);
    const policy=createPolicy({schemaVersion:2,priceId:'price_synthetic',featureId:'pro_export',featureConfigHash:hashValue(feature),cancellation:'allow_until_period_end',requireInitialPaymentConfirmed:true,syncWindowSeconds:5,predicateVersion:'reference-export-v1'});
    const denial={status:403,body:{error:'ACCESS_DENIED'},transportError:false,denialStatuses:[403]};
    vi.spyOn(controller.target,'session').mockResolvedValue({cookie:'pp_session=synthetic',expiresAt:new Date(started+100000).toISOString()});
    vi.spyOn(controller.browser,'probe').mockImplementation(async()=>{vi.setSystemTime(started+12000);return {probe:denial,artifact:{id:'synthetic-timing-fixture.png',sha256:'a'.repeat(64),contentType:'image/png',source:'browser',collectedAt:new Date().toISOString()}};});
    vi.spyOn(controller.target,'snapshot').mockResolvedValue({principalId:'synthetic-free',runId:'synthetic-probe-run',customerId:null,status:'none',buildId:'a'.repeat(40)});
    vi.spyOn(controller.target,'probe').mockResolvedValue(denial);
    const result=await observeFeature({store:controller.evidence,target:controller.target,browser:controller.browser,runId:'synthetic-probe-run',scenarioId:'SC01',subjectId:'synthetic-free',fixtureMarker:'synthetic-private-marker',policy,targetBuild:'a'.repeat(40),mode:'local_replay',notBefore:started,billing:async()=>{vi.setSystemTime(started+12000+readDelay);return {livemode:false,identityResolved:true,noSubscriptionConfirmed:true,customerId:null,subscription:null};}});
    expect(result.api.verdict).toBe(verdict);
    const records=controller.evidence.list('synthetic-probe-run');
    expect(records.find(item=>item.source==='browser')?.observedAt).toBe(started+12000);
    expect(records.find(item=>item.source==='billing_provider')?.observedAt).toBe(started+12000+readDelay);
    if(readDelay>10000)expect(result.api.code).toBe('EVIDENCE_STALE');
  });
  it('revokes the MCP capability if cancellation wins during registration',async()=>{
    const {controller,start}=setup();
    let release:()=>void=()=>{};
    vi.spyOn(controller.runtime,'registerMcpServer').mockImplementation(async()=>{
      await new Promise<void>(resolve=>{release=resolve;});
      return {data:{name:'synthetic',authStatus:{status:'not_required'},manifest:{type:'remote',name:'synthetic',url:'http://127.0.0.1:39984/mcp',description:'Synthetic'}}};
    });
    const create=vi.spyOn(controller.runtime,'createSession');
    const run=await start();
    await controller.cancel(run.id);release();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(controller.runs.getRun(run.id).status).toBe('canceled');
    expect(controller.list('mcp-token')).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['original','before','after'])('serves only authenticated, run-scoped and hash-verified %s screenshot bytes',async phase=>{
    const {controller,start,app,directory}=setup(true);
    if(!app)throw new Error('HTTP fixture missing');
    vi.spyOn(controller.runtime,'registerMcpServer').mockImplementation(()=>new Promise(()=>{}));
    const run=await start(),id=`${randomUUID()}.png`;
    // A synthetic PNG-signature fixture tests transport integrity, not browser evidence.
    const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    const metadata={id,runId:run.id,observationId:'synthetic-observation',sha256:createHash('sha256').update(bytes).digest('hex'),contentType:'image/png',source:'browser',collectedAt:new Date().toISOString(),...phase==='original'?{}:{repairRunId:randomUUID(),repairJobId:randomUUID(),phase}};
    const path=join(directory,'artifacts',id);
    writeFileSync(path,bytes);
    controller.put('artifact',id,metadata);
    const url=`http://127.0.0.1:39982/api/runs/${run.id}/artifacts/${id}`;
    const request=()=>app.request(url,{headers:{Authorization:'Bearer synthetic-operator'}});
    expect((await app.request(url)).status).toBe(401);
    const response=await request();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${id}"`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(controller.viewRun(run.id).artifacts).toEqual([metadata]);
    for(const invalid of [
      {...metadata,unknownField:'rejected'},
      {...metadata,repairRunId:randomUUID(),repairJobId:randomUUID(),phase:'unverified'},
      {...metadata,repairRunId:randomUUID(),repairJobId:null,phase:'before'},
      {...metadata,repairRunId:run.id,repairJobId:randomUUID(),phase:'before'},
    ]){
      controller.put('artifact',id,invalid);
      expect(await (await request()).json()).toMatchObject({error:{code:'ARTIFACT_METADATA_INVALID'}});
    }
    controller.put('artifact',id,{...metadata,runId:'another-run'});
    expect((await request()).status).toBe(403);
    controller.put('artifact',id,metadata);
    writeFileSync(path,Buffer.from([...bytes,4]));
    const corrupted=await request();
    expect(corrupted.status).toBe(422);
    expect(await corrupted.json()).toMatchObject({error:{code:'ARTIFACT_CORRUPT'}});
  });
  it.each([
    {ageDays:8,retentionDays:60,explicitDays:undefined,status:200},
    {ageDays:59,retentionDays:60,explicitDays:undefined,status:200},
    {ageDays:60,retentionDays:60,explicitDays:undefined,status:410},
    {ageDays:8,retentionDays:60,explicitDays:7,status:410},
    {ageDays:8,retentionDays:undefined,explicitDays:undefined,status:410},
  ])('enforces operator retention without overriding an earlier explicit expiry: $ageDays/$retentionDays/$explicitDays',async({ageDays,retentionDays,explicitDays,status})=>{
    const day=86400000,now=Date.now();
    const {controller,start,app,directory}=setup(true,{artifactRetentionMs:retentionDays===undefined?undefined:retentionDays*day});
    if(!app)throw new Error('HTTP fixture missing');
    vi.spyOn(controller.runtime,'registerMcpServer').mockImplementation(()=>new Promise(()=>{}));
    const run=await start(),id=`${randomUUID()}.png`,collected=now-ageDays*day;
    const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
    writeFileSync(join(directory,'artifacts',id),bytes);
    controller.put('artifact',id,{id,runId:run.id,observationId:'synthetic-retention-observation',sha256:createHash('sha256').update(bytes).digest('hex'),contentType:'image/png',source:'browser',collectedAt:new Date(collected).toISOString(),...explicitDays===undefined?{}:{expiresAt:new Date(collected+explicitDays*day).toISOString()}});
    const response=await app.request(`http://127.0.0.1:39982/api/runs/${run.id}/artifacts/${id}`,{headers:{Authorization:'Bearer synthetic-operator'}});
    expect(response.status).toBe(status);
    if(status===200)expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    else expect(await response.json()).toMatchObject({error:{code:'ARTIFACT_EXPIRED'}});
  });
  it('scopes model operation labels to their authorized run',async()=>{
    const {controller,start}=setup();
    vi.spyOn(controller.runtime,'registerMcpServer').mockImplementation(()=>new Promise(()=>{}));
    for(let index=0;index<2;index++){
      const run=await start();
      // This unit test supplies approval through the real public control store.
      controller.runs.decidePlan({runId:run.id,approvalId:run.approval.id,bindingHash:run.approval.bindingHash,decision:'allow'});
      await expect(controller.tool(run.id,'cleanup_run',{runId:run.id,operationId:'op_1'})).resolves.toMatchObject({operation:'cleanup'});
      expect(controller.viewRun(run.id).run.status).toBe('completed');
    }
  });
  it('terminates an unapprovable run and releases its project lock when registration fails',async()=>{
    const {controller,start}=setup();
    vi.spyOn(controller.runtime,'registerMcpServer').mockRejectedValue(new Error('synthetic registration failure'));
    const first=await start();
    await expect.poll(()=>controller.viewRun(first.id).run.status,{timeout:500}).toBe('canceled');
    expect(controller.viewRun(first.id).runtimeError).toMatchObject({code:'RUNTIME_INITIALIZATION_FAILED'});
    expect((await start()).id).not.toBe(first.id);
    await new Promise(resolve=>setTimeout(resolve,20));
  });
  it('cancels a known session when beginning its first turn fails',async()=>{
    const {controller,start,cancel}=setup();
    vi.spyOn(controller.runtime,'registerMcpServer').mockResolvedValue({data:{name:'synthetic',authStatus:{status:'not_required'},manifest:{type:'remote',name:'synthetic',url:'http://127.0.0.1:39984/mcp',description:'Synthetic test registration'}}});
    vi.spyOn(controller.runtime,'createSession').mockResolvedValue({id:'synthetic-session',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),createdBy:'synthetic',title:null,agent:{type:'reference',id:'synthetic-agent',name:null}});
    vi.spyOn(controller.runtime,'beginTurn').mockRejectedValue(new Error('synthetic lost first-turn response'));
    const run=await start();
    await expect.poll(()=>controller.viewRun(run.id).run.status,{timeout:500}).toBe('canceled');
    expect(cancel).toHaveBeenCalledWith({sessionId:'synthetic-session'});
  });
});

function verifiedRepairFixture(controller:Controller){
  const runId=randomUUID(),jobId=randomUUID(),findingId='SC04:api';
  const changes=[{path:'packages/reference/src/index.ts',content:'// Synthetic approval test input. Never executed.\n'}];
  const proposal=controller.repairs.store.propose({runId,findingId,attempt:1,baseCommit:'a'.repeat(40),baseBranch:'main',repository:'synthetic/repository',branch:repairBranch(runId,findingId,1),policyHash:'b'.repeat(64),oracleHash:'c'.repeat(64),allowedPaths:changes.map(change=>change.path),changes,diffHash:patchHash(changes),verificationMode:'local_replay',failureCode:'SYNTHETIC_FAILURE',summary:'Synthetic approval fixture',reportUrl:'http://127.0.0.1:39983/synthetic'});
  const receipt=(checkId:string,failed=false)=>({id:randomUUID(),executionId:'synthetic-no-execution',checkId,oracleHash:'c'.repeat(64),policyHash:'b'.repeat(64),baseCommit:'a'.repeat(40),diffHash:failed?null:patchHash(changes),artifactHash:'d'.repeat(64),observedAt:Date.now(),exitCode:failed?1:0,outcome:failed?'fail':'pass',failureCode:failed?'SYNTHETIC_FAILURE':null});
  controller.repairs.store.recordVerification({proposalId:proposal.id,before:receipt(findingId,true),after:receipt(findingId),regressions:['SC01','SC02','SC03','SC04',...SECURITY_CONTROLS].map(id=>receipt(id))});
  const createdAt=Date.now();
  const job:RepairJob={id:jobId,runId,findingId,attempt:1,createdAt,deadline:createdAt+900000,state:'verified_local',sessionId:'synthetic-session',turnId:'synthetic-before',proposalId:proposal.id,error:null,runtimeOperations:[],checks:[]};
  controller.put(`repair-job:${runId}`,jobId,job);controller.put('repair-job-index',jobId,{runId,id:jobId});
  return {runId,jobId,proposalId:proposal.id};
}
function syntheticTurn(id:string,previousTurnId:string|null='synthetic-before',approval=false):RuntimeTurn{
  return {id,previousTurnId,sessionId:'synthetic-session',createdAt:new Date().toISOString(),state:{status:'done',completedAt:new Date().toISOString(),output:null,requiredActions:approval?[{type:'tool.approval_required',id:'synthetic-event',createdAt:new Date().toISOString(),threadId:'synthetic-thread',toolCalls:[{id:'synthetic-call',sourceEventId:'synthetic-source'}]}]:[]}};
}
describe('repair publication recovery with synthetic runtime responses',()=>{
  it.each([false,true])('does not dispatch again after an uncertain request; continuation exists: %s',async exists=>{
    const {controller}=setup(),fixture=verifiedRepairFixture(controller);
    const dispatch=vi.spyOn(TrueForgeAdapter.prototype,'continueTurn').mockRejectedValue(new Error('synthetic response lost'));
    const lookup=vi.spyOn(TrueForgeAdapter.prototype,'findContinuation').mockResolvedValue(exists?syntheticTurn('synthetic-gate',undefined,true):undefined);
    vi.spyOn(TrueForgeAdapter.prototype,'inspectTurn').mockResolvedValue(syntheticTurn('synthetic-gate',undefined,true));
    await expect(controller.repairs.requestPublication(fixture.runId,fixture.jobId)).rejects.toThrow('synthetic response lost');
    await controller.repairs.requestPublication(fixture.runId,fixture.jobId);
    await controller.repairs.recover();
    expect(dispatch).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalled();
    await expect.poll(()=>controller.get('repair-publication-runtime',fixture.jobId)).toMatchObject(exists?{turnId:'synthetic-gate',status:'approval'}:{status:'error',error:'PUBLICATION_OUTCOME_UNKNOWN_NO_REDISPATCH'});
    expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe('pending');
  });
  it.each(['allow','deny'] as const)('recovers a lost %s continuation without repeating that decision',async decision=>{
    const {controller}=setup(),fixture=verifiedRepairFixture(controller);
    vi.spyOn(TrueForgeAdapter.prototype,'continueTurn').mockResolvedValue(syntheticTurn('synthetic-gate',undefined,true));
    vi.spyOn(TrueForgeAdapter.prototype,'inspectTurn').mockImplementation(async({turnId})=>syntheticTurn(turnId,undefined,turnId==='synthetic-gate'));
    await controller.repairs.requestPublication(fixture.runId,fixture.jobId);
    await expect.poll(()=>controller.get('repair-publication-runtime',fixture.jobId)).toMatchObject({status:'approval'});
    const gate:RuntimeApproval={threadId:'synthetic-thread',toolCallId:'synthetic-call',sourceEventId:'synthetic-source',tool:{id:'synthetic-call',type:'function',function:{name:'publish_repair_pr',arguments:JSON.stringify({runId:fixture.runId,operationId:fixture.proposalId})},toolInfo:{type:'mcp',name:'publish_repair_pr',serverId:`paywallproof_${fixture.runId.replaceAll('-','')}`,serverName:'synthetic'}}};
    vi.spyOn(TrueForgeAdapter.prototype,'inspectApprovals').mockResolvedValue([gate]);
    const dispatch=vi.spyOn(TrueForgeAdapter.prototype,'continueApproval').mockRejectedValue(new Error('synthetic decision response lost'));
    vi.spyOn(TrueForgeAdapter.prototype,'findContinuation').mockResolvedValue(syntheticTurn('synthetic-decision','synthetic-gate'));
    const approval=controller.repairs.store.get(fixture.proposalId).approval;if(!approval)throw new Error('Missing synthetic approval');
    const request={decision,bindingHash:approval.bindingHash};
    await expect(controller.repairs.decidePublication(fixture.runId,fixture.jobId,approval.id,request)).rejects.toThrow('synthetic decision response lost');
    await controller.repairs.decidePublication(fixture.runId,fixture.jobId,approval.id,request);
    await controller.repairs.recover();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].decisions[0]?.approval.status).toBe(decision);
    expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe(decision);
    await expect(controller.repairs.decidePublication(fixture.runId,fixture.jobId,approval.id,{...request,decision:decision==='allow'?'deny':'allow'})).rejects.toMatchObject({code:'APPROVAL_CONFLICT'});
    expect(controller.repairs.store.get(fixture.proposalId).progress).toBeNull();
  });
  it.each(['wrong-run','malformed-json','wrong-server'])('rejects a %s runtime approval before owner authorization',async mismatch=>{
    const {controller}=setup(),fixture=verifiedRepairFixture(controller);
    vi.spyOn(TrueForgeAdapter.prototype,'continueTurn').mockResolvedValue(syntheticTurn('synthetic-gate',undefined,true));
    vi.spyOn(TrueForgeAdapter.prototype,'inspectTurn').mockResolvedValue(syntheticTurn('synthetic-gate',undefined,true));
    const dispatch=vi.spyOn(TrueForgeAdapter.prototype,'continueApproval');
    await controller.repairs.requestPublication(fixture.runId,fixture.jobId);
    await expect.poll(()=>controller.get('repair-publication-runtime',fixture.jobId)).toMatchObject({status:'approval'});
    vi.spyOn(TrueForgeAdapter.prototype,'inspectApprovals').mockResolvedValue([{threadId:'synthetic-thread',toolCallId:'synthetic-call',sourceEventId:'synthetic-source',tool:{id:'synthetic-call',type:'function',function:{name:'publish_repair_pr',arguments:mismatch==='malformed-json'?'{':JSON.stringify({runId:mismatch==='wrong-run'?'different-run':fixture.runId,operationId:fixture.proposalId})},toolInfo:{type:'mcp',name:'publish_repair_pr',serverId:mismatch==='wrong-server'?'different-server':`paywallproof_${fixture.runId.replaceAll('-','')}`,serverName:'synthetic'}}}]);
    const approval=controller.repairs.store.get(fixture.proposalId).approval;if(!approval)throw new Error('Missing synthetic approval');
    await expect(controller.repairs.decidePublication(fixture.runId,fixture.jobId,approval.id,{decision:'allow',bindingHash:approval.bindingHash})).rejects.toMatchObject({code:'RUNTIME_APPROVAL_MISMATCH'});
    expect(dispatch).not.toHaveBeenCalled();expect(controller.repairs.store.get(fixture.proposalId).approval?.decision).toBe('pending');
  });
});
