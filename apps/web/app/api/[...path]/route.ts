const forwardedRequestHeaders = ['accept', 'content-type', 'cookie', 'origin', 'x-csrf-token', 'x-request-id'];

async function proxy(request: Request): Promise<Response> {
  try {
    const configured = new URL(process.env.WORKER_ORIGIN ?? 'http://127.0.0.1:8787');
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) throw new Error('INVALID_WORKER_ORIGIN');
    const incoming = new URL(request.url);
    // Paths and query strings are forwarded; callers cannot select another host or follow redirects.
    const destination = new URL(configured.origin);
    destination.pathname = incoming.pathname;
    destination.search = incoming.search;
    const headers = new Headers();
    for (const name of forwardedRequestHeaders) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(destination, {
      method: request.method, headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
    });
    const outputHeaders = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');
      const checkout=location?new URL(location):null;
      if(request.method!=='GET'||!/^\/api\/runs\/[^/]+\/checkout$/.test(incoming.pathname)||response.status!==303||!checkout||checkout.origin!=='https://sandbox.polar.sh'||checkout.username||checkout.password||!checkout.pathname.startsWith('/checkout/'))throw new Error('WORKER_REDIRECT_REJECTED');
      outputHeaders.set('location',checkout.href);
      outputHeaders.set('referrer-policy','no-referrer');
    }
    for (const name of ['content-type', 'content-disposition', 'content-length']) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    for (const cookie of response.headers.getSetCookie()) outputHeaders.append('set-cookie', cookie);
    return new Response(response.body, { status: response.status, headers: outputHeaders });
  } catch {
    return Response.json({ error: { code: 'WORKER_UNAVAILABLE', message: 'The local worker is unavailable. Start pnpm dev and retry. Existing runs are unchanged.' } }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
