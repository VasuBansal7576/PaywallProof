import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TrueForge} from '@truefoundry/trueforge-sdk';

const origin='http://127.0.0.1:11434',base='qwen3:4b-instruct-2507-q4_K_M',alias='paywallproof-qwen3-4b-instruct';
async function request(path:string,body:unknown){
  const response=await fetch(new URL(path,origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok)throw new Error(`Local Ollama request failed: ${response.status}. No model pull or cloud fallback is permitted.`);
  return response.json();
}
const details=z.object({template:z.string(),parameters:z.string(),capabilities:z.array(z.string()),model_info:z.record(z.string(),z.unknown())}).parse(await request('/api/show',{model:base}));
if(!details.capabilities.includes('tools'))throw new Error('The installed local model lacks tool support.');
if(details.model_info['general.finetune']!=='Instruct')throw new Error('The model weights are not the approved Instruct variant. A prompt template cannot convert Thinking weights into an Instruct model.');
const capacity=z.number().parse(details.model_info['qwen3.context_length']);
if(capacity<32768)throw new Error('Installed model context capacity is below the required 32768 tokens.');
const template=details.template;
// Derives an alias from existing local weights. Never calls /api/pull or a hosted service.
await request('/api/create',{model:alias,from:base,template,parameters:{num_ctx:32768},stream:false});
const actual=z.object({template:z.string(),parameters:z.string()}).parse(await request('/api/show',{model:alias}));
if(actual.template!==template||!/^num_ctx\s+32768$/m.test(actual.parameters))throw new Error('Local model configuration readback did not match.');
await mkdir('.local',{recursive:true,mode:0o700});
const client=new TrueForge({baseUrl:'http://127.0.0.1:8790',maxRetries:0});
const providerName='paywallproof-local',modelName='qwen3-4b-instruct';
const {data:providers}=await client.settings.modelProviders.list();
const existing=providers.find(provider=>provider.name===providerName);
if(existing&&(existing.manifest.type!=='custom'||existing.manifest.baseUrl!=='http://127.0.0.1:11434/v1'))throw new Error('The existing provider is not the expected local endpoint; no replacement was made.');
const previousModels=existing?.manifest.type==='custom'?existing.manifest.models:[];
await client.settings.modelProviders.createOrUpdate({manifest:{type:'custom',name:providerName,baseUrl:'http://127.0.0.1:11434/v1',models:[...previousModels.filter(model=>model.name!==modelName),{name:modelName,modelId:alias,properties:{contextLength:32768,maxOutputTokens:8192}}]}});
const {data:readback}=await client.settings.modelProviders.list();
const saved=readback.find(provider=>provider.name===providerName);
if(saved?.manifest.type!=='custom'||!saved.manifest.models.some(model=>model.name===modelName&&model.modelId===alias))throw new Error('Runtime provider configuration readback failed.');
const evidence={base,alias,runtimeModel:`${providerName}/${modelName}`,weightVariant:details.model_info['general.finetune'],contextTokens:32768,templateSha256:createHash('sha256').update(template).digest('hex'),parameters:actual.parameters,configuredAt:new Date().toISOString(),downloadedModel:false,cloudConfigured:false};
await writeFile('.local/ollama-model-configuration.json',JSON.stringify(evidence,null,2),{mode:0o600});
process.stdout.write(JSON.stringify(evidence)+'\n');
