import { StripeSandboxAdapter } from '../packages/adapters/src/stripe.ts';
import { mkdir } from 'node:fs/promises';
await mkdir('.local',{recursive:true});
const key=process.env.STRIPE_SECRET_KEY,accountId=process.env.STRIPE_ACCOUNT_ID,priceId=process.env.STRIPE_PRICE_ID;
if(!key||!accountId||!priceId){process.stdout.write(JSON.stringify({status:'blocked',code:'STRIPE_CONFIGURATION_MISSING',executed:false})+'\n');process.exitCode=2;}
else{const adapter=new StripeSandboxAdapter({key,accountId,priceId,databasePath:'.local/stripe-verification.sqlite'});try{const result=await adapter.preflight();process.stdout.write(JSON.stringify({status:'preflight_passed',scope:'read-only identity check; lifecycle untested',...result})+'\n');}finally{adapter.close();}}
