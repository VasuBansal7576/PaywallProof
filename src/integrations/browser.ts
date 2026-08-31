import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TargetTransport } from './network.ts';
import { bindTargetFeatureProbe, type TargetDescription } from './target-contract.ts';

export class BrowserRunner {
  constructor(
    private readonly transport: TargetTransport,
    private readonly artifactDirectory: string,
  ) {}
  async probe(cookie: string, feature: TargetDescription['feature']) {
    const probeContract = bindTargetFeatureProbe(feature).contract;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const destination = await this.transport.destination();
      const origin = this.transport.origin;
      browser = await chromium.launch({
        headless: true,
        args: [`--host-resolver-rules=MAP ${origin.hostname} ${destination.address}`],
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      const requests = new AbortController();
      let active = 0,
        count = 0,
        bytes = 0;
      const queue: { resolve: () => void; reject: (error: Error) => void }[] = [];
      const stopRequests = (error = new Error('BROWSER_PROBE_CLOSED')) => {
        requests.abort(error);
        for (const waiting of queue.splice(0)) waiting.reject(error);
      };
      context.once('close', () => stopRequests());
      const rejectBudget = () => {
        stopRequests(new Error('BROWSER_RESOURCE_LIMIT'));
        void context.close().catch(() => {});
        throw new Error('BROWSER_RESOURCE_LIMIT');
      };
      const acquire = async () => {
        requests.signal.throwIfAborted();
        if (active < 2) {
          active++;
          return;
        }
        await new Promise<void>((resolve, reject) => queue.push({ resolve, reject }));
      };
      const release = () => {
        const next = queue.shift();
        if (next) next.resolve();
        else active--;
      };
      await context.route('**/*', async (route) => {
        let acquired = false;
        try {
          if (++count > 128) rejectBudget();
          const url = new URL(route.request().url());
          const allowedPath =
            [
              probeContract.browser.path,
              probeContract.browser.profilePath,
              probeContract.browser.network.path,
            ].includes(url.pathname) || url.pathname.startsWith('/_next/');
          if (
            url.origin !== origin.origin ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            route.request().method() !== probeContract.browser.network.method ||
            !allowedPath
          ) {
            await route.abort('blockedbyclient').catch(() => {});
            return;
          }
          await acquire();
          acquired = true;
          requests.signal.throwIfAborted();
          // Browser redirect routing is not a security boundary. The trusted transport
          // pins DNS and rejects redirects before any destination is contacted.
          const response = await this.transport.request(url.pathname + url.search, {
            headers: await route.request().allHeaders(),
            signal: requests.signal,
            onResponseBytes: (size) => {
              bytes += size;
              if (bytes > 64 * 1024 * 1024) rejectBudget();
            },
          });
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (
              value !== undefined &&
              !['transfer-encoding', 'connection', 'content-length'].includes(key)
            )
              headers[key] = Array.isArray(value) ? value.join(', ') : value;
          await route.fulfill({ status: response.status, headers, body: response.rawBody });
        } catch {
          await route.abort('blockedbyclient').catch(() => {});
        } finally {
          if (acquired) release();
        }
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const firstCookie = cookie.split(';')[0] ?? '';
      const separator = firstCookie.indexOf('=');
      if (separator < 1) throw new Error('INVALID_USER_SESSION');
      await context.addCookies([
        {
          name: firstCookie.slice(0, separator),
          value: firstCookie.slice(separator + 1),
          url: origin.origin,
          httpOnly: true,
          sameSite: 'Strict',
          secure: origin.protocol === 'https:',
        },
      ]);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(new URL(probeContract.browser.path, origin).href, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Attach handlers to both promises immediately. A response timeout can occur
      // while Playwright is still waiting for a missing or disabled export button.
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url() === new URL(probeContract.browser.network.path, origin).href &&
            response.request().method() === probeContract.browser.network.method,
        ),
        page.getByTestId(probeContract.browser.action.testId).click(),
      ]);
      let networkBody: unknown;
      try {
        networkBody = await response.json();
      } catch {
        networkBody = await response.text();
      }
      const result = page.getByTestId(probeContract.browser.result.testId);
      await page
        .locator(
          `[data-testid="${probeContract.browser.result.testId}"][${probeContract.browser.result.statusAttribute}="${probeContract.browser.result.allowStatus}"], [data-testid="${probeContract.browser.result.testId}"][${probeContract.browser.result.statusAttribute}="${probeContract.browser.result.denyStatus}"], [data-testid="${probeContract.browser.result.testId}"][${probeContract.browser.result.statusAttribute}="${probeContract.browser.result.unavailableStatus}"]`,
        )
        .waitFor();
      const uiStatus = await result.getAttribute(probeContract.browser.result.statusAttribute);
      const visibleText = await result.innerText();
      let body: unknown = { uiStatus, visibleText, networkBody };
      const networkRecord =
        networkBody !== null && typeof networkBody === 'object' && !Array.isArray(networkBody)
          ? networkBody
          : null;
      if (uiStatus === probeContract.browser.result.allowStatus) {
        const marker = await result.locator(probeContract.browser.allow.markerElement).innerText();
        if (
          networkRecord &&
          probeContract.api.allow.markerProperty in networkRecord &&
          networkRecord[probeContract.api.allow.markerProperty] === marker
        )
          body = {
            [probeContract.api.allow.markerProperty]: marker,
            networkBody,
          };
      }
      if (
        uiStatus === probeContract.browser.result.denyStatus &&
        visibleText.trim() &&
        networkRecord &&
        probeContract.api.denial.errorProperty in networkRecord &&
        networkRecord[probeContract.api.denial.errorProperty] ===
          probeContract.api.denial.errorValue
      )
        body = {
          [probeContract.api.denial.errorProperty]: probeContract.api.denial.errorValue,
          visibleText,
          networkBody,
        };
      const screenshot = await page.screenshot({ fullPage: true });
      requests.signal.throwIfAborted();
      stopRequests();
      await context.close();
      await mkdir(this.artifactDirectory, { recursive: true });
      const artifactId = `${randomUUID()}.png`;
      await writeFile(resolve(this.artifactDirectory, artifactId), screenshot, { mode: 0o600 });
      return {
        probe: {
          status: response.status(),
          body,
          transportError: false,
          denialStatuses: probeContract.api.denial.statuses,
        },
        artifact: {
          id: artifactId,
          sha256: createHash('sha256').update(screenshot).digest('hex'),
          contentType: 'image/png',
          source: 'browser',
          collectedAt: new Date().toISOString(),
        },
      };
    } catch {
      // No HTTP response or screenshot is invented for a blocked/failed browser request.
      return {
        probe: {
          status: null,
          body: null,
          transportError: true,
          denialStatuses: probeContract.api.denial.statuses,
        },
        artifact: null,
      };
    } finally {
      await browser?.close();
    }
  }
}
