import {readFile} from 'node:fs/promises';
import {TrueForge} from '@truefoundry/trueforge-sdk';
import {z} from 'zod';

const id=z.string().uuid().parse(process.argv[2]);
const token=(await readFile('.local/operator-token','utf8')).trim();
const response=await fetch(`http://127.0.0.1:8787/api/runs/${id}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000),redirect:'error'});
if(!response.ok)throw new Error(`RUN_READ_${response.status}`);
const detail=z.object({run:z.object({status:z.string(),outcome:z.string().nullable()}),runtime:z.object({sessionId:z.string(),turnId:z.string(),status:z.string()}).nullable(),scenarios:z.array(z.unknown())}).parse(await response.json());
const client=new TrueForge({baseUrl:'http://127.0.0.1:8790',maxRetries:0});
const events=[];
if(detail.runtime)for await(const event of await client.sessions.listTurnEvents(detail.runtime.sessionId,detail.runtime.turnId)){
  if(event.type==='model.message')events.push({type:event.type,finishReason:event.finishReason,usage:event.usage,contentLength:typeof event.content==='string'?event.content.length:null,tools:(event.toolCalls??[]).map(call=>({name:call.toolInfo.name,id:call.id}))});
  if(event.type==='tool.response')events.push({type:event.type,toolCallId:event.toolCallId,contentLength:event.content.length});
}
process.stdout.write(JSON.stringify({runId:id,...detail,events},null,2)+'\n');
