import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const token=(await readFile('.local/operator-token','utf8')).trim();
const origin='http://127.0.0.1:8787';
async function call(path:string,body?:unknown) {
  const response=await fetch(new URL(path,origin),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Request-Id':randomUUID()},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60_000)});
  const value:unknown=await response.json();
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
const config=z.object({repository:z.string(),defaultRef:z.string(),priceId:z.string()}).parse(await call('/api/config'));
const project=z.object({id:z.string()}).parse(await call('/api/projects',{name:`Local workflow verification ${new Date().toISOString()}`,repository:config.repository,ref:config.defaultRef,targetId:'reference',ownershipConfirmed:true,modelConsent:true}));
const preflight=z.object({ready:z.boolean(),featureConfigHash:z.string().optional(),checks:z.array(z.unknown())}).parse(await call(`/api/projects/${project.id}/preflight`,{mode:'local_replay'}));
if(!preflight.ready||!preflight.featureConfigHash)throw new Error(`Preflight blocked: ${JSON.stringify(preflight.checks)}`);
const policy=z.object({hash:z.string()}).parse(await call(`/api/projects/${project.id}/policies`,{schemaVersion:2,priceId:config.priceId,featureId:'pro_export',featureConfigHash:preflight.featureConfigHash,cancellation:'allow_until_period_end',requireInitialPaymentConfirmed:true,syncWindowSeconds:5,predicateVersion:'reference-export-v1'}));
const run=z.object({id:z.string(),mode:z.literal('local_replay'),approval:z.object({id:z.string(),bindingHash:z.string()})}).parse(await call('/api/runs',{projectId:project.id,policyHash:policy.hash,mode:'local_replay'}));
process.stdout.write(JSON.stringify({runId:run.id,mode:run.mode,url:`http://127.0.0.1:3000/runs/${run.id}`})+'\n');
const deadline=Date.now()+20*60*1000;
let approved=false,previous='';
while(Date.now()<deadline) {
  const detail=z.object({run:z.object({status:z.string(),outcome:z.string().nullable()}),runtime:z.object({status:z.string(),error:z.string().optional()}).nullable(),runtimeError:z.unknown().nullable(),scenarios:z.array(z.object({id:z.string(),api:z.object({verdict:z.string()}),browser:z.object({verdict:z.string()}),state:z.object({verdict:z.string()})}))}).parse(await call(`/api/runs/${run.id}`));
  const summary=JSON.stringify({status:detail.run.status,runtime:detail.runtime?.status,scenarios:detail.scenarios});
  if(summary!==previous){process.stdout.write(summary+'\n');previous=summary;}
  if(detail.runtimeError||detail.runtime?.status==='error')throw new Error(`Runtime failed: ${JSON.stringify(detail.runtimeError??detail.runtime)}`);
  if(detail.run.status==='canceled')throw new Error('The verification run was canceled; no pass is claimed.');
  if(!approved&&detail.runtime?.status==='approval') {
    // The owner authorized this local verification. Approval remains scoped to this exact synthetic run.
    await call(`/api/runs/${run.id}/approvals/${run.approval.id}`,{decision:'allow',bindingHash:run.approval.bindingHash});approved=true;
  }
  if(detail.run.status==='completed') {
    const report=await call(`/api/runs/${run.id}/report?format=json`);await writeFile('.local/local-workflow-report.json',JSON.stringify(report,null,2));
    if(detail.run.outcome!=='passed'||detail.scenarios.length!==4)throw new Error('The local workflow did not pass all four scenarios.');
    process.stdout.write(JSON.stringify({status:'passed',mode:'local_replay',runId:run.id,credentialedPolarExecuted:false})+'\n');process.exit(0);
  }
  if(detail.runtime?.status==='done'&&approved&&detail.run.status==='running')throw new Error('The agent ended before completing the required workflow.');
  await new Promise(resolve=>setTimeout(resolve,2000));
}
await call(`/api/runs/${run.id}/cancel`,{});
throw new Error('Workflow verification exceeded its deadline; run canceled.');
