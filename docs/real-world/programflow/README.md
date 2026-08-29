# ProgramFlow case study

PaywallProof run `1320a925-a06e-4ae9-9e8a-370fff3e15a3` exercised the Registration & Commerce module in the user-owned Kill My SaaS application against PostgreSQL 17. It was not the bundled reference target.

| Scenario | Persisted transition | API | Browser | State |
| --- | --- | --- | --- | --- |
| SC01 | Checkout remains `pending_payment` | denied | denied | pass |
| SC02 | Settlement creates a paid order, ticket, and invoice | allowed | allowed | pass |
| SC03 | Refund remains provider-pending | allowed | allowed | pass |
| SC04 | Verified refund cancels registration and ticket | denied | denied | pass |

All twelve assertions passed. After cleanup, independent SQL counts found no run-owned registrations, orders, payment attempts, provider events, refunds, tickets, or invoices. The compact [receipt](receipt.json) records the scenario states, source fingerprint, cleanup counts, provider boundary, and verification totals. One representative [allowed-state screenshot](sc02-paid-allowed.png) is retained for visual context.

The run used an explicit local provider test port with signed replay and zero external calls. It proves that PaywallProof can drive a separate application and real PostgreSQL state transitions. It does not prove native Polar or Stripe delivery.

## Repository boundary

The third-party application source, adapter source, raw controller report, full test dump, SQL fix patch, and redundant screenshots are intentionally not bundled here. They obscured PaywallProof's own implementation and exposed machine-specific details. The receipt retains the audit summary without turning this repository into a copy of another product.

The ProgramFlow run also uncovered a timestamp-query bug in its inventory-capacity check. That finding belongs in ProgramFlow's own repository and review history, not in PaywallProof's distributable source.
