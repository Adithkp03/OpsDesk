# OpsDesk for TBO

Context-rich, travel-aware operations ticketing. Built for the TBO hackathon problem
statement "OpsDesk for TBO(ZenDesk)": cases linked by agency, TBOH, intent and history,
instead of isolated tickets.

**Status: MVP-1 through MVP-7 implemented and tested.** See the checklist below.

## Run it

Requires Node.js 18+ (tested on Node 22). No other services, no API keys, no paid tiers.

```bash
npm install
npm run seed    # first run only: demo agencies, users and the refund case
npm start       # http://localhost:4173
```

For the demo walk-through below, start from the demo seed instead. It adds a transferred
ticket with a supplier conversation, a ticket already in the Escalation Manager queue and
ops theme tags. **It is destructive:** `--wipe` deletes every ticket, link, activity row, user, agency,
thread, audit row, theme tag, CSAT survey and macro in `opsdesk.db` before reseeding (webhook endpoints are kept).
Use it on a throwaway or demo database only, never on one holding data you want to keep (copy `opsdesk.db` first,
or point `OPSDESK_DB` at a new file). It ages tickets relative to the moment you run it,
so run it shortly before a demo (SLA states move with real time):

```bash
npm run seed:demo
npm start
```

Run the checks:

```bash
npm test        # 505 checks across 9 files, including test/journeys.js which walks demo journeys A-E
```

## Demo script (about 4 minutes)

Start from `npm run seed:demo` and `npm start`. Open `http://localhost:4173/?as=<id>` to
sign in as a demo user without the picker: Ananya 1 (agent, APAC), Rohit 2 (agent, MEA and
Europe), Meera 3 (Escalation Manager), Arjun 4 (lead), Priya 5 / Omar 6 / Ingrid 7
(requesters for Skyline, Desert Rose, Nordvik). `npm test` runs the same five journeys over
the API (`test/journeys.js`), so each step below is also an automated check.

**A. Context and linkage (about 45 s)**
1. `?as=5` (Priya, Skyline Travels). New ticket: booking `TBOH-88213`, intent Refund delay,
   title "Refund query for TBOH-88213". Submit.
2. `?as=1` (Ananya). Open the new ticket. The case panel lists the three earlier contacts
   (T-1001, T-1002, T-1003) with the reason "Same booking (TBOH-88213)". Intent is already
   classified.

**B. Routing (about 45 s)**
1. `?as=6` (Omar, Desert Rose). Create a P1 "Urgent: group cancellation terms" with a check-in
   two days out.
2. `?as=4` (Arjun, lead). Open it and press Auto-route. Rohit (MEA) gets it, and the
   ownership audit says: MEA region match, P1 priority, active load, owner.
3. Optional: mark Rohit unavailable in the queue, route again, see the fallback reason.

**C. Side conversation survives a transfer (about 60 s)**
1. `?as=1`. Open T-1008. The ticket moved from Rohit to Ananya at a shift handover. The
   external thread "Voucher for TBOH-88502 pickup" went to the supplier desk and the
   requester, and the supplier replied through the simulated portal.
2. Set the owner back to Rohit, then post a message in the thread. The recipient line stays
   the same two people after the transfer.
3. `?as=7` (another agency) cannot open T-1008. `?as=5` (Priya, a recipient) can read it.

**D. SLA, escalate, work the queue (about 60 s)**
1. `?as=4`, Lead overview: 2 tickets at risk, 1 breached. T-1007 (P1, check-in in two days)
   is at risk.
2. `?as=1`. Open T-1007, type a reason, press Escalate to Escalation Manager.
3. `?as=3` (Meera). Her queue shows T-1009 (already waiting) and T-1007. She cannot open
   other tickets. Move T-1009 to Pending with a note. The escalation is its own timeline event.

**E. Insights and data (about 30 s)**
1. `?as=4`, Weekly insights: themes ranked by ticket count, with sample tickets. Ops tags
   (T-1003 refund and payment, T-1006 with a bug reference) count alongside default intents.
