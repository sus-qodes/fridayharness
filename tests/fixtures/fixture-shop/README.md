# fixture-shop

A tiny shop used to test and demonstrate Friday.

- `shared/src/api.ts` is the API contract between the frontend and the backend.
- `backend/` prices and validates checkouts.
- `frontend/` formats prices and talks to the backend through `shared/src/api.ts` only.

Run the tests with `node --test "**/test/*.test.ts"` (Node 22.18 or newer; no install needed).
