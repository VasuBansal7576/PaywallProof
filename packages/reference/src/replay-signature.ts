import {createHmac,timingSafeEqual} from 'node:crypto';

/** Internal replay protocol only. This header cannot authenticate a provider webhook. */
export function signReplay(input:{payload:string;secret:string;timestamp?:number}){
  const timestamp=input.timestamp??Math.floor(Date.now()/1000);
  if(!input.secret||!Number.isSafeInteger(timestamp)||timestamp<0)throw new Error('REPLAY_SIGNATURE_INPUT_INVALID');
  const digest=createHmac('sha256',input.secret).update(`${timestamp}.${input.payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyReplay(payload:string,signature:string,secret:string):unknown{
  if(!secret||signature.length>2048)throw new Error('REPLAY_SIGNATURE_INVALID');
  const parts=signature.split(',');
  const timestamps=parts.filter(part=>part.startsWith('t='));
  if(timestamps.length!==1)throw new Error('REPLAY_SIGNATURE_INVALID');
  const timestampText=timestamps[0]?.slice(2);
  if(!timestampText||!/^\d+$/.test(timestampText))throw new Error('REPLAY_SIGNATURE_INVALID');
  const timestamp=Number(timestampText);
  if(!Number.isSafeInteger(timestamp)||Math.abs(Math.floor(Date.now()/1000)-timestamp)>300)throw new Error('REPLAY_SIGNATURE_EXPIRED');
  const expected=createHmac('sha256',secret).update(`${timestamp}.${payload}`).digest();
  const valid=parts.filter(part=>part.startsWith('v1=')).some(part=>{
    const digest=part.slice(3);
    if(!/^[0-9a-f]{64}$/.test(digest))return false;
    return timingSafeEqual(expected,Buffer.from(digest,'hex'));
  });
  if(!valid)throw new Error('REPLAY_SIGNATURE_INVALID');
  return JSON.parse(payload);
}
