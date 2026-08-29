# Agent Harness Hackathon sponsor requirements

Research date: August 29, 2026; repository status updated August 30. This note uses organizer, TrueForge, Qodo, and repository-owned primary sources only. It separates qualification rules from optional sponsor features and competitive judging signals.

## Executive conclusion

PaywallProof uses the required products in substance, not as logos:

- TrueForge owns the persisted session, run-scoped MCP tool calls, sandbox, approval pauses, skill loading, and dynamic review subagents.
- Qodo reviewed the meaningful implementation pull request repeatedly through its final head; valid findings were fixed, contrary findings received public dispositions, CI passed, and the pull request was merged.

Two submission risks remain after the native Polar acceptance run:

1. The current three-minute walkthrough describes TrueForge orchestration and approvals, but its captions do not establish that it visibly shows the live approval pause or the generated code executing in the sandbox. The organizer says to show both moments in the demo.
2. A project submission still has to be filed through the organizer's form before August 30 at 8:00 PM London time. The repository does not establish that this external step happened.

The native Polar lifecycle was a product acceptance gap, not an organizer qualification rule. It completed on August 29 with 12/12 assertions, signed provider webhooks, a canceled sandbox subscription, and no live charge. Qodo reviewed that work in PR #2, all three findings were fixed, final-head CI passed, and the PR was merged.

## What is actually required

The authoritative rules require an agent running on TrueForge, every substantive change reviewed by Qodo in a GitHub pull request before merge, a public and runnable open-source repository, permitted accounts/data only, and no secrets or private information in the repository or demo. Required submission artifacts are a clear README with setup steps, an approximately three-minute working demo, a short explanation of the agent and its TrueForge use, and a precise Qodo evidence section. AI coding assistance must be disclosed, and the participant must understand and be able to explain the code and decisions. See the [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules).

