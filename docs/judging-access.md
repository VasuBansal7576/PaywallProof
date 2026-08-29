# Access during judging

The intended review window is 60 days. Local evidence, provider tokens and running services have separate lifetimes.

## Polar sandbox

The owner approved replacing Stripe on August 28, 2026. The PaywallProof organization exists in Polar's separate sandbox. Separate worker and read-only reference tokens expire November 26, 2026. The organization and private positive monthly product passed actual authenticated preflight with both tokens. No live payment, bank information, paid plan or credit redemption was used.

This removes the old seven-day Stripe claim dependency. The former Stripe sandbox was not extended and is not used by the application. No invitation request was sent. Credentials remain in ignored local storage and must never be published.

Token expiry is not a promise about indefinite provider data retention. Fresh verification creates new run-owned fixtures. A paid checkout and full access lifecycle must still pass before provider acceptance can be claimed.

## Retained evidence

`pnpm dev` selects 60-day screenshot retention. Direct worker startup defaults to seven days unless configured. A receipt with an earlier explicit expiry keeps that expiry. Preserve the database and artifact directory together, including original hashes, timestamps, mode and failed outcomes.

This does not deploy the app, keep the laptop online or publish private reports. Judges need approved source and supplied recorded evidence, or running local services for a fresh interactive run. No paid hosting is authorized. Never relabel local replay as provider verification or rotate accounts to evade expiration.
