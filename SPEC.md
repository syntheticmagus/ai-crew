# Orchestration Web Service — Technical Specification (v1)

> **What this is.** A specification for the *communication backbone* of an asynchronous
> AI-team orchestration system. This document specifies **only the web service** (the
> "comms protocol"): the API, data model, auth, and storage. It deliberately specifies
> **nothing** about the AI teams, agents, workflows, capacity management, or task
> correctness — those live entirely outside this service and are free to evolve
> independently.
>
> **Audience.** This is written to be handed to Claude Code (or a developer) as the
> source of truth for an initial implementation.

---

## 1. Philosophy and non-negotiable principles

These principles are *load-bearing*. When an implementation decision is ambiguous,
resolve it by returning to these.

1. **The server is a referee of nothing.** It stores what it is told and serves it
   back. It does **not** validate, interpret, or enforce any domain semantics. Garbage
   in is the originating client's problem, not the server's.

2. **Domain semantics live in client-supplied data, never in the protocol.** There is
   no role enum, no status taxonomy beyond the bare minimum the UI needs to render, no
   notion of "coder" vs "writer." All of that lives inside a team-supplied **board
   schema** blob that the server stores and serves but never reasons about.

3. **The conversation is the immutable audit log.** State-affecting actions should be
   accompanied by conversation entries. Mutable fields on resources are denormalized
   views of "latest state"; the conversation is the history of how it got there.

4. **Asynchrony is the point.** Nothing assumes any actor (human or agent) is available
   now. Work waits. Waiting is correct behavior, not a failure mode. The protocol is
   built for polling, not realtime.

5. **The degenerate single-team case must feel frictionless.** The general mechanism is
   solicit → propose → select → board. But the common case (one trusted local team) must
   collapse to near "describe work → board exists." Do not add ceremony that punishes the
   solo-team case.

### What is deliberately NOT in scope

- AI teams, agents' internals, model selection, capacity/scheduling — **all client-side.**
- Task correctness, role permissions enforcement, transition validation — **not enforced.**
- Iteration bounds, retry budgets, escalation/failure handling — **client-side workflow concerns.**
- Deploy/publish/outbound actions — **future, and security-gated separately.** Out of scope here.

---

## 2. Conceptual model

### 2.1 Lifecycle

A **project** moves through phases **linearly**:

```
soliciting  ──▶  board_active  ──▶  done
```

- **soliciting** — The project is an open RFP. The user has described work they want.
  AI teams self-select and post **proposals**. Each proposal carries its own conversation
  for independent negotiation. The user may negotiate with several teams in parallel and
  ultimately selects **at most one** proposal.
- **board_active** — The selected team has submitted a **board schema**, instantiating
  the task board. Work happens here. The board is bound to exactly **one** team for life.
- **done** — Soft/terminal. The user can always append tasks (which continues work
  without changing phase ownership). There is **no re-bidding**: switching teams means
  starting a *new* project that builds on prior output.

> **Single-team fast path.** A trusted standing team can auto-propose the instant an RFP
> appears, collapsing `soliciting` to near-zero so the user effectively goes "describe
> work → board exists." This is a *client behavior*, not a protocol special case — the
> protocol just makes proposals cheap to post and select.

### 2.2 Why there are no roles

Roles (coder/tester/architect vs plotter/writer/editor/illustrator) have near-zero
overlap across domains. Hardcoding any role vocabulary would silently restrict the
system to one production axis. Therefore **roles do not exist in the core**. Instead:

- A team's board schema declares a **roster of personified agents** (e.g. "Ricky the
  Engineer," "Tania the Tester").