2. Export matching tickets as CSV from the queue (streams every row, no cutoff) and open
   Data retention & archive policy.

What is simulated: supplier and requester messages are never sent anywhere, agent
availability is a toggle, and demo sign-in is impersonable by design (`npm run
start:secured` switches to verified Firebase sign-in).

## Architecture and cost

```
 browser (vanilla JS, no build step)
     |  HTTP + Server-Sent Events (/api/events)
 Express app (server.js)
     |-- auth.js, access.js      demo or Firebase identity, role and agency scope on every route
     |-- intent.js, sla.js       offline Naive Bayes intent, travel-aware SLA policy
     |-- collaboration.js        routing, ownership audit, side conversations
     |-- travel.js, portal.js    escalation, insights, simulated supplier portal
     |-- webhooks.js, csat.js, macros.js   local-only webhooks, CSAT, canned replies
     `-- better-sqlite3 (one file)   tickets, links, activity, threads, audit
```

Cost of this build: no per-seat or per-add-on licence, no per-call API, no model calls, no
paid services. It runs as one Node process and one SQLite file, and every feature in the
checklist above ships in the same repository. Linking, routing, SLA, side conversations,
insights, export, webhooks, CSAT and macros are code in this repo rather than separately
priced add-ons or metered APIs. This page does not quote any vendor's prices. To compare
with a priced suite, count the add-ons and API calls that suite charges for the same
features. Limits: single tenant, SQLite (the scale path is documented under MVP-6), and
simulated outbound messaging.

## Demo users (demo auth, as the brief allows)

Pick a user on the login screen. The browser sends the id as an `X-User-Id` header;
`?as=<id>` preselects one. This is demo auth for the hackathon, as the brief allows -
it is not production security. A real deployment would put a proper IdP in front;
the server-side agency scoping is the part that carries over.

| User | Role | Sees |
| --- | --- | --- |
| Ananya Rao, Rohit Sharma | Agent | All org queues |
| Meera Iyer | Escalation Manager | Only the escalation queue: tickets explicitly handed over to her, including their allowed linked history |
| Arjun Nair | Lead | All org queues plus the lead overview (org-wide metrics and reporting) |
| Priya Menon / Omar Haddad / Ingrid Berg | Requester | Only tickets they created within their own agency, plus linked history they are allowed to see |

## What stage 1 proves (Problem 1 in the brief)

- Tickets carry title, description, agency, TBOH booking ref, priority, intent,
  check-in / LCD travel fields, status and owner.
- **First-class linkage**: a new ticket auto-links to existing ones on the same agency +
  TBOH, and same agency + intent, with the reason stored on the link. No third-party app.
  A case is the whole connected group: if A-B and B-C are linked, A's case shows B and C.
  Cases stay within one agency; cross-agency links are refused so no agency can see
  another's tickets through a case.
- The case panel shows every linked ticket with why it is linked, so an agent opening the
  third refund contact sees the first two immediately (seeded story: TBOH-88213,
  "same refund, three contacts").
- Fixed intent taxonomy and a fully offline example-trained Naive Bayes classifier
  with unigram/bigram features, clause-scoped negation and conservative abstention.
  Ambiguous, mixed or low-evidence text asks for manual review without overwriting
  the agent's choice. Model scores are relative scores, **not measured accuracy**.
  Training examples, thresholds and method live in `intent.js`; no keys or paid APIs.
- Status flow: New -> Open -> Pending -> Escalated -> Resolved -> Closed.
- Activity timeline records creation, links, status changes, escalations (first-class
  event, not just a status line) and assignments with actor and time.
- Agency scoping: requesters only read and file for their own agency (403 otherwise).
- Durable SQLite storage: refresh never wipes the queue, and the queue, cases and
  timelines survive a full server restart (tested).

## Feature checklist mapped to the brief

| Brief requirement | Stage | Status |
| --- | --- | --- |
| MVP-1 Context-rich tickets, linkage, intent, status flow, timeline | 1 | Done |
| MVP-2 Routing & ownership (region, availability, load + priority views and reasons) | 2 | Done |
| MVP-3 Side conversations with explicit recipients surviving transfer | 3 | Done (external replies simulated) |
| MVP-4 Travel-aware SLA + first-class escalation | 4 | Done (explicit demo SLA policy) |
| MVP-5 Theme tags + insights view | 5 | Done (tagged insights; optional AI stretch not included) |
| MVP-6 Persistence, export, scale documentation | 6 | Done (streaming CSV without row cutoff; retention/scale design below) |
| MVP-7 Roles & access | 7 | Done (role table enforced at the API, not just hidden UI) |

## Secured mode (Firebase Authentication)

Default startup is the documented hackathon demo auth (selectable identity header),
which keeps the app fully offline. Setting `OPSDESK_AUTH_MODE=firebase` switches to
verified sign-in and **deletes the impersonation path**: the `X-User-Id` header is
rejected and every request needs a Firebase ID token.

- The provider proves **identity only**. Role and agency scope stay server-owned in
  the SQLite `users` row matched by the verified account's `firebase_uid`; every
  rule above (requester creator+agency, EM escalation queue, lead overview) is
  enforced by the same code and tests in both modes.
- The server verifies tokens against Google's published public signing
  certificates (RS256 signature, issuer, audience, expiry) - the same check the
  Firebase Admin SDK performs. **No service account or private key is stored**.
- Privileged roles (agent, EM, lead) are provisioned by an administrator writing
  the `firebase_uid` onto the users row. Self-registration cannot pick a role or
  an agency. Requester accounts must likewise be provisioned with their agency
  binding by an administrator.

Running secured mode:

```bash
npm run start:secured   # OPSDESK_AUTH_MODE=firebase node server.js
```

No other setup is needed: the Firebase web client config is committed as
`firebase-client-config.web.json`. That file is browser-publishable client
configuration by design (it ships to every browser that loads the app), not a
secret; it contains no credential. Optional overrides, highest precedence first:

```bash
OPSDESK_FIREBASE_CLIENT_CONFIG='{"apiKey":"...",...}'  # replaces the committed file
OPSDESK_FIREBASE_PROJECT_ID=<project id>                  # defaults to the config's projectId
OPSDESK_TOKEN_STUB=1   # TEST ONLY: accepts Bearer test-<uid>; never set in a real deployment
```

## Two auth modes, deliberately separate

The app has exactly two auth modes and they cannot blend:

- `demo` (plain `npm start`): the brief-sanctioned offline hackathon auth. The
  client picks an identity via the `X-User-Id` header so the whole demo works
  with no internet and no accounts. It is impersonable **by design and labeled
  as such**: on startup the server prints a loud WARNING that it is running
  impersonable demo auth and how to switch. This is the default so the
  hackathon demo never depends on a network or an IdP.
- `firebase` (`npm run start:secured`): the production-shaped path. The server
  rejects the `X-User-Id` header outright (401), requires a Firebase-verified
  ID token on every API call, and refuses to start without a project id. There
  is no fallback: a request either carries a valid verified token or it fails.

Choosing a mode is an explicit act (`start:secured` or the env var); nothing
silently downgrades a secured run to demo auth, and a secured run that cannot
verify tokens fails closed (401), never open.

Firebase free (Spark) plan needs no payment information; Authentication with
standard providers is a no-cost Firebase product. Email/password accounts here
are synthetic; sign-in requires internet access to Google.

Provisioned synthetic demo accounts (all passwords live in the project owner's
password vault, one login per account; `demo-auth-accounts.json` maps each
account's Firebase UID to its seeded user and is re-applied by `node seed.js`):

| Account email | Demo user | Role |
| --- | --- | --- |
| ananya.rao@opsdesk.demo | Ananya Rao | agent |
| rohit.sharma@opsdesk.demo | Rohit Sharma | agent |
| meera.iyer@opsdesk.demo | Meera Iyer | escalation manager |
| arjun.nair@opsdesk.demo | Arjun Nair | team lead |
| priya.menon@opsdesk.demo | Priya Menon | requester (agency 1) |
| omar.haddad@opsdesk.demo | Omar Haddad | requester (agency 2) |
| ingrid.berg@opsdesk.demo | Ingrid Berg | requester (agency 3) |

## Stack and assumptions

- Node.js + Express + better-sqlite3, vanilla JS frontend. No build step.
- Demo login instead of a real IdP (brief-sanctioned assumption).
- Single-tenant TBO organization for the hackathon (brief-sanctioned assumption).
- Intent model: small, curated-corpus multinomial Naive Bayes with safety rules for
  abstention, not an LLM. Corpus has 104 examples across 8 intents; Other is the manual
  fallback. Scores are uncalibrated and the corpus is English travel-ops text, not a
  general language-understanding system. Unknown wording and complex negation may
  need manual review. Tests are regressions, not a representative accuracy benchmark.
- Description, booking reference and travel dates may be omitted for enquiries before
  booking. Agency, title, priority and taxonomy choice are required. Dates, when
  supplied, must be real calendar dates, including valid leap years.
- Agent availability is simulated, toggled in the queue. No real staff presence is queried.

## API sketch

`GET /api/bootstrap` · `GET /api/tickets` · `POST /api/tickets` · `GET /api/tickets/:id`
(case + timeline) · `POST /api/tickets/:id/status` · `POST /api/tickets/:id/assign` ·
`POST /api/tickets/:id/links` · `POST /api/intents/suggest`

All ticket endpoints require the `X-User-Id` demo header and enforce agency scoping.

## MVP-2: routing and ownership

- Assign, reassign and explicitly unassign. Manual actions carry operator, time and an
  optional explanation; every ownership write uses one atomic assignment/audit transaction.
- Auto-route excludes unavailable agents, prefers matching agency region, then chooses
  lowest active workload; stable agent-id tie-break. Ananya covers APAC, Rohit MEA/Europe.
  No available agents returns 409 and preserves ownership. If the regional agent is away,
  fallback is clearly recorded. Manual assignment may override availability deliberately.
- Queue is P1/P2/P3-ranked. Region and availability are the two required routing signals;
  load is an extra tie-break, priority ranks the queue. Time-window routing is not claimed.
- Views: all tickets; triage (strictly unassigned); my queue; region; intent; linked tickets
  opening their connected case. Composable filters retain agency scoping.
- Routing and manual ownership reasons are displayed and stored with actor/time.

## MVP-3: independent side-conversation audiences

- Threads have a subject, immutable visibility and an explicit recipient list, not a
  list derived from assignment or ticket group. New audience means a new thread.
- Each message stores a snapshot of that thread's contact list. Assign/reassign/unassign
  never edits recipients. A new owner can continue the same thread to the original list.
- Internal notes accept ops recipients only and are readable only by ops demo roles.
  External threads are readable/repliable by a requester only when explicitly addressed
  and in the ticket's agency. Supplier-only threads are not exposed to agency requesters.
- Side notes never enter the requester-visible shared case timeline. Threads remain on
  their own ticket and are not copied into linked tickets. Cross-agency recipients denied.
- All external replies and `.invalid` contacts are **simulations inside the app**. No SMTP,
  real email, SMS or third-party message is sent. Recipient lists are observable in the UI.
- Demo user selection is not production authentication. Internal-note isolation is verified
  under the selected demo role; an attacker can impersonate a demo role via its header.

### Stage 2+3 verification

`npm test` includes 102 API regression checks plus a real Node-process restart test.
The restart test verifies tickets, shared history, routing audit, availability and thread
recipient/message snapshots. Reassignment tests include a new-owner reply and unassignment;
privacy tests include list/read/write attacks, linked-ticket paths and audience injection.


## MVP-4: travel-aware SLA and direct escalation

This is an explicit **demo resolution SLA policy**, not TBO's contractual policy. It uses
calendar hours, no weekend/holiday calendar, and no pause while Pending:

| Priority | Base budget from creation |
| --- | --- |
| P1 | 4 hours |
| P2 | 12 hours |
| P3 | 24 hours |

Take the earlier of check-in and LCD, at **00:00 UTC** on the supplied date. Its proximity
at ticket creation caps the budget at 1 hour within 24 hours, 4 hours within 72 hours,
or 12 hours within 7 days. Use the smaller of priority and travel budgets. The travel
date itself is a final hard cap, including already-past dates. No travel dates means
priority alone. The ticket shows the deadline, policy and applied reason.

- On track below 75% of the allowed time, At risk at/after 75%, Breached at/after deadline.
- Queue badges and the SLA-health filter are calculated on every read. The visible queue
  refreshes once a minute. Detail uses the time of its last read; refresh to recheck.
- Assigning, escalating, tagging and Pending do not reset or pause the deadline.
- Resolving stores `completed_at`; closing preserves it. Completed outcome is met/breached
  against that time. Legacy resolved rows without a timestamp show an unknown outcome.
  Reopening clears completion but keeps the original creation-based deadline.
- **Escalate to Escalation Manager** requires an ops role and a reason. It atomically changes
  status to Escalated, owner to an actual EM, and queue to escalation. The least-loaded EM
  wins, with a stable user-id tie-break. With no EM, it returns 409 and changes nothing.
  The status API's legacy Escalated value uses the same handover logic, never status-only.
- The handover has a first-class timeline event with actor/time/reason plus ownership audit.
  It does not alter side-thread recipients. No follower/email workaround or real send.
- Operations and Escalation Manager queue chips are explicit queue views; My queue is still
  the current user's ownership view. Manual assignment to an EM selects escalation queue;
  an agent, lead or unassigned selects operations. Status is independent and can remain
  Escalated after a deliberate hand-back until an ops user changes it.
- Existing data is migrated additively, never reseeded on startup. Pre-stage4 historical
  Escalated statuses are not silently reassigned. Use the explicit action to hand them over.

Fresh seeding uses relative travel/creation times to illustrate on-track, at-risk and breached
states. `node seed.js --wipe` **deletes all demo tickets and conversations**, then reseeds.
Normal `npm run seed` refuses to overwrite an existing database; `git pull` does not wipe it.

## MVP-5: feedback themes and this-week insights

- Theme tags default to the ticket's fixed intent taxonomy. Ops can correct/add multiple
  themes, with an audit event, without changing that original intent. No freeform model
  extraction or access to side-conversation text is needed.
- Optional product/bug reference is plain text, persisted on the feedback record. It is not
  a live issue tracker integration and does not create a bug or send a message.
- Weekly insights are ops-only: **Monday 00:00 UTC through the current time**, based on ticket
  creation, not last update. Future-dated rows and older tickets are excluded. Editing an
  older ticket does not make it a new contact this week.
- Rank themes by distinct ticket count, then label for a stable tie-break. Multi-tag tickets
  count once per theme, so totals can exceed weekly tickets. Each card shows up to 3 newest
  sample tickets with working links, not an artificial limit on aggregation.
- Requesters cannot open the insight or feedback editing APIs, or trigger escalation.
  Existing agency scoping and internal-note protections remain. Demo auth is not production
  authentication. Full role-specific views are still MVP-7.
- The optional linked-history AI assist and regional holiday calendars are not implemented.
  Existing connected-case history stays accessible from every insight sample ticket.

### Stage 4+5 verification

`npm test`: **173 checks** (54 + 48 + 71), plus an independent real-process restart test.
SLA boundary/priority/travel-cap/completion tests, explicit escalation handover/no-EM failures,
recipient conservation, requester API attacks, weekly boundaries/future exclusion, multi-tag
counts, sample bounds and empty states are covered. Restart verifies the original state plus
escalation owner/queue, fixed deadlines, feedback themes, product reference and insight counts.
The moving SLA countdown/evaluation time is intentionally excluded from restart equality.
Actual Chrome UI verification also exercises health filters, escalation reason/owner/queue,
EM's queue, save/reopen tags, insight sample navigation and requester denial.

## MVP-6: persistence, export and scale

- Durable local SQLite storage (since stage 1): startup never reseeds or clears the
  database, and a full OS-process restart preserves tickets, cases, conversations,
  audit, escalation state and feedback. Verified by an independent restart test.
- **Export matching tickets** streams a real CSV using the current region, intent,
  status, queue and SLA-health filters. The active filters are recorded in header
  comment lines at the top of the file.
- **No row cutoff.** The regression test exports 3513 synthetic tickets including the
  last row, with unique identifiers. The CSV is streamed, not buffered in memory.
- Spreadsheet formula prefixes (`=`, `+`, `-`, `@` and leading-whitespace variants)
  are neutralized so opening the CSV in Excel/LibreOffice cannot execute a cell.
- Exports exclude side-conversation bodies and feedback product references. Ticket
  descriptions are included and may contain private data: protect exported files.
- Retention policy, stated in-app at `#/data` (`GET /api/data-policy`): **no automatic
  expiry, deletion or archival**. Resolved and Closed are workflow states, not an
  archive tier. Data remains until the local owner deliberately removes the database
  or runs the documented destructive seed reset.
