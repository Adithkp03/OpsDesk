# OpsDesk for TBO

Context-rich, travel-aware operations ticketing. Built for the TBO hackathon problem
statement "OpsDesk for TBO(ZenDesk)": cases linked by agency, TBOH, intent and history,
instead of isolated tickets.

**Status: stage 1 of 7 (MVP-1, context-rich tickets + first-class linkage). Working and tested.**
Later stages add routing, side conversations, travel-aware SLA/escalation, insights, data
access and full role views. See the checklist below.

## Run it

Requires Node.js 18+ (tested on Node 22). No other services, no API keys, no paid tiers.

```bash
npm install
npm run seed    # first run only: demo agencies, users and the refund case
npm start       # http://localhost:4173
```

Run the checks:

```bash
npm test        # 15 API smoke checks against a temp database
```

## Demo users (demo auth, as the brief allows)

Pick a user on the login screen. The browser sends the id as an `X-User-Id` header;
`?as=<id>` preselects one (demo convenience, not security).

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
- The case panel shows every linked ticket with why it is linked, so an agent opening the
  third refund contact sees the first two immediately (seeded story: TBOH-88213,
  "same refund, three contacts").
- Rules-based intent suggestion (keyword scoring, title weighs 2x) with confidence and
  matched terms; manual select always overrides. Approach documented in `intent.js`.
- Status flow: New -> Open -> Pending -> Escalated -> Resolved -> Closed.
- Activity timeline records creation, links, status changes and assignments with actor
  and time.
- Agency scoping: requesters only read and file for their own agency (403 otherwise).
- Durable SQLite storage: refresh never wipes the queue.

## Feature checklist mapped to the brief

| Brief requirement | Stage | Status |
| --- | --- | --- |
| MVP-1 Context-rich tickets, linkage, intent, status flow, timeline | 1 | Done |
| MVP-2 Routing & ownership (region/time/priority/availability + reasons, queue views) | 2 | Planned |
| MVP-3 Side conversations with explicit recipients surviving transfer | 3 | Planned |
| MVP-4 Travel-aware SLA + first-class escalation | 4 | Planned |
| MVP-5 Theme tags + insights view | 5 | Planned |
| MVP-6 Persistence, export, scale documentation | 6 | Persistence done in stage 1; export + docs planned |
| MVP-7 Roles & access | 7 | Demo auth + requester scoping in stage 1; full role views planned |

## Stack and assumptions

- Node.js + Express + better-sqlite3, vanilla JS frontend. No build step.
- Demo login instead of a real IdP (brief-sanctioned assumption).
- Single-tenant TBO organization for the hackathon (brief-sanctioned assumption).
- Intent model = rules, not ML: zero cost, no GPU, honest confidence. Lightweight ML over
  linked history is a stretch item.
- Simulated agent availability will land with the routing stage (brief-sanctioned).

## API sketch

`GET /api/bootstrap` · `GET /api/tickets` · `POST /api/tickets` · `GET /api/tickets/:id`
(case + timeline) · `POST /api/tickets/:id/status` · `POST /api/tickets/:id/assign` ·
`POST /api/tickets/:id/links` · `POST /api/intents/suggest`

All ticket endpoints require the `X-User-Id` demo header and enforce agency scoping.