- Each agent carries one or more **capability tags**.
- Any **declared dynamics** (rules the *client* should render, e.g. "approval of a
  coding task should go to someone with the `testing` capability") reference **capability
  tags**, not agent names — so rules stay robust as the roster grows.
- Personification operates at the *interaction* layer (assignment, conversation);
  capabilities operate at the *rules* layer.

The server stores all of this as opaque descriptive payload. It serves it to the client
for rendering and manual manipulation. **It never enforces any of it.**

### 2.3 Approvals, drafts, and dependencies — all one mechanism

There is **no `is_draft` flag and no `requires_approval` flag.** Both concepts dissolve
into two primitives the protocol already has: **task dependencies** and
**assignment to the user**.

- A "draft task" is just a task that **depends on** an as-yet-incomplete task.
- An "approval gate" is just a task **assigned to the user** that other tasks **depend
  on**.

**Worked example (the "Percy the PM" flow).** A team wants the user to approve a work
plan before coding starts:

1. Percy creates a single `planning` task, assigned to himself.
2. Percy creates all the downstream work tasks, each with `depends_on` pointing at the
   planning task (directly or transitively). None can start until planning is `complete`.
3. Percy completes his planning work, then **reassigns the planning task to the user**
   (this triggers a notification — see §6).
4. The user reviews. If unhappy, they comment in the task conversation and reassign back
   to Percy. If happy, they mark the planning task `complete`.
5. With the gate task `complete`, the team's workflow manager sees the downstream
   dependencies satisfied and proceeds.

The "always approve the spec" gate and the "I asked to review the plan" gate are the
**same construct** — a user-assigned task in the DAG. The only difference is who created
it and why. The server does not know or care.

### 2.4 Decomposition is provenance, not structure

"This task came from breaking down that one" is a *narrative/audit* fact, not an
execution-governing relation. It belongs in the **conversation** ("I've decomposed this
into X, Y, Z"), not in a structural field. The only structural relation between tasks is
`depends_on` (a blocking edge). There is intentionally **no `parent_id`**.

---

## 3. Data model

All IDs are UUIDs (v4). All timestamps are UTC, ISO-8601, stored with millisecond
precision. Every resource has `created_at` and `updated_at`; `updated_at` MUST advance on
every mutation (this powers incremental polling — see §5.4).

> **Server-controlled vs opaque.** For each resource below, fields are marked:
> - **[core]** — the server reads/writes/relies on this field. It has protocol meaning.
> - **[opaque]** — the server stores and serves it verbatim and assigns it no meaning.

### 3.1 Project

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `phase` | core | enum | `soliciting` \| `board_active` \| `done` |
| `rfp` | core | text | The user's static description of desired work. Has attachments (§3.6). **No conversation.** |
| `selected_proposal_id` | core | UUID? | `null` until a proposal is selected. |
| `board_id` | core | UUID? | `null` until the board is instantiated. |
| `created_at` / `updated_at` | core | timestamp | |

Notes:
- A project's RFP has **no conversation of its own**; negotiation happens per-proposal
  (§3.2), so that competing teams can be corrected independently and comparably.
- Phase transitions are server-mediated via dedicated endpoints (§5.2), not free-form
  `PATCH`es, because they have invariants (e.g. selecting a proposal requires the project
  be `soliciting`).

### 3.2 Proposal

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `project_id` | core | UUID | Parent RFP. |
| `author_agent_id` | core | UUID | The agent/team that bid. |
| `content` | opaque | text | Human-readable pitch — what they'd do and how. |
| `conversation_id` | core | UUID | This proposal's own negotiation thread (§3.5). |
| `created_at` / `updated_at` | core | timestamp | |

Notes:
- A proposal carries **no board schema** and makes **no structural commitment**. The
  schema is submitted only by the winner, only at board instantiation (§3.4). This keeps
  the RFP phase lightweight and purely human-evaluated.
- Many proposals per project; at most one is selected.

### 3.3 Board

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `project_id` | core | UUID | One-to-one with the project once instantiated. |
| `team_agent_id` | core | UUID | The owning team/agent. Bound for life. |
| `active_schema_version` | core | int | Points at the current schema version (§3.4). |
| `created_at` / `updated_at` | core | timestamp | |

A board is created by the **selected team** submitting a board schema (§5.3). It owns the
tasks (§3.7).

### 3.4 BoardSchema (mutable, versioned)

Stored as **opaque JSON** the server never interprets. The server keeps **all versions**;
the board's `active_schema_version` selects the current one. Tasks implicitly reference
"whatever the current schema is" — the server does not bind tasks to schema versions.

| field | kind | type | notes |
|---|---|---|---|
| `board_id` | core | UUID | |
| `version` | core | int | Monotonic, starts at 1. |
| `schema` | opaque | JSON | The entire team-supplied descriptor (below). |
| `created_at` | core | timestamp | |

**Suggested (non-enforced) shape of the opaque `schema` JSON** — this is a *convention*
the client and teams agree on; the server treats it as a blob:

```jsonc
{
  "agents": [
    {
      "id": "uuid",                 // matches an Actor of kind=agent (§3.8)
      "display_name": "Ricky",
      "title": "Engineer",          // for "Ricky, the Engineer" rendering
      "capabilities": ["coding", "architecture"]
    },
    {
      "id": "uuid",
      "display_name": "Tania",
      "title": "Tester",
      "capabilities": ["testing"]
    }
  ],
  "dynamics": [
    // descriptive only — rendered by the client, never enforced by the server
    { "rule": "approval_of",
      "task_kind": "coding",
      "requires_capability": "testing" }
  ],
  "statuses": [
    // the team's RICH status vocabulary, for client rendering.
    // NOTE: this is distinct from the task's core 3-value `status` (§3.7).
    "awaiting_review", "changes_requested", "blocked_on_capacity"
  ]
}
```

> **Versioning UX consequence.** Because the schema is mutable and tasks reference the
> current version, a client viewing a board must fetch the active schema to render
> agents/statuses correctly, and should re-fetch when `active_schema_version` changes. No
> team is expected to use mutation in the near term, but the protocol supports it.

### 3.5 Conversation

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `parent_kind` | core | enum | `proposal` \| `task` |
| `parent_id` | core | UUID | The proposal or task this thread belongs to. |
| `created_at` / `updated_at` | core | timestamp | |

A conversation is an ordered, **append-mostly** log of entries (§3.6). Conversations
attach to **proposals** (RFP negotiation) and **tasks** (the embedded chat where agents
talk to the user and to each other). Projects do **not** have conversations.

### 3.6 ConversationEntry

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `conversation_id` | core | UUID | |
| `author_actor_id` | core | UUID | A user or agent (§3.8); authenticated. |
| `body` | opaque | text | Free text. Markdown by convention; server doesn't care. |
| `attachments` | core (relation) | Attachment[] | Zero or more (§3.7). |
| `state_change_ref` | opaque | JSON? | Optional. A note that this entry accompanied a state change, so the log reads coherently (e.g. `{"reassigned_to":"<actor>","status":"complete"}`). Server stores verbatim. |
| `created_at` | core | timestamp | Entries are ordered by this. |

Entries are **immutable once created** (no edit/delete in v1; corrections are new
entries). This keeps the audit log trustworthy.

### 3.7 Task

The minimal core. Everything domain-specific is pushed out to the conversation,
attachments, or the board schema.

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `board_id` | core | UUID | Owning board. |
| `assignee_actor_id` | core | UUID | A user or agent (§3.8). **Assignment drives notifications** (§6). |
| `status` | core | enum | `inactive` \| `active` \| `complete`. **This is the entire server-visible status vocabulary.** See note below. |
| `description` | opaque | text | What to display to the user about the task. |
| `depends_on` | core | UUID[] | Blocking edges to other tasks **on the same board**. Stored & served, **never enforced**. The DAG the client renders and the team obeys. |
| `conversation_id` | core | UUID | The embedded chat (§3.5). |
| `resources` | opaque | JSON | Bag for opaque blobs / pointers the team needs (e.g. `{"screenshots":["<attachment_id>"]}`, rich status, iteration counts). Server stores verbatim. |
| `created_at` / `updated_at` | core | timestamp | |

> **Why only three statuses.** The full task state space is `status × assignee`. `status`
> exists *only* to communicate **cancellation-safety** — `active` warns the user that an
> agent is currently working the task, so mutating it is risky. "Waiting on the user" is
> simply `inactive` + `assignee = the user`. Any *richer* status the team wants (e.g.
> `awaiting_review`, `changes_requested`) lives in the board schema's `statuses` list and
> is carried in `resources`, interpreted by the client — never by the server.

> **Dependencies are cross-referenced but unenforced.** The server stores `depends_on`
> edges and serves them so the client can render "blocked by" relationships and let the
> user reorder/inspect. The server does **not** prevent a task from going `active` while
> its dependencies are incomplete — that's the team's job. Edges must reference tasks on
> the same board; the server may reject edges to unknown task IDs purely as a referential
> integrity check (this is structural, not semantic).

### 3.8 Attachment

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `entry_id` | core | UUID | The conversation entry it hangs off (or the project RFP — see note). |
| `kind` | core | enum | `text` \| `audio` \| `file` (broad; informational, not validated beyond size/type limits). |
| `filename` | opaque | text | Original name, for display. |
| `content_type` | core | text | MIME type. |
| `byte_size` | core | int | Enforced against limits (§7). |
| `storage_key` | core | text | Opaque pointer into the blob backend (§7). |
| `created_at` | core | timestamp | |

Notes:
- Content is **opaque** to the server within size/type limits. Audio dictation and
  screenshots are the motivating cases.
- The **project RFP** may also carry attachments. Model this either by giving the RFP a
  dedicated (invisible) conversation-less attachment owner, or by allowing
  `Attachment.owner_kind ∈ {entry, rfp}` with `owner_id`. **Implementer's choice;**
  prefer a polymorphic owner (`owner_kind` + `owner_id`) for uniformity.

### 3.9 Actor

| field | kind | type | notes |
|---|---|---|---|
| `id` | core | UUID | |
| `kind` | core | enum | `user` \| `agent`. |
| `display_name` | opaque | text | For rendering ("Ricky", "You"). |
| `created_at` / `updated_at` | core | timestamp | |

- The server knows **that** an actor is a user or an agent. It does **not** know what any
  agent's role/capability *means* — those live in the board schema.
- **v1 assumption (overridable):** exactly **one** user actor (you), authenticated by
  session/login; **N** agent actors, each authenticated by a pre-provisioned bearer
  token. Agents do not self-register; the user provisions them. Multi-user and
  self-registration are out of scope for v1 but the `Actor` table doesn't preclude them.

---

## 4. Authentication & authorization

> **v1 assumption (flagged for override):** single human user + per-agent bearer tokens.

- **User auth.** Session-based login for the human user (the web/mobile client). A single
  user account in v1. Implement with a standard session cookie or signed JWT; keep it
  swappable.
- **Agent auth.** Each agent actor has one or more **API tokens** (opaque bearer strings,
  stored hashed). Workflow managers present `Authorization: Bearer <token>` on every
  request. A token maps to exactly one `agent` actor.
- **Authorization is intentionally thin.** Because the server enforces no domain rules,
  authz is coarse:
  - Any authenticated actor (user or agent) may read projects/boards/tasks/conversations
    they are party to. In v1's single-user world, "party to" is effectively "everything,"
    but write the checks so multi-tenant scoping can be added later.
  - Writing a conversation entry sets `author_actor_id` to the authenticated actor; the
    server MUST NOT let an actor impersonate another (i.e. `author_actor_id` is derived
    from the credential, not the request body).
  - The server does **not** enforce "only a tester may complete a coding task." If an
    agent has a valid token and the task exists, the mutation is accepted. Role-respect is
    the team's responsibility.

---

## 5. HTTP API

REST-ish, JSON over HTTPS. Polling-friendly. All list endpoints support
`?updated_since=<iso8601>` for incremental polling and standard `?limit=&cursor=`
pagination.

### 5.1 Conventions

- Content type `application/json` except attachment upload/download.
- Errors: standard HTTP codes + `{ "error": { "code": "...", "message": "..." } }`.
- Mutations bump `updated_at` on the affected resource (and, where relevant, its parent —
  e.g. a new task entry bumps the task's `updated_at` so pollers notice).
- Idempotency: support an `Idempotency-Key` header on POSTs that create resources, so a
  retrying poller doesn't double-create. (Recommended, not strictly required for v1.)

### 5.2 Projects & lifecycle

```
POST   /projects                      Create an RFP (phase=soliciting).
                                       body: { rfp: text }  → Project
GET    /projects?phase=&updated_since=&limit=&cursor=
                                       List/poll projects.
GET    /projects/{id}                 Full project (incl. proposals summary, board ref).
PATCH  /projects/{id}                 Edit rfp text while soliciting. (No phase changes here.)

POST   /projects/{id}/proposals       A team bids.
                                       body: { content: text }  → Proposal
                                       (author derived from agent credential)
GET    /projects/{id}/proposals?updated_since=
                                       List proposals for a project.

POST   /projects/{id}/select          User selects a proposal.
                                       body: { proposal_id }
                                       Pre: phase=soliciting. Post: sets
                                       selected_proposal_id. Does NOT yet create the board.
                                       (Phase stays soliciting until the team submits a
                                       schema — see /board below. Rationale: selection is
                                       the human's act; instantiation is the team's act,
                                       and they're asynchronous.)

POST   /projects/{id}/complete        Mark project done (phase=done). Fires project-done
                                       notification (§6). Soft: tasks may still be added.
```

> **Selection vs instantiation.** `select` records the human's choice; the **board is
> created by the winning team** via `POST /projects/{id}/board` (next section), which is
> what flips the phase to `board_active`. This two-step keeps the human act and the team
> act decoupled and asynchronous, consistent with the negotiation model (schema is only
> submitted *after* selection).

### 5.3 Board & schema

```
POST   /projects/{id}/board           Selected team instantiates the board.
                                       Pre: phase=soliciting AND selected_proposal_id set
                                            AND caller is the selected team's agent.
                                       body: { schema: <opaque JSON> }
                                       Post: creates Board (version 1), sets project
                                            .board_id, flips phase → board_active.
                                       → Board (with active schema)

GET    /boards/{id}                    Board + active schema.
GET    /boards/{id}/schema?version=    Fetch a specific (or active) schema version.
PUT    /boards/{id}/schema             Submit a new schema version (version auto-increments,
                                       becomes active). body: { schema: <opaque JSON> }
                                       Server keeps all prior versions.
```

### 5.4 Tasks

```
POST   /boards/{id}/tasks             Create a task.
                                       body: {
                                         assignee_actor_id,
                                         status?         // default "inactive"
                                         description,
                                         depends_on?,    // UUID[] of same-board tasks
                                         resources?      // opaque JSON
                                       } → Task
                                       (also creates the task's conversation)

GET    /boards/{id}/tasks?updated_since=&assignee=&status=&limit=&cursor=
                                       THE workflow-manager poll. Filterable by assignee
                                       (so a manager fetches "tasks assigned to my agents")
                                       and status. updated_since for incremental polling.

GET    /tasks/{id}                     Full task (incl. depends_on, resources, conversation
                                       ref).
PATCH  /tasks/{id}                     Update assignee_actor_id, status, description,
                                       depends_on, resources (any subset). Bumps
                                       updated_at. A change of assignee to the user fires a
                                       notification (§6).
```

> There is no separate "create draft task" or "promote draft" endpoint. A draft is just a
> task with `depends_on` pointing at an incomplete task (§2.3).

### 5.5 Conversations & entries

```
GET    /conversations/{id}/entries?updated_since=&limit=&cursor=
                                       Ordered entries (oldest→newest). Client polls this
                                       while a task/proposal view is open.
POST   /conversations/{id}/entries     Post an entry.
                                       body: { body: text, state_change_ref?: JSON }
                                       author derived from credential.
                                       Attachments are added via §5.6 referencing the
                                       returned entry id (or accept multipart — impl choice).
```

(Conversations are created implicitly with their parent proposal/task; there is no
standalone "create conversation" endpoint in v1.)

### 5.6 Attachments

```
POST   /attachments                    Upload. Multipart or presigned-URL flow (see §7).
                                       Associates with an owner: { owner_kind, owner_id }
                                       where owner_kind ∈ {entry, rfp}.
                                       Enforces size/type limits.  → Attachment (metadata)
GET    /attachments/{id}               Metadata.
GET    /attachments/{id}/content       Stream/download bytes (or 302 to a presigned URL).
```

### 5.7 Notifications (read side)

```
GET    /notifications?unread=&updated_since=   List notifications for the current user.
POST   /notifications/{id}/read                Mark read.
```

Push delivery (web push / mobile push) is a transport detail (§6); these endpoints are
the durable in-app record.

---

## 6. Notifications

The server owns notifications because the triggering events are **server-visible**.
Exactly two events fire a notification to the **user** in v1:

1. **Task assigned to the user.** When a `PATCH /tasks/{id}` (or task creation) sets
   `assignee_actor_id` to the user actor, fire a notification. This is the universal
   "something needs you" signal — approvals, clarifications, and changes-requested all
   reduce to "now assigned to you."
2. **Project completed.** When `POST /projects/{id}/complete` sets `phase=done`, fire a
   notification. This is the "whole engagement finished" signal.

Notifications are **assignment/phase-driven, not status-driven** — the server cannot and
need not distinguish *why* a task is assigned to the user (the conversation and the
team's rich status in `resources` carry that). Richer notification semantics are a
client/team concern layered on top.

Delivery: persist a `Notification` row (so there's an in-app list, §5.7) and, if push is
configured, emit a web/mobile push. Push config is out of scope to specify in detail;
leave a clean seam.

---

## 7. Storage

### 7.1 Relational (Postgres)

All resources in §3 except attachment **content**. Suggested specifics:

- UUID primary keys (`gen_random_uuid()` via `pgcrypto`).
- `phase`, `status`, `kind`, `parent_kind`, `owner_kind`, `actor.kind` as Postgres enums
  or `text` with check constraints (enum preferred).
- `resources`, board `schema`, `state_change_ref` as `jsonb`.
- `depends_on` as `uuid[]` (or a join table `task_dependency(task_id, depends_on_id)` —
  **prefer the join table** for referential integrity and easier "what depends on X"
  queries).
- Index `updated_at` on every pollable table; composite indexes on
  `(board_id, assignee_actor_id, status)` for the task poll and
  `(conversation_id, created_at)` for entry reads.
- Board schema versions in their own table `board_schema(board_id, version, schema,
  created_at)`, with `board.active_schema_version` referencing the latest.

### 7.2 Blob (attachment content)

> **v1 assumption (flagged for override):** external object storage (S3-compatible),
> because **Heroku's dyno filesystem is ephemeral** — anything written to local disk is
> lost on restart/deploy. Postgres holds only attachment **metadata** + `storage_key`.

- Default backend: **S3-compatible** (AWS S3, or any S3 API). Prefer **presigned-URL**
  upload/download so bytes don't transit the dyno: client `POST /attachments` to get a
  presigned PUT URL + metadata row, uploads directly, then content is fetched via
  presigned GET (the `GET /attachments/{id}/content` endpoint 302-redirects to it).
- **Write the storage layer behind an interface** (`putObject`, `getObject`,
  `presignPut`, `presignGet`, `delete`) so the backend is swappable.
- *Lighter alternative for earliest bring-up:* store small blobs as `bytea` in Postgres.
  Acceptable for tiny dictation clips/screenshots, ugly at scale — keep it behind the
  same interface so switching to S3 is a config change.
- Enforce per-file size limits (suggest: 25 MB default, configurable) and an allowlist of
  content types (audio, images, common docs/text) — this is the *only* "validation" the
  server does on attachment content, and it's a safety/limits check, not a semantic one.

---

## 8. Tech stack & deployment

> Per the requester: **Node.js + Vite**, **Heroku** deploy, **Postgres** backing.

### 8.1 Shape

- **Backend:** Node.js HTTP API (Express or Fastify — **Fastify** suggested for schema-based
  validation and speed; either is fine). TypeScript strongly recommended for the data
  model's sake.
- **Frontend:** Vite-built SPA (React suggested, but unconstrained). Talks to the API.
  The client is a polling client (§9). Browser audio recording via `MediaRecorder` for
  dictation; mobile web supports this.
- **Single app or two?** Either deploy the API and serve the built Vite assets from the
  same Node process (simplest on Heroku — one dyno, API + static), or split into two
  Heroku apps. **Prefer single-process for v1.**

### 8.2 Heroku specifics

- **Postgres:** Heroku Postgres add-on; read `DATABASE_URL` from env.
- **Ephemeral FS:** do **not** persist anything to local disk (see §7.2). This is the
  single most important Heroku gotcha for this app.
- **Migrations:** use a migration tool (e.g. `node-pg-migrate` or Prisma Migrate) run via
  a release-phase command in the `Procfile`.
- **Procfile:** `web: node dist/server.js` (plus `release: <migrate cmd>`).
- **Config:** all secrets (DB URL, S3 creds, session secret, push keys) via Heroku config
  vars / env — never committed.
- **HTTPS:** terminated by Heroku's router; ensure secure cookies + trust proxy.

### 8.3 Suggested module layout

```
/server
  /src
    /db            migrations, connection, query helpers
    /domain        resource types (Project, Proposal, Board, Task, ...)
    /routes        one module per resource group (§5)
    /auth          session (user) + bearer (agent) middleware
    /storage       blob interface + s3 impl + bytea fallback impl
    /notify        notification persistence + push seam
    server.ts      app wiring, static-asset serving
/client            Vite SPA
  /src
    /api           typed fetch client + polling hooks (updated_since)
    /views         RFP list, RFP detail (proposals+negotiation), board, task detail
    /components    conversation thread, audio recorder, dependency/blocked indicators
```

---

## 9. Client behavior notes (informative, not protocol)

These are guidance for the SPA so it matches the design intent; they are **not** server
requirements.

- **Polling, with a realtime seam.** While a view is open, the client polls the relevant
  `?updated_since=` endpoint (task list, entries) on a short interval (e.g. 5–15s). Design
  the API client so SSE/WebSocket push can be slotted in later without changing call
  sites. Workflow managers (server-side, off-device) poll on their own cadence
  (e.g. 60s) — that's their concern, not the SPA's.
- **Rendering the board.** Fetch the board's active schema; render agents as personified
  ("Ricky, the Engineer"), map the team's rich `statuses` (from `resources`) for display,
  and render `depends_on` as "blocked by" indicators. A full graph UI is *not* expected on
  mobile; a list with blocked/dependency badges is fine.
- **Approval/clarification UX.** A task assigned to the user with status `inactive` is "your
  turn." The user comments in the conversation and either reassigns (back to an agent) or
  marks `complete`. There is no special approval widget — it's just assignment + status +
  conversation.
- **Audio dictation.** RFP creation and task conversations should support recording audio
  in-page and attaching it; this is the motivating low-friction input path.

---

## 10. Open items deferred past v1 (recorded, not specified)

- Tester subtypes / multiple capabilities per task — entirely team-side; protocol already
  supports it via capability tags.
- Iteration bounds / retry budgets / escalation on non-convergence — team-side.
- Deploy/publish/outbound actions from the work VM — **future, security-gated separately**
  (outbound trust is a different threat model than the pull-only model here).
- Inline commenting on documents (vs conversation replies) — later UI feature.
- Multi-user / team accounts / self-registration of agents — `Actor` model doesn't
  preclude it; not built in v1.
- Realtime transport (SSE/WebSocket) — seam left; polling first.

---

## Appendix A — Quick reference: the entire core vocabulary

The server understands **only** this much domain-wise. Everything else is opaque.

- **Project phases:** `soliciting`, `board_active`, `done`
- **Task status:** `inactive`, `active`, `complete` (cancellation-safety signal only)
- **Actor kinds:** `user`, `agent`
- **The one structural task relation:** `depends_on` (blocking, unenforced)
- **The two notification triggers:** task→user assignment; project→done
- **Everything else** (roles, rich statuses, workflow dynamics, correctness, capacity):
  client/team-supplied, opaque to the server.
