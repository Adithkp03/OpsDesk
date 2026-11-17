# OpsDesk for TBO

Context-rich, travel-aware operations ticketing. Built for the TBO hackathon problem
statement "OpsDesk for TBO(ZenDesk)": cases linked by agency, TBOH, intent and history,
instead of isolated tickets.

**Status: MVP-1, MVP-2 and MVP-3 implemented and tested; four later stages remain.**
Later stages add travel-aware SLA/escalation, insights, export and full role views. See the checklist below.

## Run it

Requires Node.js 18+ (tested on Node 22). No other services, no API keys, no paid tiers.

```bash
npm install
npm run seed    # first run only: demo agencies, users and the refund case
npm start       # http://localhost:4173
```

Run the checks:

```bash
npm test        # 54 MVP-1 checks + 48 routing/conversation checks + real-process restart test against a temp database
```

## Demo users (demo auth, as the brief allows)

Pick a user on the login screen. The browser sends the id as an `X-User-Id` header;
`?as=<id>` preselects one. This is demo auth for the hackathon, as the brief allows -
it is not production security. A real deployment would put a proper IdP in front;
the server-side agency scoping is the part that carries over.

| User | Role | Sees |
| --- | --- | --- |
| Ananya Rao, Rohit Sharma | Agent | All org queues |
| Meera Iyer | Escalation Manager | All queues (escalation actions land in the SLA stage) |
| Arjun Nair | Lead | All queues |
| Priya Menon / Omar Haddad / Ingrid Berg | Requester | Only their own agency's tickets |

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
| MVP-4 Travel-aware SLA + first-class escalation | 4 | Planned |
| MVP-5 Theme tags + insights view | 5 | Planned |
| MVP-6 Persistence, export, scale documentation | 6 | Persistence done in stage 1; export + docs planned |
| MVP-7 Roles & access | 7 | Demo auth + requester scoping in stage 1; full role views planned |

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
