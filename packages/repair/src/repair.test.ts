import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitHubPublicationAdapter, openRepairStore, patchHash, publishRepair, repairBranch, validateRepairPaths, type GitHubRequest, type RepairStore } from './index.ts';

const repository='owner/project',baseCommit='a'.repeat(40),baseTree='b'.repeat(40),newTree='c'.repeat(40),newCommit='d'.repeat(40);
const hash='1'.repeat(64),allowedPaths=['src/billing.ts'];
const stores:RepairStore[]=[];const directories:string[]=[];
afterEach(async()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
function prepare(clock=()=>1000) {
  const store=openRepairStore({path:':memory:',repository,allowedPaths,requiredRegressionChecks:['SC01'],clock});stores.push(store);
  const changes=[{path:'src/billing.ts',content:'fixed\n'}];
  const proposal=store.propose({runId:'run',findingId:'finding',attempt:1,baseCommit,baseBranch:'main',repository,branch:repairBranch('run','finding',1),policyHash:hash,oracleHash:hash,allowedPaths,changes,diffHash:patchHash(changes),verificationMode:'local_replay',failureCode:'PROTECTED_DATA_LEAK',summary:'Fix recorded cancellation failure',reportUrl:'https://example.test/reports/run'});
  const common={executionId:'local-test-execution',checkId:'reproduction',oracleHash:hash,policyHash:hash,baseCommit,artifactHash:hash,observedAt:1000};
  const verification={proposalId:proposal.id,before:{...common,id:'before',diffHash:null,exitCode:1,outcome:'fail',failureCode:'PROTECTED_DATA_LEAK'},after:{...common,id:'after',diffHash:proposal.proposal.diffHash,exitCode:0,outcome:'pass',failureCode:null},regressions:[{...common,id:'regression',checkId:'SC01',diffHash:proposal.proposal.diffHash,exitCode:0,outcome:'pass',failureCode:null}]};
  return {store,proposal,verification};
}
function approved(clock=()=>1000) {
  const fixture=prepare(clock);fixture.store.recordVerification(fixture.verification);
  const pending=fixture.store.requestPublication({proposalId:fixture.proposal.id,title:'Fix cancellation',body:'Observed failure, unchanged reproduction and regression receipts follow.'});
  if(!pending.approval)throw new Error('approval missing');
  fixture.store.decidePublication({proposalId:pending.id,approvalId:pending.approval.id,bindingHash:pending.approval.bindingHash,decision:'allow'});
  return {...fixture,approvalId:pending.approval.id};
}
function gitBlob(content:string){return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');}
function syntheticProvider(fault:'none'|'pr-response-lost'|'ref-response-lost'|'pr-never-visible'='none') {
  let branch:string|null=null,commitMessage='',pr:unknown=null,lost=false,prPosts=0,writes=0;
  const seen:GitHubRequest[]=[];
  const request=async(input:GitHubRequest)=>{
    seen.push(input);
    if(input.method==='POST')writes++;
    if(input.method==='GET'&&input.path==='/git/ref/heads/main')return {status:200,body:{ref:'refs/heads/main',object:{type:'commit',sha:baseCommit}}};
    if(input.method==='GET'&&input.path.startsWith('/git/ref/heads/'))return branch?{status:200,body:{ref:`refs/heads/${branch}`,object:{type:'commit',sha:newCommit}}}:{status:404,body:null};
    if(input.method==='GET'&&input.path===`/git/commits/${baseCommit}`)return {status:200,body:{sha:baseCommit,tree:{sha:baseTree},parents:[],message:'base'}};
    if(input.method==='GET'&&input.path===`/git/commits/${newCommit}`)return {status:200,body:{sha:newCommit,tree:{sha:newTree},parents:[{sha:baseCommit}],message:commitMessage}};
    if(input.method==='GET'&&input.path.startsWith('/git/trees/')){
      const original=input.path.includes(baseTree);return {status:200,body:{sha:original?baseTree:newTree,truncated:false,tree:[{path:'src/billing.ts',mode:'100644',type:'blob',sha:gitBlob(original?'broken\n':'fixed\n')}]}};
    }
    if(input.method==='POST'&&input.path==='/git/trees'){
      expect(z.object({base_tree:z.string(),tree:z.array(z.object({path:z.string(),content:z.string()}))}).parse(input.body)).toEqual({base_tree:baseTree,tree:[{path:'src/billing.ts',content:'fixed\n'}]});return {status:201,body:{sha:newTree}};
    }
    if(input.method==='POST'&&input.path==='/git/commits'){commitMessage=z.object({message:z.string()}).parse(input.body).message;return {status:201,body:{sha:newCommit}};}
    if(input.method==='POST'&&input.path==='/git/refs'){
      branch=z.object({ref:z.string()}).parse(input.body).ref.replace('refs/heads/','');
      if(fault==='ref-response-lost'&&!lost){lost=true;throw new Error('synthetic lost response');}return {status:201,body:{}};
    }
    if(input.method==='GET'&&input.path.startsWith('/pulls?'))return {status:200,body:pr?[pr]:[]};
    if(input.method==='GET'&&input.path==='/pulls/1')return {status:200,body:pr};
    if(input.method==='POST'&&input.path==='/pulls'){
      prPosts++;const args=z.object({head:z.string(),base:z.string(),title:z.string(),body:z.string(),draft:z.boolean()}).parse(input.body);
      if(fault!=='pr-never-visible')pr={number:1,html_url:`https://github.com/${repository}/pull/1`,draft:args.draft,state:'open',title:args.title,body:args.body,head:{ref:args.head,sha:newCommit,repo:{full_name:repository}},base:{ref:args.base,sha:baseCommit,repo:{full_name:repository}}};
      if((fault==='pr-response-lost'||fault==='pr-never-visible')&&!lost){lost=true;throw new Error('synthetic lost response');}return {status:201,body:{number:1}};
    }
    throw new Error(`unexpected synthetic request ${input.method} ${input.path}`);
  };
  return {adapter:new GitHubPublicationAdapter({repository,transport:{kind:'synthetic',request}}),seen,get prPosts(){return prPosts;},get writes(){return writes;}};
}

describe('repair authorization and synthetic publication transport, not provider evidence',()=>{
  it('persists immutable approval and serializes publishers across connections',async()=>{
    const fixture=prepare();
    const root=await mkdtemp(join(tmpdir(),'paywallproof-repair-db-'));directories.push(root);const path=join(root,'repair.sqlite');
    let time=1000;
    const options={path,repository,allowedPaths,requiredRegressionChecks:['SC01'],clock:()=>time};
    const first=openRepairStore(options);
    const proposal=first.propose(fixture.proposal.proposal);
    first.recordVerification({...fixture.verification,proposalId:proposal.id});
    const pending=first.requestPublication({proposalId:proposal.id,title:'Fix',body:'Evidence'});
    if(!pending.approval)throw new Error('approval missing');
    const approval=pending.approval;
    first.decidePublication({proposalId:proposal.id,approvalId:approval.id,bindingHash:approval.bindingHash,decision:'allow'});first.close();
    const reopened=openRepairStore(options),other=openRepairStore(options);stores.push(reopened,other);
    expect(reopened.get(proposal.id).approval).toEqual({...approval,decision:'allow'});
    const detached=reopened.get(proposal.id);detached.proposal.summary='mutated';expect(reopened.get(proposal.id).proposal.summary).not.toBe('mutated');
    const claim=reopened.claimPublication(proposal.id,approval.id,'synthetic');
    expect(()=>other.claimPublication(proposal.id,approval.id,'synthetic')).toThrow('PUBLICATION_IN_FLIGHT');
    time+=30001;const next=other.claimPublication(proposal.id,approval.id,'synthetic');expect(next.leaseToken).not.toBe(claim.leaseToken);
    if(!claim.leaseToken)throw new Error('lease missing');expect(()=>reopened.guardPublication(proposal.id,approval.id,claim.leaseToken??'',true)).toThrow('PUBLICATION_LEASE_LOST');
  });
  it('keeps failed verification proposed and binds the exact immutable manifest',()=>{
    const {store,proposal,verification}=prepare();
    expect(()=>store.recordVerification({...verification,after:{...verification.after,oracleHash:'2'.repeat(64)}})).toThrow('VERIFICATION_REJECTED');
    expect(store.get(proposal.id).state).toBe('proposed');
    const verified=store.recordVerification(verification);expect(verified.state).toBe('verified_local');
    expect(()=>store.recordVerification({...verification,after:{...verification.after,id:'different'}})).toThrow('VERIFICATION_CONFLICT');
    const pending=store.requestPublication({proposalId:proposal.id,title:'Fix',body:'Evidence'});
    expect(pending.approval?.args.draft).toBe(true);
    expect(()=>store.requestPublication({proposalId:proposal.id,title:'Changed',body:'Evidence'})).toThrow('APPROVAL_STALE');
  });
  it('denies publication without any transport call',async()=>{
    const {store,proposal,verification}=prepare();store.recordVerification(verification);const pending=store.requestPublication({proposalId:proposal.id,title:'Fix',body:'Evidence'});
    if(!pending.approval)throw new Error('approval missing');
    store.decidePublication({proposalId:proposal.id,approvalId:pending.approval.id,bindingHash:pending.approval.bindingHash,decision:'deny'});
    const provider=syntheticProvider();await expect(publishRepair({store,adapter:provider.adapter,proposalId:proposal.id,approvalId:pending.approval.id})).rejects.toThrow('APPROVAL_REQUIRED');expect(provider.seen).toHaveLength(0);
  });
  it('performs read-after-write but never marks a synthetic result published',async()=>{
    const {store,proposal,approvalId}=approved(),provider=syntheticProvider();
    const result=await publishRepair({store,adapter:provider.adapter,proposalId:proposal.id,approvalId});
    expect(result.kind).toBe('synthetic');expect(result.receipt.draft).toBe(true);expect(store.get(proposal.id).state).toBe('awaiting_publication');
    expect(provider.seen.some(request=>request.method==='GET'&&request.path==='/pulls/1')).toBe(true);expect(provider.prPosts).toBe(1);
  });
  it.each(['pr-response-lost','ref-response-lost'] as const)('recovers %s without duplicate publication',async fault=>{
    const {store,proposal,approvalId}=approved(),provider=syntheticProvider(fault),input={store,adapter:provider.adapter,proposalId:proposal.id,approvalId};
    await expect(publishRepair(input)).rejects.toThrow('PUBLICATION_OUTCOME_UNKNOWN');
    expect((await publishRepair(input)).kind).toBe('synthetic');expect(provider.prPosts).toBe(1);
  });
  it('never retries an uncertain PR POST merely because reads cannot find it',async()=>{
    const {store,proposal,approvalId}=approved(),provider=syntheticProvider('pr-never-visible'),input={store,adapter:provider.adapter,proposalId:proposal.id,approvalId};
    await expect(publishRepair(input)).rejects.toThrow('PUBLICATION_OUTCOME_UNKNOWN');
    await expect(publishRepair(input)).rejects.toThrow('PUBLICATION_OUTCOME_UNKNOWN');expect(provider.prPosts).toBe(1);
  });
  it('rejects new writes after approval expiry',async()=>{
    let time=1000;const {store,proposal,approvalId}=approved(()=>time),provider=syntheticProvider();time+=900000;
    await expect(publishRepair({store,adapter:provider.adapter,proposalId:proposal.id,approvalId})).rejects.toThrow('APPROVAL_STALE');expect(provider.writes).toBe(0);
  });
  it('rejects protected, symlink and executable file paths',async()=>{
    const root=await mkdtemp(join(tmpdir(),'paywallproof-repair-'));directories.push(root);await mkdir(join(root,'src'));await writeFile(join(root,'src','billing.ts'),'source',{mode:0o600});
    await expect(validateRepairPaths({checkoutRoot:root,paths:allowedPaths,allowedPaths})).resolves.toHaveProperty('paths',allowedPaths);
    await symlink(join(root,'src','billing.ts'),join(root,'src','link.ts'));
    await expect(validateRepairPaths({checkoutRoot:root,paths:['src/link.ts'],allowedPaths:['src/link.ts']})).rejects.toThrow('REPAIR_PATH_REJECTED');
    await chmod(join(root,'src','billing.ts'),0o700);
    await expect(validateRepairPaths({checkoutRoot:root,paths:allowedPaths,allowedPaths})).rejects.toThrow('REPAIR_PATH_REJECTED');
    for(const path of ['../escape','/absolute','src/../escape','src/tests/probe.ts','.env.local','src/auth.config.ts','pnpm-lock.yaml'])await expect(validateRepairPaths({checkoutRoot:root,paths:[path],allowedPaths:[path]})).rejects.toThrow('INVALID_INPUT');
  });
});
