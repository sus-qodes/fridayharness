# Decisions

## ADR-001 Money is integer minor units plus an ISO-4217 currency
Amounts are stored and sent as integers in minor units (cents) with a three-letter currency code.
Floating-point amounts are never used.

## ADR-002 The frontend talks to the backend only through shared/src/api.ts
Request and response shapes live in `shared/src/api.ts`. The frontend never imports backend code.
Changing the contract is a cross-team change: tell every consumer first.