The current event page makes the TrueForge qualification test concrete: a judge must see the harness reach a real tool, run code in the sandbox, and stop for a person before an irreversible action. It favors one completed end-to-end job over several partial features and says the approval gate and sandbox execution should appear in the demo. See the [official hackathon page](https://www.wemakedevs.org/hackathons/trueforge).

“TrueFoundry end to end” should not be interpreted as requiring the commercial TrueFoundry AI Gateway or MCP Gateway. The organizer explicitly says neither gateway is needed for this hackathon; the required runtime is TrueForge, TrueFoundry's open-source agent harness. See the [official tools section](https://www.wemakedevs.org/hackathons/trueforge#tools).

## TrueForge end-to-end expectation

For qualification, the minimum visible loop is:

1. A TrueForge session runs the agent.
2. The agent reaches a real connected tool through MCP.
3. Agent-generated code executes in an isolated sandbox.
4. A sensitive or irreversible tool call pauses for human approval.
5. The person allows or denies it and the same workflow continues.

For the Best Use of TrueForge track, the organizer additionally calls out subagent delegation and session continuity across reconnects. Skills are not named as a hard qualification condition, but are one of the harness capabilities the organizer highlights. The complete track description is on the [official hackathon page](https://www.wemakedevs.org/hackathons/trueforge).

This interpretation matches the official product model:

- TrueForge's [SDK concepts](https://trueforge.dev/api/overview) define one agent with persisted sessions, chained turns, streamed events, and approval-resume turns.
- Its [harness capabilities](https://trueforge.dev/key-features/overview) describe sandbox-as-tool, approval checkpoints, subagents with isolated context, MCP tool context, offloading, and compaction.
- Its [skills documentation](https://trueforge.dev/skills) defines Git-backed `SKILL.md` packs cloned into the sandbox and loaded on demand.
- Its [sandbox documentation](https://trueforge.dev/sandbox) says credentials remain in the harness, the sandbox is provisioned for code/files/shell work, and state is reused across turns in the session. The public documentation currently names Daytona as the supported provider; PaywallProof should describe its exercised local fallback as a verified implementation-specific path, not as an officially documented general provider.

## Qodo end-to-end expectation

The required development loop for each substantive merge is:

1. Create a branch and pull request.
2. Let Qodo review it, automatically or with `/agentic_review`.
3. Apply human judgment to each finding.
4. Fix every valid High-severity finding; explain any invalid, intentional, or deferred High finding in its Qodo thread.
5. Push fixes and request a follow-up review so the public trail covers the final code.
6. Human-merge only after that review loop.

The README must contain a heading exactly named `## Qodo Code Review Evidence`, a public link to at least one representative merged pull request containing meaningful hackathon code, one or two sentences explaining findings and dispositions, and a PR history that shows completed review, decisions, and follow-up review on the final code. Screenshots do not replace the public pull request. These are organizer requirements, not merely Qodo product recommendations. See the [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules) and [hackathon Qodo workflow](https://www.wemakedevs.org/hackathons/trueforge).

Qodo's own documentation supports that workflow: installing its GitHub app makes it review linked pull requests, and its agentic reviews use repository context rather than only the diff. A repository-root `.pr_agent.toml` can configure review commands and presentation, but the configuration file is not itself the proof of use. See Qodo's [official quickstart](https://docs.qodo.ai/get-started), [code-review overview](https://docs.qodo.ai/code-review), and [configuration documentation](https://docs.qodo.ai/install-and-configure/configuration-overview/configuration-file). Qodo's resolver skill is optional remediation assistance; it cannot replace the public review trail. See [Qodo Agent Skills](https://docs.qodo.ai/agent-skills).

## Requirement-to-evidence matrix

| Requirement or judging signal                                                    | Current repository/public evidence                                                                                                                                                                                                                                                  | Status                                                | Gap or required action                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent runs through TrueForge, not a thin model wrapper                           | `src/integrations/trueforge.ts` creates TrueForge sessions/turns; `apps/worker/src/controller.ts` registers the run-scoped MCP server and lets TrueForge drive the lifecycle. README explains that the model bridge proposes decisions while TrueForge owns execution.              | Satisfied in code and executed evidence               | Keep this division prominent in the demo and submission write-up.                                                                                                                                 |
| Reach a real connected tool through MCP                                          | The controller registers an authenticated, run-scoped MCP server and explicitly enables lifecycle tools. The native Polar sandbox run exercised provider checkout, signed webhooks, reads, cancellation and expiry through the persisted TrueForge session.                         | Satisfied                                             | Demo should visibly show a tool call and result.                                                                                                                                                  |
| Run generated code in the TrueForge sandbox                                      | `scripts/verify-runtime.ts` records a live `sandbox.created` event and Python execution; the repair workflow uses a TrueForge sandbox while keeping the evaluator outside it. `docs/verification-status.md` records the executed result.                                            | Satisfied as technical evidence; presentation at risk | Re-record or edit the demo so a judge visibly sees where code runs and its result. Do not rely only on narration.                                                                                 |
| Pause before an irreversible action and resume after human decision              | `apps/worker/src/controller.ts` requires approval for `prepare_fixture` and `publish_repair_pr`; the runtime verifier exercised allow, deny, continuation, and stale-approval rejection.                                                                                            | Satisfied as technical evidence; presentation at risk | Show the actual approval-required state and the human decision in the demo. The current subtitle script only describes approvals.                                                                 |
| Persistent session/reconnect behavior                                            | The TrueForge adapter stores session/turn IDs, resumes streams, and selects the newest turn across pagination. Verification records streamed recovery and stale-turn protection.                                                                                                    | Satisfied                                             | Include one concise reconnect/resume proof in the write-up or demo if time permits.                                                                                                               |
| Subagents and skills for Best Use depth                                          | `skills/paywallproof-evidence-review/` is a focused Git-backed skill. `apps/worker/src/evidence-review.ts` creates a separate sandboxed session with dynamic subagents and two restricted review roles. A live receipt is report-hash-bound.                                        | Satisfied                                             | The saved verdict is honestly `needs_attention`; do not relabel it. Showing this visually would improve sponsor-tool scoring.                                                                     |
| Every substantive merge reviewed by Qodo before merge                            | [PR #2](https://github.com/VasuBansal7576/PaywallProof/pull/2) contains the native lifecycle work, Qodo's three findings, focused fixes, final-head CI, and merge `32664e0`. [PR #3](https://github.com/VasuBansal7576/PaywallProof/pull/3) records the clean CI-runtime follow-up. | Satisfied for the merged implementation               | Put each later substantive change through its own Qodo-reviewed pull request.                                                                                                                     |
| Fix valid High findings or explain invalid/deferred ones                         | PR #2 marks all three valid findings resolved on final head `87788cb`; PR #3 reports zero bugs, rule violations, or requirement gaps.                                                                                                                                               | Satisfied                                             | A new PR starts a new audit trail; resolve its valid findings before merge.                                                                                                                       |
| README Qodo proof section with a representative merged PR and final review trail | The heading, public PR link, merge commit, final-head review, and representative finding dispositions are stated directly.                                                                                                                                                          | Satisfied in the working tree                         | Preserve the wording through the final Qodo-reviewed merge.                                                                                                                                       |
| Public, open-source, runnable repository with clear setup                        | The GitHub repository is public, original code is MIT licensed, and README contains pinned prerequisites, installation, services, and verification commands.                                                                                                                        | Substantially satisfied                               | Perform one clean-clone setup rehearsal on the documented platform. Keep implementation-specific local sandbox prerequisites explicit.                                                            |
| Approximately three-minute demo showing the agent working                        | `docs/media/paywallproof-walkthrough.mp4` is 180 seconds and captions explain the saved run.                                                                                                                                                                                        | Partially satisfied                                   | The demo should visibly show the TrueForge tool call, sandbox execution, live approval pause/decision, and resulting evidence. Publish a stable accessible URL and put it in the submission form. |
| Short write-up explaining what the agent does and how it uses TrueForge          | README introduction and `How TrueForge is used` section cover the problem, runtime ownership, evidence review, and repair boundary.                                                                                                                                                 | Satisfied                                             | Keep it concise in the submission form; distinguish TrueForge from the optional TrueFoundry gateways.                                                                                             |
| Use only authorized resources; exclude secrets and personal data                 | README and judging-access notes constrain use to owner-authorized targets and isolated sandbox resources. Tokens, test email, operator credential, checkout URLs, and raw local evidence are excluded from Git.                                                                     | Satisfied by documented controls                      | Run a final secret/history scan before submission and manually review the video.                                                                                                                  |
| Disclose AI coding assistance and understand the implementation                  | README has a Development disclosure section.                                                                                                                                                                                                                                        | Satisfied in writing                                  | The owner must be prepared to explain architecture, approval/idempotency boundaries, evidence binding, sandbox separation, and Qodo dispositions.                                                 |
| Submit through organizer form by deadline                                        | External action cannot be inferred from Git.                                                                                                                                                                                                                                        | Unverified                                            | Submit the public repository, accessible demo link, and short write-up through the [official form](https://www.wemakedevs.org/hackathons/trueforge) before August 30, 8:00 PM London time.        |
| Blog link                                                                        | Only required when entering the blog-post prize.                                                                                                                                                                                                                                    | Optional                                              | Add a published post link only if entering that prize.                                                                                                                                            |

## Judging criteria

The six criteria are equally weighted, and the organizer says the demo is scored as hard as the code:

1. Potential impact — a clear, useful job someone would hand to an agent.
2. Creativity and originality.
3. Technical excellence — complete, reliable, well-structured implementation.
4. Use of sponsor tools — TrueForge is central and Qodo reviewed the work along the way.
5. Control and safety — isolated code execution and a human stop before irreversible work.
6. Presentation — the demo explains the problem, shows the agent working, and makes the harness role clear.

Source: [official judging criteria](https://www.wemakedevs.org/hackathons/trueforge#faqs).

For PaywallProof, technical excellence and control/safety are the strongest code-level areas. The highest-leverage remaining improvement is presentation evidence that makes the already executed MCP, sandbox, approval, continuation, and native Polar lifecycle easy for judges to see.

## Final pre-submission order

1. Record a fresh approximately three-minute demo that visibly includes a real MCP call, sandbox execution, an approval-required pause, the human decision, and the final evidence/result.
2. Link the stable demo URL.
3. Put this substantive change through a new pull request, run Qodo, fix or explain findings, request a final-head follow-up, wait for green CI, and human-merge.
4. Run a clean-clone rehearsal, secret/history scan, and video privacy review.
5. Submit through the organizer form before the deadline.