- Backups: stop the app and copy the database plus any `-wal`/`-shm` files together,
  or use the SQLite backup API. Protect backups and exports; no cloud backup exists.
- **Scale design path** (documented design, not a performance claim): SQLite is a
  single-process demo store, not a production 50K-row or near-real-time guarantee.
  A production deployment would use scheduled snapshot export jobs instead of
  interactive full exports, keyset (cursor) pagination instead of OFFSET for large
  queues and APIs, a change-data-capture feed or transactional outbox table for
  near-real-time downstream updates, and object storage (e.g. S3) for large export
  artifacts with time-limited download URLs. Retention tiers and the existing
  API-enforced access scoping carry over unchanged.

## MVP-7: roles and access (enforced at the API)

The UI hides controls a role cannot use, but every rule below is enforced by the
server on each request, so URL guessing and header replay cannot bypass it:

- **Requester**: reads only tickets they created within their own agency, including
  linked history they are allowed to see. Cannot change status, assign, link,
  escalate, edit themes, view insights or export operations data. A same-agency
  colleague's ticket is not automatically shared. Existing external-thread recipient
  checks still apply and internal notes remain hidden.
- **Escalation Manager**: sees only escalation-queue tickets. Receives tickets through
  the explicit handover, can work them and use escalation actions, and exports only
  that queue. Direct URLs to ordinary tickets, org queues, the lead overview and
  insights are denied; linked history cannot reveal tickets outside her scope.
  Handing a ticket back to operations removes her access to it.
