/** Implementation-aware regression against the installed TrueForge processor. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('@truefoundry/trueforge/package.json'));
const coreRoot = dirname(runtimeRequire.resolve('@truefoundry/trueforge-core/package.json'));
async function processModuleResponse(
  format: 'cjs' | 'esm',
  content: string,
  category: 'sandbox' | 'mcp' = 'sandbox',
) {
  const modulePath = join(
    coreRoot,
    `dist/core/capabilities/builtins/LargeToolResponse.${format === 'cjs' ? 'js' : 'mjs'}`,
  );
  const exports: unknown =
    format === 'cjs' ? runtimeRequire(modulePath) : await import(pathToFileURL(modulePath).href);
  if (
    !exports ||
    typeof exports !== 'object' ||
    !('LargeToolResponseProcessor' in exports) ||
    typeof exports.LargeToolResponseProcessor !== 'function'
  )
    throw Error('PROCESSOR_EXPORT_MISSING');
  const Processor = exports.LargeToolResponseProcessor;
  const sandbox = {};
  const logger = { child: () => logger, error: () => {} };
  const processor: unknown = Reflect.construct(Processor, [
    {
      individualTokenThreshold: 6000,
      totalTokenThreshold: 10000,
      previewNumberOfCharacters: 100,
      dynamicSubAgentsPresent: false,
      logger,
    },
  ]);
  if (
    !processor ||
    typeof processor !== 'object' ||
    !('process' in processor) ||
    typeof processor.process !== 'function'
  )
    throw Error('PROCESSOR_METHOD_MISSING');
  const results = [
    {
      message: { content },
      info: { toolSet: category === 'sandbox' ? sandbox : {}, originalToolName: 'exec' },
      isStructuredContent: true,
    },
  ];
  await processor.process(results, { sandbox: category === 'sandbox' ? sandbox : undefined });
  return results[0]?.message.content ?? '';
}
describe.each(['cjs', 'esm'] as const)(
  'TrueForge oversized sandbox execution receipts (%s)',
  (format) => {
    const processResponse = (content: string, category: 'sandbox' | 'mcp' = 'sandbox') =>
      processModuleResponse(format, content, category);
    it.each([0, 1, 127])(
      'preserves real exit code %s and declares truncated output',
      async (exitCode) => {
        const result = 'Observed source line\n'.repeat(4000);
        const output = await processResponse(
          JSON.stringify({ success: true, response: { exitCode, result } }),
        );
        const receipt = JSON.parse(output);
        expect(receipt).toMatchObject({
          success: true,
          response: {
            exitCode,
            outputTruncated: true,
            originalOutputBytes: Buffer.byteLength(result),
          },
        });
        expect(receipt.response.originalOutputSha256).toBe(
          createHash('sha256').update(result).digest('hex'),
        );
        expect(receipt.response.result).toContain('Observed source line');
        expect(receipt.response.result).toContain('[output truncated');
        expect(output.length / 4).toBeLessThan(6000);
      },
    );
    it('leaves a small receipt byte-for-byte unchanged', async () => {
      const content = JSON.stringify({ success: true, response: { exitCode: 0, result: '42' } });
      expect(await processResponse(content)).toBe(content);
    });
    it.each(['"\\\n\t'.repeat(20000), '🔒漢字'.repeat(20000)])(
      'bounds escaped and multibyte output without changing its measured byte length',
      async (result) => {
        const output = await processResponse(
          JSON.stringify({ success: true, response: { exitCode: 2, result } }),
        );
        expect(JSON.parse(output)).toMatchObject({
          success: true,
          response: {
            exitCode: 2,
            outputTruncated: true,
            originalOutputBytes: Buffer.byteLength(result),
            originalOutputSha256: createHash('sha256').update(result).digest('hex'),
          },
        });
        expect(output.length / 4).toBeLessThan(6000);
      },
    );
    it.each([
      'not json '.repeat(5000),
      JSON.stringify({ success: false, error: 'private failure '.repeat(5000) }),
      JSON.stringify({ success: true, response: { exitCode: '0', result: 'x'.repeat(40000) } }),
    ])('never fabricates a valid exec receipt from an invalid response', async (content) => {
      const output = await processResponse(content);
      expect(output).toContain('Content too big');
      expect(() => JSON.parse(output)).toThrow();
    });
    it('does not relabel a large MCP response as an execution receipt', async () => {
      const output = await processResponse(
        JSON.stringify({ success: true, response: { exitCode: 0, result: 'x'.repeat(40000) } }),
        'mcp',
      );
      expect(output).toContain('Content too big');
      expect(() => JSON.parse(output)).toThrow();
    });
  },
);
