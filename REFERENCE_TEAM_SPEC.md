# Reference Team ("Dummy Team") — Technical Specification (v1)

> **What this is.** A specification for a deliberately mindless AI "team" that drives the
> orchestration web service through every documented protocol flow **without doing any real
> work.** It lives in the same repository as the web service and serves three purposes at
> once:
>
> 1. **Protocol validation** — proof that the server's API is complete and coherent enough
>    for a real team to operate against.
> 2. **Integration / regression test suite** — an executable harness run on every server
>    change.
> 3. **Reference implementation** — the canonical worked example for anyone building a real
>    team, showing exactly how a team is expected to talk to the server.
>
> **Relationship to the server spec.** This document assumes the server described in
> `SPEC.md` (the orchestration web service). It references that spec's resources, endpoints,
> and the core vocabulary in its Appendix A. Where the two disagree, `SPEC.md` is
> authoritative for server behavior; this document is authoritative for what the reference
> team must exercise.

---

## 1. Purpose and design stance

### 1.1 Why a dummy team exists

The server's defining property is that it is **a referee of nothing** — all intelligence is
client-side. The reference team is the direct embodiment of the protocol's *client contract*.
If a brain-dead script can carry a project from RFP → board → a coder/tester loop →
completion using only the documented endpoints, the protocol is proven complete. If it
cannot, there is a hole in the server spec — found deterministically, in seconds, instead of
later while entangled with model nondeterminism.

A real team introduces LLM nondeterminism, capacity scheduling, model selection, prompting,
and genuine long-running work all at once, on top of an unproven protocol. When something
breaks, you cannot tell whether it is the server, the workflow logic, or the model. The
reference team makes the **protocol layer deterministic and fast**, isolating it as a known-
good substrate before any real team is built on top.

### 1.2 What it is NOT

- **Not a framework.** It is a flat set of scripted scenarios. It MUST resist abstraction
  layers, plugin systems, or configurability beyond what §6 specifies. The moment it grows
  into a mini-framework it competes for effort with the real team.
- **Not a worker.** It performs **no real work.** A "coder" writes a hardcoded stub or posts
  a canned conversation entry; a "tester" approves on a scripted schedule. Outputs are
  deliberately trivial.
- **Not model-backed.** It calls **no LLM**. Every decision is hardcoded or driven by a
  simple deterministic rule (a counter, a coin flip with a fixed seed). Determinism is the
  whole point.

### 1.3 Core stance

| Principle | Consequence for the reference team |
|---|---|
| Server refs nothing | The team must verify the server *accepts garbage* (§5), not just happy paths. |
| Determinism | No real randomness; seed any "coin flips." Same run → same result. |
| Speed | Whole suite runs in seconds. Polling intervals are tiny (sub-second) in test mode. |
| Documentation-by-example | Code is readable and commented as the canonical "how to talk to the server." |

---

## 2. Repository placement & shape

Lives in the same repo as the server. Suggested layout (adapt to the server's actual
structure):

```
/reference-team
  /src
    client.ts          Thin typed wrapper over the server HTTP API (the reusable part).
    scenarios/         One file per scenario (§4). Each is a self-contained walk.
      happy_path.ts
      approval_gate.ts
      coder_tester_loop.ts
      schema_versioning.ts
      attachments.ts
      garbage_in.ts
      notifications.ts
    runner.ts          Runs one/all scenarios, prints pass/fail, exits non-zero on failure.
    assertions.ts      Tiny assert helpers (assertEquals, assertStatus, assertEventually).
  README.md            How to run it; what each scenario proves.
```

- **Language:** match the server (TypeScript recommended, per the server spec).
- **`client.ts` is the only reusable abstraction permitted.** It is a thin, typed
  pass-through to the documented endpoints — no workflow logic, no retries beyond what the
  protocol's idempotency guidance suggests. Everything workflow-shaped lives in `scenarios/`
  as explicit, linear code.
- It is acceptable (encouraged) for `client.ts` to be the same typed API client the SPA uses,
  if the repo can share it. Sharing means the reference team also validates that client.

---

## 3. Execution model

### 3.1 How it runs

- A single entrypoint (`runner.ts`) runnable as `npm run reference-team` (and per-scenario,
  e.g. `npm run reference-team -- --scenario approval_gate`).
