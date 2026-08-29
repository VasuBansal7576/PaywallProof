# Submission material

Use the current [verification record](verification-status.md) when describing what passed. Do not present a unit-test count, model probe or local billing replay as a completed Polar lifecycle.

## Architecture

TrueForge owns persisted sessions, run-scoped tools, sandbox execution and approval pauses. The controller binds a run to the target build, feature configuration and immutable billing policy. API requests, actual browser actions and application-state reads produce separate observations for each scenario. A completed run can start a separate skill-backed evidence review with dynamic subagents. Its two reviewers can only read the bound report and submit a bounded review receipt; they cannot change the primary verdict.

The selected Luna bridge provides structured decisions through the existing Codex subscription. It has no application tools or host-test access. TrueForge executes approved proposals. Source repairs go into a restricted checkout; the evaluator and its security controls stay outside that writable checkout. Publication requires the exact verified diff and destination to be approved. There is no automatic merge or deployment.

## Record the actual workspace

The [recorded walkthrough](media/paywallproof-walkthrough.mp4) is included in the repository with [SRT captions](media/paywallproof-walkthrough.srt). It runs 180.003 seconds. No account secrets or private checkout links appear; login was excluded from the recording.

After a successful `pnpm exec tsx scripts/verify-local-workflow.ts`, with the local app running:

```sh
pnpm exec tsx scripts/record-local-walkthrough.ts
```

This uses the existing Playwright browser and local FFmpeg installation. It records about three minutes of the actual saved workspace: history, scenario assertions, a hash-checked screenshot, report bindings, repair controls and model consent. It creates no run, model request or provider object. Login happens before recording in a disposable browser context; the operator credential and session state are not exported.

Outputs are under `.local/submission/<timestamp>/`: an MP4 with a default subtitle track, separate SRT captions, the original browser recording and `recording.json` with the source run identity, chapter timing and video hash. Enable the subtitle track in the player. The captions identify this as a recorded local-replay walkthrough, not live payment-provider acceptance. Review the video before uploading it anywhere.

## Organizer requirements still to confirm

- A representative reviewed PR must pass Qodo review and be merged. The owner has authorized that review-and-merge workflow; production deployment remains out of scope.
- Original project code is under the [MIT license](../LICENSE). Dependencies retain their own licenses and notices.
- Supply the committed video link in the hackathon submission. The repository copy needs no paid video hosting.
- Keep sandbox tokens, operator credentials, customer email and private checkout links out of the repository and recording.

The owner must be able to explain the implementation and its limitations. Codex assistance and the distinction between independent tests and implementation-aware regressions are disclosed in the README.
