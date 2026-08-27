import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';

const origin='http://127.0.0.1:11434',base='qwen3:4b',alias='paywallproof-qwen3-4b-nothink';
async function request(path:string,body:unknown){
  const response=await fetch(new URL(path,origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok)throw new Error(`Local Ollama request failed: ${response.status}. No model pull or cloud fallback is permitted.`);
  return response.json();
}
const details=z.object({template:z.string(),parameters:z.string(),capabilities:z.array(z.string()),model_info:z.record(z.string(),z.unknown())}).parse(await request('/api/show',{model:base}));
if(!details.capabilities.includes('tools'))throw new Error('The installed local model lacks tool support.');
const capacity=z.number().parse(details.model_info['qwen3.context_length']);
if(capacity<32768)throw new Error('Installed model context capacity is below the required 32768 tokens.');
const tail='<|im_start|>assistant\n<think>\n{{ end }}';
if(!details.template.includes(tail))throw new Error('Unexpected model template; refusing an unverified template replacement.');
const template=details.template.replace(tail,'<|im_start|>assistant\n<think>\n\n</think>\n\n{{ end }}');
// Derives an alias from existing local weights. Never calls /api/pull or a hosted service.
await request('/api/create',{model:alias,from:base,template,parameters:{num_ctx:32768},stream:false});
const actual=z.object({template:z.string(),parameters:z.string()}).parse(await request('/api/show',{model:alias}));
if(actual.template!==template||!/^num_ctx\s+32768$/m.test(actual.parameters))throw new Error('Local model configuration readback did not match.');
await mkdir('.local',{recursive:true,mode:0o700});
const evidence={base,alias,contextTokens:32768,templateSha256:createHash('sha256').update(template).digest('hex'),parameters:actual.parameters,configuredAt:new Date().toISOString(),downloadedModel:false,cloudConfigured:false};
await writeFile('.local/ollama-model-configuration.json',JSON.stringify(evidence,null,2),{mode:0o600});
process.stdout.write(JSON.stringify(evidence)+'\n');