- Runs against a configurable base URL (local dev server by default; CI server in pipelines).
- Provisions or is handed credentials for: **one user actor** and **one or more agent
  actors** (the team's "members"). In test mode, the runner may use a privileged path to mint
  agent tokens and act as the single user; document this clearly. It must not depend on a
  human being present.
- **Acts as both sides of the conversation.** Because there is no human and no real agent, the
  runner plays *both* the user actor and the agent actors, switching credentials per request
  to simulate the asynchronous back-and-forth. This is the key trick: one process, multiple
  authenticated identities, driving the protocol as if a distributed team and a human were
  interacting.

### 3.2 Polling, compressed

The protocol is poll-based. The reference team simulates the workflow-manager poll loop, but
with **tiny intervals** (e.g. 50–200 ms) and an **`assertEventually`** helper that polls
`?updated_since=` until a condition holds or a short timeout fails the test. This exercises the
real polling contract (including `updated_since` correctness) without the production 60s
cadence.

### 3.3 Output & CI

- Prints a per-scenario and per-step pass/fail log.
- **Exits non-zero on any failure** so it gates CI.
- Designed to run on every server change as the integration regression suite.
- Each scenario is independent and self-cleaning where possible (creates its own project), so
  scenarios can run in any order / in parallel later.

---

## 4. Required scenarios (the acceptance checklist)

Each scenario MUST drive the named flow end-to-end against the live server and assert the
observable results. Together they must touch **every documented endpoint** and **every core
state transition** in the server spec's Appendix A.

> Legend: **(U)** = acting as the user actor; **(A:name)** = acting as a specific agent actor.

### 4.1 `happy_path` — full lifecycle, no gates

Proves the spine: RFP → proposal → select → board → tasks → completion → project done.

1. (U) `POST /projects` with an `rfp`. Assert `phase=soliciting`.
2. (A:Percy) `GET /projects?phase=soliciting&updated_since=...` and find the new project
   (validates poll + `updated_since`).
3. (A:Percy) `POST /projects/{id}/proposals` with canned `content`. Assert proposal created
   with its own `conversation_id`.
4. (U) `POST /projects/{id}/select` with the proposal id. Assert `selected_proposal_id` set,
   `phase` still `soliciting` (per the select/instantiate split).
5. (A:Percy) `POST /projects/{id}/board` with a minimal schema (§6.1). Assert `Board` created
   at `version=1`, project `board_id` set, `phase=board_active`.
6. (A:Percy) `POST /boards/{id}/tasks` creating one task assigned to a coder agent, status
   `inactive`.
7. (A:Ricky) poll tasks filtered by assignee, claim it: `PATCH` to `active`, post a canned
   "done" entry, `PATCH` to `complete`.
8. (U) `POST /projects/{id}/complete`. Assert `phase=done`.
9. Assert the project-done notification exists (§4.7 covers notifications in depth; here just
   confirm the terminal one fired).

### 4.2 `approval_gate` — the Percy/user-assignment pattern

Proves that approvals, drafts, and dependencies are all one mechanism, with **no special
fields**.

1. (U) create project, (A:Percy) propose, (U) select, (A:Percy) instantiate board.
2. (A:Percy) `POST` a `planning` task assigned to **Percy**, status `inactive`.
3. (A:Percy) `POST` two downstream "work" tasks, each `depends_on: [planning_task_id]`. These
   are the "draft" tasks — assert they are ordinary tasks with a dependency, **not** a special
   draft type.
4. (A:Percy) do the "planning" (post a canned entry), then **reassign the planning task to the
   user** (`PATCH assignee → user`). Assert this fires a task-assigned-to-user notification
   (§4.7).
5. (U) simulate "changes requested": post a comment entry, `PATCH assignee → Percy` (do NOT
   complete). Assert reassignment recorded.
6. (A:Percy) address it (canned entry), reassign to user again. Assert another notification.
7. (U) approve: `PATCH` planning task `status → complete`.
8. (A:Ricky) confirm the downstream tasks' dependencies are now satisfiable (the *server does
   not enforce this* — the team observes it). Claim and complete them.
9. Assert: at no point did the server require an `is_draft` or `requires_approval` field; the
   entire gate was expressed via `depends_on` + assignment + status.

### 4.3 `coder_tester_loop` — assignment toggling & role-respect-by-convention

Proves the coder/tester handoff, the changes-requested loop, and that **role permissions are
NOT server-enforced**.

1. Set up a board whose schema declares Ricky(`coding`) and Tania(`testing`), with a
   *descriptive* dynamic "approval of `coding` tasks requires `testing` capability" (§6.1).
2. (A:Percy) create a coding task assigned to Ricky.
3. (A:Ricky) `active` → canned "implemented" entry → `PATCH assignee → Tania` (handoff).
4. (A:Tania) first pass: deterministically "reject" — post a canned entry referencing a
   (fake) screenshot attachment id in `resources`, then `PATCH assignee → Ricky`. Use a seeded
   rule so the first round always rejects and the second always passes (exercises the loop
   without unbounded iteration).