- **Agent**: all org queues and ticket work; no lead overview.
- **Lead**: all org queues plus `#/lead` (`GET /api/lead`): org-wide ticket totals,
  active unassigned work, escalation load, service-risk (SLA) counts, and status and
  region breakdowns that link back to the filtered org queues and weekly insights.
- The `X-User-Id` demo header is validated against real seeded users on every
  request; unknown ids are rejected. `/api` responses are `no-store`.
- Demo auth remains an explicitly selectable identity, as the brief allows: an
  attacker can impersonate a demo role via its header. This is not production
  authentication.

### Stage 6+7 verification

`npm test`: **259 checks** (54 + 48 + 71 + 86 new data-access checks), plus the
independent real-process restart test. New coverage includes large export without
cutoff (3513 rows including the last row), scope headers, formula escaping, requester
creator+agency scoping, same-agency colleague privacy, EM escalation-only scope across
queues/detail/insights/export/case traversal, role change after hand-back, lead
overview access, and demo-header validation. Restart re-verifies the original state.
Actual Chrome verification adds 23 checks: lead metrics, real CSV download, refresh
persistence, retention page, EM scope and denials, requester scope and hidden
controls, agent lead denial and user switching.

## Additions: real-time sync, conversation intent, supplier portal

Three user-requested capabilities on top of the secured MVP:

