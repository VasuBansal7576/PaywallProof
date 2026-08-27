import Stripe from 'stripe';
import {z} from 'zod';
import {hashValue} from '../../core/src/index.ts';
import {ReferenceTargetAdapter,TargetTransport} from '../../adapters/src/network.ts';

export const SECURITY_CONTROLS=[
  'AUTH_EXPORT_MISSING','AUTH_EXPORT_INVALID','AUTH_ME_MISSING','AUTH_ME_INVALID',
  'ADAPTER_AUTH_MISSING','ADAPTER_AUTH_INVALID','REPLAY_AUTH_MISSING','REPLAY_AUTH_INVALID',
  'REPLAY_SIGNATURE_MISSING','REPLAY_SIGNATURE_INVALID','REPLAY_SECRET_SEPARATION',
  'REPLAY_RUN_OWNERSHIP','REPLAY_LIVE_REJECTED','SESSION_RUN_OWNERSHIP',
] as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const securityControlSchema=z.strictObject({id:z.enum(SECURITY_CONTROLS),outcome:z.enum(['pass','fail']),expectedStatus:z.number().int(),actualStatus:z.number().int(),responseHash:digest,stateBeforeHash:digest,stateAfterHash:digest,observedAt:z.number().int().nonnegative()});
export type SecurityControl=z.infer<typeof securityControlSchema>;

/** Negative requests to the disposable target only. No provider or live transaction exists. */
export async function probeRepairSecurity(input:{transport:TargetTransport;adapterToken:string;replaySecret:string;webhookSecret:string;runId:string;principalId:string;activationPayload:string;signal:AbortSignal}):Promise<SecurityControl[]>{
  input.signal.throwIfAborted();
  const target=new ReferenceTargetAdapter(input.transport,input.adapterToken,()=>input.signal.throwIfAborted());
  const owner={runId:input.runId,principalId:input.principalId};
  const headers={Authorization:`Bearer ${input.adapterToken}`,'Content-Type':'application/json'};
  const signature=(payload:string,secret=input.replaySecret)=>Stripe.webhooks.generateTestHeaderString({payload,secret});
  const event=z.object({data:z.object({object:z.object({metadata:z.object({runId:z.string()}).passthrough()}).passthrough()}).passthrough()}).passthrough().parse(JSON.parse(input.activationPayload));
  const otherRun=JSON.stringify({...event,data:{...event.data,object:{...event.data.object,metadata:{...event.data.object.metadata,runId:`other_${input.runId}`}}}});
  const liveFlag=JSON.stringify({...event,livemode:true});
  const replay={method:'POST',body:input.activationPayload,headers:{...headers,'Stripe-Signature':signature(input.activationPayload)}};
  type Request={id:typeof SECURITY_CONTROLS[number];path:string;expectedStatus:number;options?:Parameters<TargetTransport['request']>[1]};
  const requests:Request[]=[
    {id:'AUTH_EXPORT_MISSING',path:'/api/export',expectedStatus:401},
    {id:'AUTH_EXPORT_INVALID',path:'/api/export',expectedStatus:401,options:{headers:{Cookie:'pp_session=invalid_synthetic_session'}}},
    {id:'AUTH_ME_MISSING',path:'/api/me',expectedStatus:401},
    {id:'AUTH_ME_INVALID',path:'/api/me',expectedStatus:401,options:{headers:{Cookie:'pp_session=invalid_synthetic_session'}}},
    {id:'ADAPTER_AUTH_MISSING',path:'/staging/describe',expectedStatus:401},
    {id:'ADAPTER_AUTH_INVALID',path:'/staging/describe',expectedStatus:401,options:{headers:{Authorization:'Bearer invalid_synthetic_token'}}},
    {id:'REPLAY_AUTH_MISSING',path:'/staging/replay',expectedStatus:401,options:{...replay,headers:{'Content-Type':'application/json','Stripe-Signature':signature(input.activationPayload)}}},
    {id:'REPLAY_AUTH_INVALID',path:'/staging/replay',expectedStatus:401,options:{...replay,headers:{...replay.headers,Authorization:'Bearer invalid_synthetic_token'}}},
    {id:'REPLAY_SIGNATURE_MISSING',path:'/staging/replay',expectedStatus:400,options:{...replay,headers}},
    {id:'REPLAY_SIGNATURE_INVALID',path:'/staging/replay',expectedStatus:400,options:{...replay,headers:{...headers,'Stripe-Signature':'invalid_synthetic_signature'}}},
    {id:'REPLAY_SECRET_SEPARATION',path:'/staging/replay',expectedStatus:400,options:{...replay,headers:{...headers,'Stripe-Signature':signature(input.activationPayload,input.webhookSecret)}}},
    {id:'REPLAY_RUN_OWNERSHIP',path:'/staging/replay',expectedStatus:403,options:{...replay,body:otherRun,headers:{...headers,'Stripe-Signature':signature(otherRun)}}},
    {id:'REPLAY_LIVE_REJECTED',path:'/staging/replay',expectedStatus:400,options:{...replay,body:liveFlag,headers:{...headers,'Stripe-Signature':signature(liveFlag)}}},
    {id:'SESSION_RUN_OWNERSHIP',path:`/staging/users/${encodeURIComponent(input.principalId)}/session`,expectedStatus:403,options:{method:'POST',headers,body:JSON.stringify({runId:`other_${input.runId}`})}},
  ];
  const before=hashValue(await target.snapshot(owner)),results:SecurityControl[]=[];
  for(const request of requests){
    input.signal.throwIfAborted();
    const response=await input.transport.request(request.path,{...request.options,beforeDispatch:()=>input.signal.throwIfAborted()});
    const after=hashValue(await target.snapshot(owner));
    input.signal.throwIfAborted();
    results.push({id:request.id,outcome:response.status===request.expectedStatus&&before===after?'pass':'fail',expectedStatus:request.expectedStatus,actualStatus:response.status,responseHash:hashValue(response.body),stateBeforeHash:before,stateAfterHash:after,observedAt:Date.now()});
  }
  return results;
}
