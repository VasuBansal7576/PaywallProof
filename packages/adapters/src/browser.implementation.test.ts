import {describe,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserRunner} from './browser.ts';
import {TargetTransport} from './network.ts';

describe('browser probe failure lifetime, implementation-aware',()=>{
  it.each(['request-count','total-bytes'])('bounds hostile asset traffic by %s and leaves no evidence artifact',async limit=>{
    const directory=await mkdtemp(join(tmpdir(),'pp-browser-budget-'));
    // Deliberately hostile local HTML. It is a test input, not application evidence.
    const html=`<!doctype html><html><body><script>for(let i=0;i<${limit==='request-count'?2048:6};i++)fetch('/_next/static/flood-'+i+'.js').catch(()=>{});</script></body></html>`;
    const payload=Buffer.alloc(limit==='total-bytes'?12*1024*1024:32,32);
    const server=createServer((request,response)=>{
      const asset=request.url?.startsWith('/_next/static/');
      response.writeHead(200,{'content-type':asset?'application/javascript':'text/html'});
      response.end(asset?payload:html);
    });
    let restore:(()=>void)|undefined;
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const address=server.address();if(!address||typeof address==='string')throw new Error('No test listener');
      const transport=new TargetTransport({origin:`http://127.0.0.1:${address.port}`,allowLoopback:true});
      const original=transport.request.bind(transport),signals:AbortSignal[]=[];
      let active=0,peak=0;
      const spy=vi.spyOn(transport,'request').mockImplementation(async(path,options)=>{
        active++;peak=Math.max(peak,active);if(options?.signal)signals.push(options.signal);
        try{return await original(path,options);}finally{active--;}
      });
      restore=()=>spy.mockRestore();
      const result=await new BrowserRunner(transport,directory).probe('synthetic_session=budget_test');
      expect(result).toMatchObject({probe:{status:null,body:null,transportError:true},artifact:null});
      expect(peak).toBeLessThanOrEqual(2);
      expect(signals.some(signal=>signal.aborted&&signal.reason instanceof Error&&signal.reason.message==='BROWSER_RESOURCE_LIMIT')).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    }finally{
      restore?.();server.closeAllConnections();
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  },25000);
  it('handles both response and click timeouts when the page never renders an export action',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'pp-browser-timeout-'));
    // Deliberately incomplete synthetic HTML, never presented as application evidence.
    const server=createServer((_request,response)=>{
      response.writeHead(200,{'content-type':'text/html'});
      response.end('<!doctype html><html><body>Account unavailable</body></html>');
    });
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Test server address unavailable');
      const runner=new BrowserRunner(new TargetTransport({origin:`http://127.0.0.1:${address.port}`,allowLoopback:true}),directory);
      const result=await runner.probe('synthetic_session=timeout_test');
      expect(result).toMatchObject({probe:{status:null,body:null,transportError:true},artifact:null});
      expect(await readdir(directory)).toEqual([]);
      // Let rejection events run. Vitest must report no unhandled rejection from either waiter.
      await new Promise(resolve=>setTimeout(resolve,30));
    }finally{
      server.closeAllConnections();
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  },25000);
});

describe('bounded Next bundle transport, implementation-aware',()=>{
  it.each([1_048_577, 12 * 1024 * 1024])('loads a %i-byte static bundle without expanding API or POST response limits',async size=>{
    const bytes=Buffer.alloc(size,32);
    const server=createServer((_request,response)=>{response.writeHead(200);response.end(bytes);});
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const address=server.address();if(!address||typeof address==='string')throw new Error('No test listener');
      const transport=new TargetTransport({origin:`http://127.0.0.1:${address.port}`,allowLoopback:true});
      expect((await transport.request('/_next/static/chunks/test.js')).rawBody.length).toBe(bytes.length);
      await expect(transport.request('/api/export')).rejects.toThrow('RESPONSE_LIMIT');
      await expect(transport.request('/_next/static/chunks/test.js',{method:'POST'})).rejects.toThrow('RESPONSE_LIMIT');
      await expect(transport.request('/_next/static/chunks/test.json')).rejects.toThrow('RESPONSE_LIMIT');
    }finally{
      server.closeAllConnections();
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });
  it('still rejects static bundles larger than 16 MiB',async()=>{
    const server=createServer((_request,response)=>{response.writeHead(200);response.end(Buffer.alloc(16*1024*1024+1));});
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const address=server.address();if(!address||typeof address==='string')throw new Error('No test listener');
      await expect(new TargetTransport({origin:`http://127.0.0.1:${address.port}`,allowLoopback:true}).request('/_next/static/chunks/test.js')).rejects.toThrow('RESPONSE_LIMIT');
    }finally{
      server.closeAllConnections();
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  });
});
