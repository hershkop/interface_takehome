# Example runs

Six real runs, committed as produced. Nothing here is hand-written.

| directory | what it shows |
|---|---|
| `01-discovery-llm-run` | A genuine `claude-opus-5` run against live ParaBank. 10 model calls, 8 steps recorded. `run.json` names the model; `events.jsonl` carries the model's rationale for each action and the ARIA observations it worked from |
| `02-discovery-refused-irreversible` | The same engine told to perform a transfer, **running unattended**. It filled the form, was refused the Transfer click by the risk gate, and declined to bypass it by POSTing directly — then gave up so a human could take over |
| `03-replay-discovered-artifact` | The **discovered** capability replayed against account `12345` — one the model never visited. `modelCalls: 0` |
| `04-replay-business-outcome` | Account `99999` → `business_outcome: account_not_found`. Exit code 0: an answer, not a failure |
| `05-handoff-human-abort` | `transfer_funds` escalating on its irreversible step. Screenshots before and after the handover, `handoff.requested` / `handoff.returned` events, and `HUMAN_ABORTED` when the operator declined |
| `06-policy-denied` | The same capability under `policies/read-only.json`, refused at the first field it tries to type into |

Every file has been scanned for the configured credentials and the API key; neither appears.
Traces are absent because tracing is off by default — see REPORT.md §6.