**Real-time dashboard sync.** Every ticket mutation already funnels through one
activity chokepoint; an in-process event bus (`realtime.js`) republishes those as
Server-Sent Events on `GET /api/events`. The client streams that endpoint with
`fetch()` and credentials ONLY in request headers (Bearer token in secured mode,
demo header in demo mode) - never in the URL, so tokens cannot leak through access
logs or browser history. Each connection is scoped server-side: agents/EMs/leads
receive all ticket events; requesters receive events for their own created tickets
only, exactly the API role model. Payloads carry only `{ticket id, activity type}` -
the client re-fetches its own scoped views, so no cross-agency data travels the
stream. The header badge shows **Live** when the stream is connected and **Polling**
when it falls back to a 15s authenticated refresh (replaces the old fixed 60s poll).
Zero new dependencies.

Stream lifetime is bounded by the SHORTER of 55 minutes and the verified token's
own expiry minus a 30-second margin: a stream opened with an almost-expired token
closes when that token expires, and a token inside the margin is refused (401) so
the client force-refreshes (`getIdToken(true)`) and reconnects. Live access never
outlives the credential that authorized it by more than the margin. Note: account
REVOCATION (disabling a user in Firebase) cannot be checked without the Admin SDK /
a service account, which this design deliberately avoids - a revoked account loses
API access when its current token expires and live access at the next stream
reconnect; it is not immediate.

