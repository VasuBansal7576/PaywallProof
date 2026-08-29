# Reviewer contract

Each reviewer returns one JSON-compatible result:

- `role`: `coverage` or `binding`
- `verdict`: `confirmed`, `needs_attention`, or `inconclusive`
- `summary`: a short statement grounded in the report
- `findings`: zero or more bounded findings with `code`, `severity`, `summary`, optional `scenarioId`, and cited `observationIds`

Rules:

- Cite identifiers exactly as recorded. Never invent an observation ID.
- Missing evidence is not a pass.
- Local replay cannot prove native provider delivery.
- A passing run is scoped to its recorded build, policy, scenarios, and coverage limits.
- Cleanup leftovers require `needs_attention`.
- Disagreement between reviewers makes the synthesis `inconclusive` unless one result contains a concrete, report-backed material finding, which makes it `needs_attention`.
- Keep each summary under 1,000 characters and each finding summary under 500 characters.
