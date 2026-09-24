# Day-0 target verification — ParaBank

Plan §13 listed ParaBank's reproducibility as the first blocker to resolve. This is what the
probe actually found, and what it changes.

Probed: 2026-09-24, `parasoft/parabank:latest`
digest `sha256:8c08664c7b4be5dc3b1dcf5bbc75f57bbcc1b363ea063fae873409a0883a8e44`

## 1. Seeding is deterministic — simpler than the plan assumed

The plan assumed accounts are generated per registration and that `setup` would have to register
a user and capture whatever IDs came back. Not so:

```
POST /parabank/services/bank/initializeDB   → 204
```

resets the app to fixed seed state. After it:

| | |
|---|---|
| Login | `john` / `demo` |
| Customer ID | `12212` |
| Accounts | `12345` CHECKING −2300.00 · `12456` CHECKING 10.45 · `12567` CHECKING 100.00 · `12678` **SAVINGS** −100.00 · `12789` · `12900` · `13011` · `13122` · `13233` … |

So `npm run setup` is one POST, not a registration flow. Account IDs are stable across resets,
which makes the committed evidence runs reproducible for a reviewer. The `initializeDB` call is
fixture setup only — every automated task still goes through the UI.

Note `john/demo` does **not** work on a fresh container until `initializeDB` has been called.
The DB is file-backed HSQLDB inside the container, so state survives restarts but not
`docker compose down -v`.

## 2. The app is JS-rendered — which validates the ARIA-first choice

`overview.htm` and `activity.htm` ship JSP shells and populate values client-side:

```html
href="activity.htm?id=' + account.id + '"
url: "services_proxy/bank/customers/" + 12212 + "/accounts"
```

Raw-HTML scraping sees empty labels (`Account Number:`, `Balance:` with no values). Any
observation has to run after JS settles. This is what the target is *supposed* to look like —
a server-rendered legacy app with bolted-on AJAX, no test IDs.

## 3. Hidden error text is present in the DOM — handlers must match *visible* text only

This is the finding that actually changes code. `activity.htm?id=12678` — a perfectly healthy
account — contains this in its markup:

```
Error! An internal error has occurred and has been logged.
```

It lives in a hidden `#showError` div that JS reveals only on failure. A handler matching raw
DOM text for `"An internal error has occurred"` would fire on **every successful run**.

Consequences, both already latent in the plan and now non-negotiable:

- `Condition` gets an explicit visibility requirement, defaulted **on**. Matching hidden text is
  opt-in, never the default.
- Observation must come from the ARIA snapshot (visibility-aware) rather than `textContent`.
- The locator contract's "exactly one **visible** match" is load-bearing, not stylistic.

## 4. Confirmed business-outcome text

```
GET /parabank/activity.htm?id=99999   → title "ParaBank | Error"
                                        body  "Error! Could not find account # 99999"
```

That is the `account_not_found` handler match for `lookup_account_balance`, and it is a real
app behavior rather than an invented string.

## 5. Port

The container listens on 8080. Port 8080 was already taken on the probe machine, so
`docker-compose.yml` exposes `${PARABANK_PORT:-8080}` and every default reads from config.