**Stronger auto-intent from conversation text.** The Naive Bayes classifier gained
conversation-phrasing corpus examples (how intents read mid-thread: chasers,
follow-ups, "the hotel has not confirmed yet") and a conversation-weighted path:
ticket title x3, description x2, accumulated thread text x1, capped so a long thread
cannot drown the original ask. Abstention semantics are unchanged - weak or mixed
evidence still asks for manual selection. `POST /api/tickets/:id/intent-resuggest`
aggregates the side-thread messages the CALLER may read (ops see all threads on the
ticket; requesters only external threads they are recipients of) and returns a
suggestion with sources. Applying it is a separate permission-checked call
(`POST /api/tickets/:id/intent`): ops roles, or the requester who created the
ticket - the same manual-select owner as at creation, logged on the timeline. The
ticket view has a "Re-check intent from conversation" button.

**Supplier portal thread UX (simulated, demo-only - NOT production-ready).** An ops
user can create a token link per supplier recipient of an EXTERNAL side thread
(`POST .../threads/:threadId/portal-links`; a live link is idempotent - same URL
returned - while re-creating a revoked or expired link ROTATES the capability: a
fresh token is minted and the old URL stays disabled forever). The link opens
a standalone page (`/portal/:token`) showing just that thread - subject, ticket
reference, sanitized messages - with a reply box. The token is the capability:
anyone holding the link can read and reply as that supplier contact, which the page
labels; this is demo-only and nothing is sent outside OpsDesk. Links are bounded:
each expires 72 hours after creation (`expires_at`, backfilled for pre-existing
links) and ops can revoke one immediately
(`POST .../threads/:threadId/portal-links/revoke`), both logged on the timeline.
Replies land in the OpsDesk thread as `via=portal` messages attributed to the
supplier contact and publish a live event to connected dashboards. Old databases
migrate in place (side_messages gains via/author_contact_id; existing messages
preserved as ops messages).

