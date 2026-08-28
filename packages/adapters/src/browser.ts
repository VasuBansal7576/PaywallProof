import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TargetTransport } from './network.ts';

export class BrowserRunner {
  constructor(private readonly transport:TargetTransport, private readonly artifactDirectory:string) {}
  async probe(cookie:string) {
    const destination = await this.transport.destination();
    const origin = this.transport.origin;
    const browser = await chromium.launch({headless:true,args:[`--host-resolver-rules=MAP ${origin.hostname} ${destination.address}`]});
    try {
      const context = await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:false,serviceWorkers:'block'});
      await context.route('**/*', async route=>{
        const url = new URL(route.request().url());
        const allowedPath=['/dashboard','/api/me','/api/export'].includes(url.pathname)||url.pathname.startsWith('/_next/');
        if(url.origin!==origin.origin||!['http:','https:'].includes(url.protocol)||url.username||url.password||route.request().method()!=='GET'||!allowedPath) {await route.abort('blockedbyclient');return;}
        try {
          // Browser redirect routing is not a security boundary. The trusted transport
          // pins DNS and rejects redirects before any destination is contacted.
          const response=await this.transport.request(url.pathname+url.search,{headers:await route.request().allHeaders()});
          const headers:Record<string,string>={};
          for(const [key,value] of Object.entries(response.headers))if(value!==undefined&&!['transfer-encoding','connection','content-length'].includes(key))headers[key]=Array.isArray(value)?value.join(', '):value;
          await route.fulfill({status:response.status,headers,body:response.rawBody});
        }catch{await route.abort('blockedbyclient');}
      });
      await context.routeWebSocket('**/*', socket=>socket.close());
      const firstCookie = cookie.split(';')[0] ?? '';
      const separator = firstCookie.indexOf('=');
      if(separator<1) throw new Error('INVALID_USER_SESSION');
      await context.addCookies([{name:firstCookie.slice(0,separator),value:firstCookie.slice(separator+1),url:origin.origin,httpOnly:true,sameSite:'Strict',secure:origin.protocol==='https:'}]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(new URL('/dashboard',origin).href,{waitUntil:'domcontentloaded',timeout:30_000});
      // Attach handlers to both promises immediately. A response timeout can occur
      // while Playwright is still waiting for a missing or disabled export button.
      const [response] = await Promise.all([
        page.waitForResponse(response=>response.url()===new URL('/api/export',origin).href&&response.request().method()==='GET'),
        page.getByTestId('export-button').click(),
      ]);
      let networkBody:unknown;
      try { networkBody=await response.json(); } catch { networkBody=await response.text(); }
      const result = page.getByTestId('export-result');
      await page.locator('[data-testid="export-result"][data-status="allowed"], [data-testid="export-result"][data-status="denied"], [data-testid="export-result"][data-status="unavailable"]').waitFor();
      const uiStatus = await result.getAttribute('data-status');
      const visibleText = await result.innerText();
      let body:unknown = {uiStatus,visibleText,networkBody};
      const networkRecord=networkBody!==null&&typeof networkBody==='object'&&!Array.isArray(networkBody)?networkBody:null;
      if(uiStatus==='allowed') {
        const marker=await result.locator('pre').innerText();
        if(networkRecord&&'fixtureMarker'in networkRecord&&networkRecord.fixtureMarker===marker)body={fixtureMarker:marker,networkBody};
      }
      if(uiStatus==='denied'&&visibleText.trim()&&networkRecord&&'error'in networkRecord&&networkRecord.error==='ACCESS_DENIED')body={error:'ACCESS_DENIED',visibleText,networkBody};
      const screenshot = await page.screenshot({fullPage:true});
      await mkdir(this.artifactDirectory,{recursive:true});
      const artifactId = `${randomUUID()}.png`;
      await writeFile(resolve(this.artifactDirectory,artifactId),screenshot,{mode:0o600});
      return {probe:{status:response.status(),body,transportError:false,denialStatuses:[403]},artifact:{id:artifactId,sha256:createHash('sha256').update(screenshot).digest('hex'),contentType:'image/png',source:'browser',collectedAt:new Date().toISOString()}};
    } catch {
      // No HTTP response or screenshot is invented for a blocked/failed browser request.
      return {probe:{status:null,body:null,transportError:true,denialStatuses:[403]},artifact:null};
    } finally {await browser.close();}
  }
}