5. (A:Ricky) "fix" (canned entry), `PATCH assignee → Tania`.
6. (A:Tania) second pass: "approve" — `PATCH status → complete`.
7. **Role-respect check:** separately, (A:Ricky) attempt to mark a *coding* task `complete`
   himself (which the schema's dynamics say only `testing` capability should do). Assert the
   **server accepts it anyway** — confirming the server enforces no role rules. The "only
   testers approve" rule is the team's responsibility, demonstrated by the team *choosing* to
   route through Tania in the normal flow.

### 4.4 `schema_versioning` — mutable, versioned board schema

Proves schema mutation and version retention.

1. Stand up a board (schema version 1) with roster {Ricky, Tania}.
2. (A:Percy) `PUT /boards/{id}/schema` adding a new agent (e.g. "Tomás the Tester #2") and a
   new entry to the `statuses` list. Assert version increments to 2 and becomes active.
3. `GET /boards/{id}/schema?version=1` and `?version=2`; assert **both retrievable** and
   distinct.
4. Create a task assigned to the new agent introduced in v2; assert it works (tasks reference
   the *current* schema, not a pinned version).
5. Assert a task created under v1 is still valid and renders (no server-side binding to schema
   version).

### 4.5 `attachments` — opaque blob round-trip

Proves attachment upload/download and the RFP-vs-entry owner cases.

1. (U) `POST /projects` and attach an audio blob to the **RFP** (`owner_kind=rfp`). Use a tiny
   fixture file (e.g. a few-KB WAV/PNG). Assert metadata row, `byte_size`, `content_type`.
2. Round-trip: `GET /attachments/{id}/content` (follow the 302 to presigned URL if applicable)
   and assert bytes match the fixture.
3. (A:Tania) in a task conversation, post an entry and attach a fixture screenshot
   (`owner_kind=entry`). Reference its id from another agent's later entry body (the "see
   screenshot X" pattern). Assert retrievable.
4. **Limits check:** attempt an over-limit upload (exceed the configured size cap) and an
   disallowed content type; assert the server rejects *these* (the only validation it does on
   content, per server spec §7.2) while accepting valid ones.

### 4.6 `garbage_in` — proving the server is as dumb as designed

This is the adversarial scenario. A real team would never do these intentionally, so only the
reference team can catch an over-eager server validation creeping in. Each step asserts the
server **placidly accepts** the garbage.

1. **Status not in own schema:** write task `resources` rich-status to a string absent from the
   board schema's `statuses` list. Assert accepted (server doesn't validate `resources`
   against schema).
2. **Dependency violation:** create task B `depends_on: [A]` while A is `inactive`, then
   `PATCH` B straight to `active`. Assert the server **allows** it (dependencies unenforced).
3. **Self/reassign mid-flight:** `PATCH` a task that is `active` to a new assignee. Assert
   accepted (the `active` status is a *caution signal*, not a lock).
4. **Opaque `resources` blob:** stuff arbitrary nested JSON into `resources`; round-trip and
   assert byte-for-byte fidelity.
5. **Unknown dependency target (referential integrity):** create a task `depends_on` a
   nonexistent task id. Assert the server **rejects** *this one* — confirming the single
   structural integrity check (edges must point at real same-board tasks) exists while no
   *semantic* checks do. (This is the one place the server is allowed to say no.)
6. **Author impersonation:** as agent Ricky, attempt to POST a conversation entry with a body-
   supplied `author_actor_id` of Tania. Assert the server ignores the body field and records
   the entry as authored by the credentialed actor (Ricky). Confirms auth derives author from
   the token, per server spec §4.

### 4.7 `notifications` — assignment- and phase-driven only

Proves exactly two triggers, and that they are assignment/phase-driven, not status-driven.

1. **Task → user:** reassign any task's `assignee` to the user. Assert exactly one notification
   row appears (`GET /notifications?unread=true`).
