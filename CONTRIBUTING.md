# Contributing

PaywallProof handles billing state, credentials, browser sessions, and generated code. Keep changes narrow and preserve the trust boundaries described in the product specification.

## Before opening a pull request

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm verify:ci
```

`pnpm verify:ci` checks formatting, repository shape, delivery configuration, skill validity, types, lint, tests, and the production build. Run `pnpm verify` on a supported local machine to add the live browser contract.

## Change rules

- Add regression coverage for behavior changes and defects.
- Do not weaken an independent contract to make an implementation pass.
- Label synthetic, implementation-aware, and live evidence accurately.
- Keep provider credentials, checkout URLs, operator tokens, raw webhooks, and local receipts out of Git.
- Run external lifecycle tests only with explicit authorization and sandbox credentials.
- Do not add a paid model or provider fallback.

Substantive pull requests must complete CI and Qodo review. Resolve valid findings, explain rejected findings in the review thread, and request a final review after the last code change.
