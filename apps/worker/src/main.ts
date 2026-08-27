import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createControlApp } from './http.ts';
function required(key:string){const value=process.env[key];if(!value)throw new Error(`Missing ${key}; use pnpm dev to configure local services.`);return value;}
const control=createControlApp({
  databasePath:process.env.CONTROL_DATABASE_PATH??resolve('.local/control.sqlite'),artifactDirectory:resolve('.local/artifacts'),
  targetOrigin:process.env.TARGET_ORIGIN??'http://127.0.0.1:3001',workerOrigin:'http://127.0.0.1:8787',webOrigin:'http://127.0.0.1:3000',
  adapterToken:required('TARGET_ADAPTER_TOKEN'),replaySecret:required('LOCAL_REPLAY_SECRET'),operatorToken:required('OPERATOR_TOKEN'),
  repository:process.env.PROJECT_REPOSITORY??'VasuBansal7576/PaywallProof',defaultRef:required('TARGET_BUILD_ID'),priceId:required('STRIPE_PRICE_ID'),
  stripeKey:process.env.STRIPE_SECRET_KEY,stripeAccountId:process.env.STRIPE_ACCOUNT_ID,runtimeUrl:'http://127.0.0.1:8790',model:process.env.TRUEFORGE_MODEL??'paywallproof-local/qwen3-4b-instruct',
});
const server=serve({fetch:control.app.fetch,hostname:'127.0.0.1',port:8787});
void control.controller.recover();
process.stderr.write('PaywallProof worker listening on http://127.0.0.1:8787\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.close(()=>{control.close();process.exit(0);});});
