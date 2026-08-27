import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { z } from 'zod';

const root=resolve(import.meta.dirname,'..'),local=resolve(root,'.local');
await mkdir(local,{recursive:true});
const configPath=resolve(local,'development-secrets.json');
const schema=z.object({adapterToken:z.string(),replaySecret:z.string(),webhookSecret:z.string(),operatorToken:z.string()});
let config:z.infer<typeof schema>;
try{config=schema.parse(JSON.parse(await readFile(configPath,'utf8')));}catch(error){
  if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;
  const secret=()=>randomBytes(32).toString('hex');config={adapterToken:secret(),replaySecret:`whsec_local_${secret()}`,webhookSecret:`whsec_unconfigured_${secret()}`,operatorToken:secret()};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600,flag:'wx'});
}
await writeFile(resolve(local,'operator-token'),config.operatorToken,{mode:0o600});
const build=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,STAGING_ENABLED:'true',TARGET_BUILD_ID:build,TARGET_ADAPTER_TOKEN:config.adapterToken,LOCAL_REPLAY_SECRET:config.replaySecret,STRIPE_WEBHOOK_SECRET:process.env.STRIPE_WEBHOOK_SECRET??config.webhookSecret,OPERATOR_TOKEN:config.operatorToken,STRIPE_PRICE_ID:process.env.STRIPE_PRICE_ID??'price_local_replay_pro',REFERENCE_DATABASE_PATH:resolve(local,'reference.sqlite'),CONTROL_DATABASE_PATH:resolve(local,'control.sqlite'),WORKER_ORIGIN:'http://127.0.0.1:8787'};
const children=[['exec','tsx','apps/worker/src/main.ts'],['exec','next','dev','apps/demo-saas','--hostname','127.0.0.1','--port','3001'],['exec','next','dev','apps/web','--hostname','127.0.0.1','--port','3000']].map(args=>spawn('pnpm',args,{cwd:root,env,stdio:'inherit'}));
process.stderr.write(`Open http://127.0.0.1:3000. Operator token: ${resolve(local,'operator-token')}\nLocal replay is available without Stripe. TrueForge must already be running on loopback8790.\n`);
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
for(const child of children)child.on('exit',code=>{if(!stopping&&code!==0){process.exitCode=code??1;stop();}});
process.once('SIGINT',stop);process.once('SIGTERM',stop);