### Verification

`npm test`: **349 checks** (54 + 48 + 71 + 86 + 28 secured-auth + 62 new), plus the
independent real-process restart test. New coverage: SSE header-only auth (401 for
missing/unknown credentials AND for query-string credentials in either auth mode),
stream lifetime bounded by the verified token exp with margin (55-min cap for
no-exp tokens, exp-minus-margin for short-lived tokens, 401 for almost-expired
tokens), live event delivery, requester event scoping (own tickets only), id-only
payloads, conversation-weighted suggestion and unchanged abstention, resuggest
caller scoping, apply permissions (agent/creator/non-creator/invalid), portal link
permissions (ops-only, external-only, supplier-recipient-only), live-link
idempotency, capability ROTATION on renewal after revoke/expiry (prior URLs stay
rejected), sanitized portal view, exactly one message per portal reply, portal
reply attribution and live event, bad-token 404s, and the simulation banner.

## Webhooks, CSAT and macros (local / simulated)

Everything here runs on this machine only. No email is sent, no external service is called.

### Webhooks for ticket create / update
- Events: `ticket.created` and `ticket.updated` (status, owner, intent, link, thread, CSAT... `change.type` names the activity).
- Open **Webhooks** in the header (leads add, pause, rotate and delete endpoints; all ops can read the delivery log).
- **Destinations are limited to this machine** (`localhost`, `127.0.0.1`, `::1`). Other hosts are refused when saving and again at send time; redirects are never followed. Sending anywhere else needs a deliberate code change after an owner decision. This is not enabled.
- Payload: event id, time, and for the ticket only `id, status, priority, intent_id, agency_id, assigned_to` plus `change.type`. No titles, descriptions, messages, booking refs or names.
- Signing: each endpoint has its own secret (shown once). Header `X-OpsDesk-Signature: t=<unix>,v1=<hex>` where `v1` is HMAC-SHA256 of `"<t>.<raw body>"`. Receivers should reject stale timestamps and de-duplicate on the event id. Secrets are stored in the local SQLite file because signing needs them; protect that file like any credential.
- Delivery: queued in SQLite, at-least-once, not ordered, 4 attempts (waits 2s, 10s, 60s), 3s timeout. Pending retries survive a restart. Failed deliveries can be redelivered by a lead.
- Offline test receiver: `POST /webhook-sink` verifies the signature. Add `?fail=2` to make it refuse the first two attempts of each delivery and watch the retries.
- Tuning for tests: `OPSDESK_WEBHOOK_BACKOFF_MS`, `OPSDESK_WEBHOOK_MAX_ATTEMPTS`, `OPSDESK_WEBHOOK_TIMEOUT_MS`.

### CSAT after resolve
- Moving a ticket to Resolved/Closed requests a 1-5 rating (+ optional comment) from the requester who opened it. It appears as a prompt on the ticket and a timeline entry marked simulated.
- Only that requester can answer, only while the ticket is resolved, once per resolution. Reopening voids an unanswered survey; resolving again asks again. Tickets opened by ops staff are skipped (logged).
- Ops see answers on the ticket and a summary page (**CSAT**): average, response rate, score distribution, by intent, by owner, low scores.

### Macros / canned replies with intent-aware suggestions
- Starter macros exist per intent plus general ones. Placeholders: `{{ticket_ref}} {{booking_ref}} {{requester_name}} {{agency}} {{agent_name}} {{intent}} {{check_in_date}} {{last_cancel_date}}`. Missing values show as `[bracketed]` gaps and are reported.
- Suggestions rank by the ticket's intent, then by the intent the conversation points to when it differs (same rule-based suggester as "Re-check intent"), with the reason shown. A conversation-based suggestion tells the agent to review the intent first and never changes it.
- A macro only **fills a draft** in the thread reply box. The agent edits it and sends with the normal button.
