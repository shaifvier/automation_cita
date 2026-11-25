# Browser automation findings — Barcelona ICP+

Research date: **25 November 2026**. Target: **Autorización de regreso**, Barcelona,
«Cualquier oficina». No appointment was selected, reserved, or confirmed.

## Current assessment

SeleniumBase-launched Chrome can be controlled by the existing Node Playwright
library over CDP. Local tests also demonstrated an encrypted-PEM client-certificate
handshake in a separate CDP context and challenge-helper access to that exact tab.

In both authentication paths, Firefox and ordinary Playwright Chrome
returned «sin citas» with code **0501**. SeleniumBase Chrome returned «sin citas»
without a detected response code. After fixing the localized Cl@ve entry, both
ordinary-browser certificate checks also completed with 0501. The SeleniumBase
certificate path completed without a detected code, and three
recurring checks succeeded in the same SeleniumBase certificate context, all
returning «sin citas» without a detected code. This is an observable response difference,
**not proof that the monitor can detect real availability**. A manual positive
control is still required when an appointment-selection page is available.

The previous README categorically attributed 0017/0501 to automation filtering,
based on a reported comparison in Lleida. Its supporting logs were not in this
repository, and this Barcelona experiment did not reproduce a positive control.
Treat that explanation as a hypothesis, not an established meaning of the codes.
[Original README](https://github.com/shaifvier/automation_cita/blob/93eb4f525aab22170c2e4f48690fba839b2df255/README.md).

## Environment and reproduction

- Windows desktop session, Node **20.12.2**, Python **3.12.3**.
- Installed Google Chrome **158.0.8127.37**.
- Playwright **1.65.1**, SeleniumBase **4.59.0**.
- node-notifier **10.0.1**, with UUID overridden to **11.1.1**: newer notifier
  releases require a newer Node runtime. The override is CommonJS compatible;
  the notification command was exercised and the npm audit reported no advisories.
- `package-lock.json` and `requirements-lock.txt` record the installed dependencies.

Use the setup commands in [README.md](../README.md). Supply applicant details and
certificate paths only in the ignored local `.env`. Run a single comparison with:

```powershell
node --env-file=.env scripts/research.cjs --repeticiones=1
```

Use `--browser=chrome|firefox|seleniumbase` to restrict the browser and
`--sin-certificado` or `--solo-certificado` to restrict authentication. The runner
writes sanitized JSONL under ignored `artifacts/`, respects earlier journals when
spacing separate invocations, and stops on human handoff. The initial experiment
uses at most two checks per browser/authentication combination. `--humo` is a
separate three-cycle SeleniumBase certificate smoke test.

## Live observations

Times below are **Europe/Madrid (UTC+1)**. UTC timestamps remain in the local
JSONL journals. A missing code means only that the parser found no supported
four-digit code; it does not establish the server's internal decision.

| Time | Browser / authentication | Observed outcome |
| --- | --- | --- |
| 10:36:11 | Playwright Firefox / without Cl@ve | HTTP 200, final selection stage, «sin citas», 0501 |
| 10:45:21 | Playwright Firefox / without Cl@ve | HTTP 200, final selection stage, «sin citas», 0501 |
| 10:47:44 | Playwright Firefox / certificate | HTTP 200, stopped for review at certificate; availability not checked |
| 10:57:32 | Playwright Chrome / without Cl@ve | HTTP 200, final selection stage, «sin citas», 0501 |
| 10:59:25 | SeleniumBase Chrome / without Cl@ve | HTTP 200, final selection stage, «sin citas», no detected code |
| 11:02:41 | Playwright Chrome / certificate | HTTP 200, stopped for review at certificate; availability not checked (expected_control_timeout) |
| 11:07:09 | SeleniumBase Chrome / certificate | HTTP 200, final selection stage, «sin citas», no detected code |
| 11:09:46 | SeleniumBase Chrome / certificate | HTTP 200, final selection stage, «sin citas», no detected code |
| 11:12:06 | SeleniumBase Chrome / certificate | HTTP 200, final selection stage, «sin citas», no detected code |
| 11:14:26 | SeleniumBase Chrome / certificate | HTTP 200, final selection stage, «sin citas», no detected code |
| 11:16:56 | Playwright Firefox / certificate | HTTP 200, final selection stage, «sin citas», 0501 |
| 11:19:28 | Playwright Chrome / certificate | HTTP 200, final selection stage, «sin citas», 0501 |

The user independently reported that normal Chrome with a certificate reached
«no appointments» in **27 seconds**. The exact time and response code were not
recorded. This is a negative manual baseline, not a simultaneous positive control.

The first certificate run correctly raised a review alert and preserved its
window. The supplied screenshot showed **Access eIdentifier**. The live Chrome
page exposed the localized accessible name **Acceso DNIe / Certificado electrónico**
on `pasarela.clave.gob.es`. The selector now supports both languages and flexible
whitespace; an explicit failure
reason distinguishes click failure, unexpected navigation origin, and a missing
expected control. Certificate navigation is restricted to ICP+ and HTTPS Cl@ve
subdomains; certificate presentation remains restricted to the exact configured
`https://pasarela-ident.clave.gob.es` origin.

One gap between separately launched early probes was shorter than the planned
120 seconds. The research runner was then changed to recover its cooldown from
previous local journals. This observation is not evidence of a tolerated portal
request rate. Normal monitoring defaults to 120 seconds, enforces an 85-second
minimum, honors Retry-After, and enters an extended cooldown after repeated failures.

## Monitor behavior and validation

- An unknown final page produces **revisión**, never an availability claim.
- Potential availability requires the post-request stage, appointment-selection
  wording, and a usable office/date/time control. Generic language/document-type
  controls are insufficient. The alert deliberately says **possible availability**.
- The selection and human-handoff stages permit no booking actions. Handoff
  seals the portal instance, stops navigation tracing, and retains the context
  until the user closes the page. There is no force-click fallback.
- Certificate failure never triggers an immediate fallback to another identity
  flow. Client certificate files remain encrypted/local; logs omit pages, URLs,
  credentials, cookies, request bodies, and certificate paths.
- The CLI exits explicitly after browser cleanup and output flushing, preserving
  the original workaround for certificate-proxy handles that can keep Node alive.
- SeleniumBase's built-in challenge method runs once per episode in an isolated
  worker. A 55-second subprocess limit kills and waits for that worker before
  handoff; the owning Chrome remains available. Method completion is followed
  by page classification and is not considered proof of challenge success.
- Windows test notifications were accepted by the notification API. The user
  confirmed delivery: Do Not Disturb hides the banner until Notification Center
  is opened.

Validation completed:

- **49 Node tests**: classification, response codes, timing/Retry-After, action
  boundaries, secret-safe errors, notification distinctions, three recurring
  control cycles, handoff retention, and browser cleanup.
- **6 browser integration tests**: Firefox, Chrome, SeleniumBase, and a synthetic
  mTLS handshake, plus real-browser HTTP 429 and expired-request recovery fixtures. All flows use local fixtures and synthetic identities. The
  booking sentinel received **zero requests**. The certificate-entry fixture
  includes whitespace in the input button's accessible name.
- **2 Python tests**: worker timeout/failure behavior and subprocess argument/data
  boundaries. Browser integration also exercises the actual worker process.
- The mTLS fixture accepts a self-signed **server** certificate only inside the
  test. Production certificate validation remains enabled.

## Automatic recovery update

The monitor now enters a 15-minute cooldown after three consecutive rejections
or temporary failures. It makes one availability-check attempt in the existing
browser session; another failure extends the cooldown to 30 minutes, then
60 minutes, capped there. A longer numeric or HTTP-date Retry-After takes
precedence over that cap. A successful check restores regular polling and resets
the cooldown progression. These defaults are an operating policy, not a measured
ICP+ unblock time.

Windows receives pause/recovery notifications. JSON records add `waitSeconds`
and `retryAt` (UTC), with `enfriamiento` and `reanudado` transition events. Closing
the browser or Ctrl+C interrupts the wait. Cookies, cache, applicant identity,
client certificate configuration and the pending office remain in the same
session. CAPTCHA and unknown-page handoff still stop automation; repeated expiry is bounded as described below.
Bounded runs stop at their attempt/deadline limits; the research runner carries
recorded retry deadlines across cases and later invocations.

Recovery was tested with a simulated clock and a local HTTP server returning
three 429 responses followed by a normal appointment-check flow. A real Chrome
context retained its synthetic session cookie through all four attempts; its
booking sentinel received zero requests. Additional tests cover repeated failed
probes, long/date Retry-After, episode reset, notifications, cancellation and
research deadlines. We did not deliberately cause a live ICP+ block to test this
change. The earlier live observations above remain the evidence for portal access.

## Expired-request recovery update

The user reported the portal message "Su sesión ha caducado por permanecer
demasiado tiempo inactiva" with HTTP 200 and `result: "sesión caducada"` at
the selection stage. The screenshot and JSON confirm correct classification;
the interruption came from the previous intentional human-handoff policy.
They do not establish the cause or duration of the server-side expiry.

The monitor now schedules up to two request-flow restarts at the normal polling
interval, respecting any longer Retry-After. The next check navigates to the
fixed Barcelona entry point and repeats the configured office/procedure and
certificate/non-certificate path in the same browser context. It does not click
the expired page's Aceptar button, clear cookies/cache, recreate the browser,
or reset the rate-limit failure count. A third expiry without a successful
normal query still hands off for review. Successful normal checks reset the
restart allowance; bounded-run attempt/deadline limits remain in force.

Expiry records retain `sesión caducada` with `session_restart_scheduled`, wait
metadata and a Windows scheduled-restart notification. Recovery emits `reanudado`
with reason `session_recovered`. Repeated expiry uses `session_restart_limit`.
A local HTTP/browser fixture reproduced the exact message after three 429s,
then completed the restarted check with the original synthetic cookie intact.
Its expired-page Aceptar button deliberately points to the booking sentinel;
that sentinel received zero requests. Unit tests also cover restart bounds,
rate-limit progression across expiry, successful episode reset and Retry-After.
This validates recovery behavior locally; it does not establish that every
live portal expiry can be recovered automatically.

## Limits and next evidence needed

No live positive availability was observed, so real availability detection remains
**unverified**. Local fixtures establish control behavior, not the portal's actual
release schedule. No live CAPTCHA was encountered, so challenge resolution is also
unverified; the local tests establish invocation, targeting, and bounded failure.

Polling samples cannot establish the exact release time. Keep the journal's
observation time separate from any inferred time when a slot was published.
A useful future validation is a near-time manual/automated comparison for the same
applicant, procedure, office, and authentication when manual Chrome shows a real
selection screen. Stop at that screen and compare outcomes without choosing a slot.

## Primary technical references

- [SeleniumBase Stealthy Playwright documentation](https://seleniumbase.io/examples/cdp_mode/playwright/ReadMe/): launching Chrome separately and attaching Playwright through CDP.
- [SeleniumBase CDP documentation](https://seleniumbase.io/examples/cdp_mode/ReadMe/): built-in challenge API; supported examples are not guarantees for ICP+.
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp): Chromium-only, lower-fidelity connection with an accessible default context.
- [Playwright client certificates](https://playwright.dev/docs/api/class-browser#browser-new-context-option-client-certificates): origin-scoped certificate configuration on browser contexts.

## Overnight observation

A separate read-only observer can attach to an already-running monitor-owned
Chrome without restarting its appointment checks. It reads categorical page
state every 30 seconds, writes a private JSONL journal and Markdown report,
and captures private PNG evidence when a possible availability page is observed.
It neither navigates nor enters data, clears state, or books an appointment.
Observed times are observation times, not verified appointment-release times.

The observer follows the original monitor PID, preserves its journal across
observer restarts, and issues a scoped Windows keep-awake request until it exits.
This does not override manual sleep, lid closure, shutdown, or sign-in policies.
Primary monitoring/Windows alerts remain with the existing Node process; the
observer is automatic documentation, not continuous human or AI review.

Six observer tests cover host restrictions, expiry/form classification, report
history and Madrid timestamps, locked-report resilience, allowed read-only CDP
methods, and retaining candidate observations when screenshot capture fails.
No live appointment was selected to test capture. Overnight reports and images
remain under ignored `artifacts/`; they are not part of the public research data.
