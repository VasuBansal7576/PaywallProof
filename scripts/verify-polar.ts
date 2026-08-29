import { PolarError, PolarSandboxReader } from '#integrations/polar';

const token = process.env.POLAR_ACCESS_TOKEN;
const organizationId = process.env.POLAR_ORGANIZATION_ID;
const productId = process.env.POLAR_PRODUCT_ID;
const priceId = process.env.POLAR_PRICE_ID;
if (!token || !organizationId || !productId || !priceId) {
  process.stdout.write(
    JSON.stringify({
      status: 'blocked',
      code: 'POLAR_CONFIGURATION_MISSING',
      executed: false,
      lifecycleVerified: false,
    }) + '\n',
  );
  process.exitCode = 2;
} else {
  try {
    const reader = new PolarSandboxReader({ token, organizationId, productId, priceId });
    const result = await reader.preflight();
    process.stdout.write(JSON.stringify({ status: 'preflight_passed', ...result }) + '\n');
  } catch (error) {
    // Upstream response bodies, exception causes and environment values may contain credentials.
    const code = error instanceof PolarError ? error.code : 'POLAR_VERIFICATION_FAILED';
    process.stdout.write(
      JSON.stringify({ status: 'blocked', code, lifecycleVerified: false }) + '\n',
    );
    process.exitCode = 2;
  }
}