2. **No false positives on status:** change a task's `status` (e.g. `inactive`→`active`) while
   it stays assigned to an *agent*. Assert **no** notification fires (status changes alone
   don't notify).
3. **Project → done:** `POST /projects/{id}/complete`. Assert exactly one project-done
   notification.
4. **Read side:** `POST /notifications/{id}/read`; assert it leaves the unread set.
5. Assert no notification is generated for any other event in the suite (agent-to-agent
   handoffs, schema changes, attachment uploads, etc.).

### 4.8 `done_is_soft` — appending work after completion

Proves the `done` phase is non-terminal for task creation.

1. Take a project to `done` (reuse happy_path setup).
2. (U) or (A:Percy) `POST /boards/{id}/tasks` adding a new task to the completed board. Assert
   it is accepted and the project **stays** `done` (no phase change, no re-bidding).
3. Drive the new task to completion. Confirms "switching teams = new project" is the only thing
   `done` forbids, and continuation is free.

---

## 5. Coverage matrix (what must be touched)

The suite as a whole MUST exercise, at minimum:

**Endpoints** (server spec §5): every one of `POST/GET/PATCH /projects*`, `/proposals`,
`/select`, `/complete`, `/board`, `GET/PUT .../schema`, `POST/GET/PATCH /tasks*`,
`/conversations/{id}/entries` (GET+POST), `/attachments` (POST/GET/content), `/notifications`
(GET + read).

**Phases:** `soliciting → board_active → done`, plus task-append-after-done.

**Task statuses:** `inactive`, `active`, `complete`, including a mid-`active` reassignment.

**Actor kinds:** user and agent, with author-from-credential enforcement.

**Structural relation:** `depends_on` create, satisfy, violate (unenforced), and dangling-
reference rejection (the one enforced check).

**Notification triggers:** both (task→user, project→done) and explicit negative cases.

**Opacity guarantees:** `resources`, board `schema`, rich statuses, and `state_change_ref`
all round-trip verbatim and unvalidated.

A simple checklist in the suite's README mapping each item above to the scenario that covers it
is the acceptance artifact. If a row is uncovered, the suite is incomplete.

---

## 6. The minimal team fixtures

These are the only "team data" the reference team needs. Keep them tiny and inline.

### 6.1 Minimal board schema (the opaque blob submitted at instantiation)

```jsonc
{
  "agents": [
    { "id": "<percy_actor_id>", "display_name": "Percy", "title": "PM",
      "capabilities": ["planning"] },
    { "id": "<ricky_actor_id>", "display_name": "Ricky", "title": "Engineer",
      "capabilities": ["coding"] },
    { "id": "<tania_actor_id>", "display_name": "Tania", "title": "Tester",
      "capabilities": ["testing"] }
  ],
  "dynamics": [
    { "rule": "approval_of", "task_kind": "coding", "requires_capability": "testing" }
  ],
  "statuses": ["awaiting_review", "changes_requested", "blocked_on_capacity"]
}
```

Note: `task_kind` here is purely a convention the team carries in task `resources` (e.g.
`{"kind":"coding","rich_status":"awaiting_review"}`); the server has no `kind` field. The
reference team demonstrates the convention precisely *because* it's the kind of thing a real
team-builder needs to see modeled.

### 6.2 Canned outputs

- Coder "work product": a fixed string entry, e.g. `"stub: implemented feature per task."`
  Optionally writes a trivial file locally only if a scenario needs an attachment; otherwise
  no filesystem use at all.
- Tester verdicts: seeded rule — round 1 rejects, round 2 approves — so the loop is bounded and
  deterministic. (Iteration bounds themselves are out of scope; this is just to make the loop
  terminate predictably in a test.)
- Fixtures: one tiny audio file and one tiny PNG checked into the repo for the attachments
  scenario.

### 6.3 Determinism requirements

- Any "randomness" (e.g. tester verdict) uses a fixed seed or a plain counter. Same run →
  identical sequence of API calls and identical assertions.
- No wall-clock dependence beyond `updated_since` polling, which uses server-returned
  timestamps rather than the client's clock.

---

## 7. Explicit non-goals

- **No real work, no LLM calls, no model selection, no capacity scheduling.** All deferred to
  the real team.
- **No iteration-bound / retry-budget / escalation logic** beyond the seeded "reject once then
  pass" needed to make a loop terminate.
- **No configurability or plugin architecture.** Flat scenarios only.
- **No UI.** It is headless; the SPA is tested separately.
- **No coverage of deploy/publish/outbound** flows (not in the server's v1 surface).

---

## 8. How this de-risks the real team (informative)

When the reference team is green, you have a **known-good protocol substrate**: every endpoint
works, every transition is reachable, the server's designed dumbness is verified, and the
polling/notification contracts behave. The real team can then be built focused entirely on the
hard, nondeterministic parts — model selection, prompting, capacity, genuine work — against a
comms layer it no longer has to debug. And because the reference team is the canonical worked
example, the real team's authors start from a correct, readable model of "how to talk to the
server" rather than from this spec alone.

---

## Appendix A — Scenario → coverage quick map

| Scenario | Headline proof |
|---|---|
| `happy_path` | Full lifecycle spine; poll + `updated_since`; select/instantiate split. |
| `approval_gate` | Drafts + approvals = `depends_on` + user-assignment; no special fields. |
| `coder_tester_loop` | Handoff via reassignment; changes-requested loop; role rules NOT enforced. |
| `schema_versioning` | Mutable, versioned schema; all versions retained; tasks track current. |
| `attachments` | Opaque blob round-trip; RFP-vs-entry owners; size/type limits (only content check). |
| `garbage_in` | Server accepts semantic garbage; rejects only dangling edges + impersonation. |
| `notifications` | Exactly two triggers (task→user, project→done); status changes don't notify. |
| `done_is_soft` | Tasks appendable after `done`; no phase change; no re-bidding. |
