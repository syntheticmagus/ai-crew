# Software Development Team — Technical Specification (v1)

> **What this is.** A specification for the first **real** AI team: a software-development
> team that operates against the orchestration web service. It is the long-running process
> that runs at the user's premises (e.g. on a local inference box), polls the server, bids on
> software projects, and — when selected — does genuine end-to-end development inside a
> sealed VM.
>
> **Relationship to the other specs.** This assumes the server (`SPEC.md`) and follows the
> client contract proven by the reference team (`REFERENCE_TEAM_SPEC.md`). Where this
> document and `SPEC.md` disagree about server behavior, `SPEC.md` wins. This document is
> authoritative for how the software-dev team behaves.
>
> **Why software development first.** It is the natural first target (self-hosting feedback
> loops; well-defined inputs and outputs), and an effective software team can later be used
> to help build *other* teams. The conventions here are intended to also serve as the model
> for future team-builders.

---

## 1. Design through-line (read this first)

The same principle that governs the server governs this team, recursively: **mechanism
stays dumb; intelligence lives in the data.**

- The **server** refs nothing; intelligence lives in the team.
- The team's **framework** (scheduler) understands nothing about software, roles, or
  stages; it reads only the server's core vocabulary (`depends_on`, `assignee`, `status`)
  and wakes whoever is assigned to whatever is runnable, **subject to capacity.**
- The intelligence lives one layer further in, in the **agents** — and even there, the
  *harness* is uniform and dumb; the per-role *prompt* carries the behavior.

When an implementation decision is ambiguous, push intelligence outward to the agent and
keep the layer you're implementing as mechanical as possible.

Two hard constraints frame everything:

1. **In-VM only.** Nothing this team produces is ever deployed or sent outside the VM in
   v1. The Tester builds and runs everything on localhost / headless inside the VM. This is
   a security boundary (pull-only threat model) and it also bounds the blast radius of the
   uniform tool surface (§7). It will be relaxed later, deliberately and separately.
2. **One active editing agent per codebase.** No intra-project concurrency. Serial writers,
   no per-task branches running in parallel, no merge/integration step beyond the git
   discipline in §8.

---

## 2. The team as a long-running process

The team is one long-running process with a small number of states. It never assumes any
actor (agent or user) is available now; waiting is correct.

```
                ┌─────────────────────────────────────────────┐
                │                  IDLE                         │
                │  poll server for new projects (modest interval)│
                └───────────────┬───────────────────────────────┘
                                │ new project appears
                                ▼
                ┌─────────────────────────────────────────────┐
                │                BIDDING                        │
                │  Architect assesses fit; if software, posts a │
                │  proposal; revises on comment; drops on reject│
                └───────────────┬───────────────────────────────┘
                                │ proposal accepted → board created
                                ▼
                ┌─────────────────────────────────────────────┐
                │                WORKING                        │
                │  scheduler (§5) drives the work loop (§6)     │
                │  over the board until parity with proposal    │
                └───────────────┬───────────────────────────────┘
                                │ final Stage reaches proposal parity
                                ▼
                          project complete
```

The process is effectively always running the scheduler (§5); IDLE/BIDDING are just the
scheduler finding that the only useful work is "watch for projects" or "let the Architect
bid."

---

## 3. The roster

Six roles. Each is a *personified agent* (per the board schema convention) with a
capability tag and a launch prompt that defines its behavior. The framework knows only the
names/assignments; the behaviors below are realized in prompts and are expected to be
**tuned empirically** rather than frozen by this spec.

| Role | Capability | Phase | Authority |
|---|---|---|---|
| **Architect** | `architecture` | Bidding | Owns the **proposal** (the contract with the user). Assesses project fit, writes and revises the proposal, revises it later if the user routes a revision back. |
| **Executive** | `planning` | Working | Owns **progress toward** the proposal. Chooses each **Stage** and writes its **Stage Spec**. Decides, when the board empties, whether the project is done or another Stage is needed. May file a proposal-revision task to the user. |
| **PM** | `planning` | Working | Decomposes a Stage Spec into **Tasks**; owns the board's task structure for a Stage. Revises Tasks on escalation or joint appeal. |
| **Developer** | `coding` | Working | Implements Tasks (with unit tests). The single active editor. |
| **Reviewer** | `review` | Working | Reviews implemented Tasks; approves+closes or returns for changes; performs the squash-merge on approval. |
| **Tester** | `testing` | Working | Builds and runs a completed Stage in-VM; files bug Tasks or writes the **Stage Report**. May cut a release branch. |

**Separation of powers (Architect vs Executive).** The Architect owns the *contract*; the
Executive owns *progress toward* it. The Executive cannot change the contract. When the
Executive learns something that should change the proposal, it must route through the user
to the Architect (§6.7). State this boundary explicitly in both prompts.

> Multiple agents per capability are *permitted* by the schema (e.g. a second Tester) but
> not used in v1. One active editor per codebase (§1) is the binding constraint regardless.

---

## 4. The Stage: the keystone mechanism

### 4.1 Why stages exist

The most common failure of long-horizon AI development is planning a deep sequence whose
first real test is near the end — by which point too much has been built at once and
debugging is hallucination-prone. Stages make that structurally impossible.

A **Stage** is a "stepping stone" from what currently exists *toward* what the proposal
demands — **not** an attempt to get all the way at once. Every Stage MUST be:

- **Runnable and testable on the target platform** (in-VM), and
- a **noticeable progression** toward the intended functionality.

"Hello world" is a fine first Stage *if* it validates the implementation, build, and
deployment(-to-VM) infrastructure. Each Stage's functionality report becomes the grounding
for the Executive's next Stage choice, so planning always proceeds from observed reality.

### 4.2 A Stage is two bracketing Tasks plus what depends between them

A Stage is **not** a server object. It is represented entirely with ordinary Tasks and the
`depends_on` relation, navigated by the scheduler's dependency logic. For each Stage:

1. The **Executive** creates a **"plan the Stage" Task**, assigns it to the **PM**, and
   attaches the **Stage Spec**.
2. The **PM**, on that Task, decomposes the Stage Spec into **implementation Tasks**. Each
   implementation Task `depends_on` the "plan the Stage" Task (so they stay dormant until
   planning is done). The PM also creates a **"test the Stage" Task**, assigns it to the
   **Tester**, and makes it `depend_on` **all** implementation Tasks. The PM then closes
   the "plan the Stage" Task for itself.
3. Implementation proceeds (§6). As implementation Tasks complete, the "test the Stage"
   Task's dependencies are satisfied one by one.
4. When all implementation Tasks are complete, the "test the Stage" Task becomes runnable;
   the scheduler activates the Tester.
5. If the Tester files bug Tasks, it **MUST add each new bug Task as a dependency of its own
   "test the Stage" Task before (or as) it relinquishes that Task** — otherwise the
   scheduler will see the test Task as still-satisfiable and re-run it prematurely. This is
   the one ordering rule that makes the Stage "self-reblock" behind its bug fixes.
6. When the Tester is satisfied, it writes the **Stage Report** onto the "test the Stage"
   Task and closes it. The Stage is complete.

This reuses the exact draft-gating mechanism from the approval pattern: dependents stay
dormant behind a gate Task until the gatekeeper (here the PM, via the "plan the Stage"
Task) opens it. No new server concept; the board shows the Stage legibly to the user; the
framework navigates it with pure dependency readiness.

### 4.3 Artifacts

- **Proposal** — the Architect's contract with the user. Lives on the proposal (and its
  negotiation conversation), per the server model.
- **Stage Spec** — the Executive's technical description of one Stage. Attached to the
  "plan the Stage" Task.
- **Stage Report** — the Tester's assessment of the built Stage vs the Stage Spec. Attached
  to the "test the Stage" Task. Feeds the Executive's next Stage choice.
- **Stage Screenshots** — for web-app Stages, the Tester's Playwright-captured screenshots
  of every significant UI state exercised during the test run. Attached to the "test the
  Stage" Task alongside the Stage Report. Exist so the human (and the Executive) can see
  obvious visual brokenness without having to run the app themselves.

These are team-side artifacts carried as attachments / conversation content; the server
assigns them no meaning.

---

## 5. The scheduler (the framework)

The framework is a dependency-driven dispatcher that understands no domain semantics. It
reads only `depends_on`, `assignee`, and `status`, and runs three rules **subject to
capacity**:

1. **If a Task is `active` and its assigned agent is not awake** → wake that agent (if its
   compute is available) and set it on the Task.
2. **If there are no `active` Tasks** → find an `inactive` Task with no incomplete
   dependencies, switch it to `active`, and go to rule 1.
3. **If all Tasks on the board are `complete`** → wake the **Executive** to decide whether
   the project is done or another Stage is needed.

### 5.1 Subject to capacity, and the un-activatable actor

Every rule runs under one overriding behavior: **"If I can't activate the agent I'd need
right now, do something else useful if there is something else; otherwise wait and poll
again."** Inability to activate is a normal no-op outcome, not an error.

This subsumes two cases into one:

- The needed compute (a local inference box, the laptop, a commercial endpoint) is busy or
  offline → can't activate → find other useful work, else wait.
- The Task is assigned to the **user** → the user is, from the framework's perspective,
  simply an **un-activatable agent**. Can't activate → find other useful work, else wait.
  The server fires the notification (assignment-to-user); the framework just skips the Task
  in rules 1–2 until the user acts. The system does not deadlock because user-assigned Tasks
  are expected to be inert until the human acts.

### 5.2 Capacity & model selection (the environment JSON)

The framework makes **no assumption about where models run.** An **environment JSON**
enumerates available model endpoints; selection is a *policy over that JSON*, not a
structural layer.

Suggested environment entry shape (one per available model endpoint):

```jsonc
{
  "name": "local-A / qwen-coder-32b",
  "base_url": "http://YOUR_LLM_SERVER_IP:8000/v1",   // OpenAI-standard endpoint
  "api_key_env": "STRIX_A_KEY",            // resolved from env, never inline
  "token_cost": { "input": 0.0, "output": 0.0 },   // local ≈ free
  "role_suitability": ["coding", "review", "testing"],  // which roles this may serve
  "max_context": 32768,
  "notes": "big local model; one model loaded at a time on this box"
}
```

- "Wake the Reviewer" resolves to: among entries whose `role_suitability` includes
  `review` and which are **currently reachable**, pick one by the selection policy.
- **v1 selection policy:** "first suitable reachable entry." This is deliberately trivial.
- **Later** (no structural change): richer policy over the same fields — prefer cheap/local,
  escalate to commercial on urgency/complexity, exploit time-of-day discounts, etc. Because
  heterogeneity is just *which entry was picked*, growing the policy never touches the
  scheduler or the agents.

> The model abstraction is therefore "free": every endpoint is OpenAI-standard, so a local
> box, the laptop, and a commercial API are indistinguishable except by their JSON fields.

---

## 6. The work loop

Driven by the scheduler over the board. Steps map onto Stage structure (§4).

### 6.0 Bidding (pre-loop, the Architect)

1. In IDLE, the framework polls for new projects.
2. On a new project, the framework wakes the **Architect**, which assesses fit using its
   knowledge of the team's capabilities and costs.
3. **Not a software job / not a fit** → the team ignores this project (and, once a proposal
   is rejected, ignores it forever — see below).
4. **Fit** → the Architect posts a **technical proposal** (what the team will implement).
5. **Proposal commented** → the Architect reassesses and adjusts the proposal.
6. **Proposal rejected** → the team ignores this project permanently.
7. **Proposal accepted** → the framework instantiates the **board** (submitting the board
   schema, §9) and enters WORKING.

### 6.1 Executive chooses a Stage

The Executive examines the proposal and what currently exists (nothing, the first time),
assesses the gap, and posits the next **Stage** — runnable/testable in-VM, a noticeable
progression, not the whole thing. It writes the **Stage Spec** and creates the "plan the
Stage" Task (→ PM), per §4.2 step 1.

### 6.2 PM decomposes the Stage

The PM reads what currently exists and the Stage Spec, and creates the implementation Tasks
plus the "test the Stage" Task, wiring dependencies per §4.2 step 2, then closes the "plan
the Stage" Task.

### 6.3 Developer implements a Task

The Developer picks a runnable Task (the scheduler has set it `active`), implements it
**including unit tests**, running those tests as appropriate to validate as it goes. When
the Developer believes the Task is done, it commits (§8), writes implementation notes into
the Task conversation, and assigns the Task to the **Reviewer**.

If there are no runnable implementation Tasks, control proceeds to the Tester via the
scheduler (the "test the Stage" Task becomes runnable).

### 6.4 Reviewer reviews

The Reviewer, now assigned an implemented + unit-tested Task, checks the implementation
(running unit tests as appropriate) for code quality, mistakes, and deviation from the Task
or the Stage Spec. (Both Developer and Reviewer have access to both the Task and the Stage
Spec.)

- **Changes wanted** → comment specifics in the conversation, assign the Task back to the
  Developer (return to §6.3 with the Task already chosen).
- **Satisfied** → perform the squash-merge to main (§8), approve, and close the Task.

### 6.5 The objection / joint-appeal path (Developer ⇄ Reviewer → PM)

Either the Developer or the Reviewer may believe the PM made a mistake — that a Task should
not be part of the work toward the Stage Spec. They may route the Task back to the **PM**
for revision **only by joint appeal**:

1. An objecting agent posts an **unambiguous objection** in the Task conversation, stating
   *what* it objects to and *why*.
2. The other agent may reassign the Task to the PM **only if** it has seen that objection
   **and agrees with it, including with the nature (the why) of the objection.**
3. If they agree the Task is objectionable but **not on why**, they discuss further in the
   conversation until they reach consensus.
4. On reassigning to the PM, the reassigning agent's handoff entry MUST **reference/summarize
   the consensus** so the PM can recognize this as a legitimate joint appeal rather than one
   agent freelancing. (Same spirit as `state_change_ref`: the handoff carries its
   justification.)

### 6.6 Tester tests the Stage

When all implementation Tasks are complete, the "test the Stage" Task becomes runnable. The
Tester **builds and runs the Stage in-VM** (and as many unit tests as it deems appropriate)
to assess functionality against the Stage Spec.

**For web-app Stages, the Tester MUST capture and attach screenshots** using Playwright (or
equivalent headless browser). Specifically:

- Take a screenshot at every significant UI state exercised — each distinct page or view, each
  major interaction outcome (form submitted, modal opened, error displayed, etc.).
- Attach all screenshots to the "test the Stage" Task conversation **before** writing the
  Stage Report. This is not optional. A Playwright run that exercises flows without capturing
  screenshots defeats the purpose of the headless-browser step: the point is to make obvious
  visual brokenness (broken layout, missing content, unstyled elements, overlapping widgets)
  visible to the human and the Executive without them having to run the app. Functional
  assertions alone do not catch these.
- Reference the screenshots in the Stage Report by name/id so the human can correlate each
  screenshot with the narrative.

- **Bugs (won't build, crashes, etc.)** → create bug Tasks, assign them to the Developer,
  and (critically, §4.2 step 5) add each as a dependency of the "test the Stage" Task before
  relinquishing it. Return to §6.3.
- **No blocking bugs** → evaluate functionality vs the Stage Spec and write the **Stage
  Report** onto the "test the Stage" Task (with screenshots attached, per above), then close
  it. The Tester may also cut a **release branch** for the completed Stage (§8).

### 6.7 Executive re-evaluates (board empty)

When the board is all-complete (scheduler rule 3), the Executive wakes and, using the latest
Stage Report, decides:

- **Not yet at proposal parity** → choose the next Stage (return to §6.1).
- **At proposal parity** → the project is complete.

**Proposal revision pathway.** If at any point the Executive discovers information that
should revise the *proposal* (the contract), it cannot change the contract itself. It files
a **revision Task assigned to the user**. The user may:

- **Reject** the revision by closing the Task (work continues toward the existing proposal), or
- **Assign it to the Architect** (with commentary) to revise the proposal.

Iterate Stages until the final Stage brings parity with the (possibly revised) proposal.

---

## 7. Agent harness & tools

### 7.1 Harness

Each agent is an **agentic harness around an OpenAI-standard chat API**, with tools. A
"turn" is one activation of an agent on a Task: the harness loads context (§8.4), runs the
model with the tool loop until the agent yields (hands off, closes, escalates, or is cycled
out), and persists results.

### 7.2 Two tool groups

**Group (a) — standard agentic dev tools.** Filesystem read/write, shell, git, build/run,
web-for-reference. **Exposed uniformly to all roles**; usage is shaped by the role's launch
prompt, **not** by harness-level restriction in v1.

> Rationale: getting per-role tool limits right at the harness level is extremely fiddly and
> can only be learned by observing real usage (the Reviewer, e.g., genuinely needs to run the
> build to check tests). Start with full exposure governed by prompt verbiage; escalate to
> harness-level limits where and when it becomes clear how to do so productively. The in-VM
> boundary (§1) and the git discipline (§8) bound the blast radius: worst case is recoverable
> repo/VM damage, never outbound action.

**Group (b) — server-communication tools.** The team's *only* interface to the protocol.
These MUST map exactly onto the server's documented endpoints (`SPEC.md` §5). They are worth
specifying precisely even in v1, and are the natural future seam for any harness-level
limiting (which would apply to group (a), never (b)):

| Tool | Maps to | Used by |
|---|---|---|
| post proposal / revise proposal | `POST /projects/{id}/proposals` (+ entries) | Architect |
| create board (submit schema) | `POST /projects/{id}/board` | framework on acceptance |
| create Task | `POST /boards/{id}/tasks` | Executive, PM, Tester |
| update Task (assignee/status/deps/resources) | `PATCH /tasks/{id}` | all working roles |
| post conversation entry (+ attach artifact) | `POST /conversations/{id}/entries`, `POST /attachments` | all |
| read board / tasks / entries | the `GET` endpoints | all |

Handoffs are expressed in group (b): e.g. a Developer "handing off to the Reviewer" is a
`PATCH` of `assignee` + a conversation entry with implementation notes.

---

## 8. Source control as the backbone of state

Git is the low-level state layer; Tasks/conversation/specs are the high-level layer.
Together they make work resumable at every handoff.

### 8.1 The discipline (invariants)

- **Branch per Task.** Each Task is implemented on its own branch.
- **Commit on handoff.** Every Developer→Reviewer handoff is preceded by a commit, so the
  Reviewer reads a committed state and the handoff note describes it.
- **Squash-merge on approval.** The Reviewer's final act on approving a Task is a
  squash-merge back to **main**. Therefore **main always reflects completed, reviewed work**
  — a clean high-water mark.
- **Release branch per Stage.** The Tester may cut a release branch when a Stage completes,
  making Stage boundaries durable points in history.

### 8.2 Two-layer state model

- **High-level (intent/narrative):** Tasks, conversations, Stage Spec, Stage Report.
- **Low-level (work product):** git — main = reviewed truth; the Task branch = this Task's
  in-flight work; commits = handoff points.

At any **handoff boundary** (fresh Reviewer, fresh Tester, Developer picking a new Task),
the union of "read the Task conversation" and "check out the relevant branch" is complete
context.

### 8.3 Resumption & cleanup ("when in doubt, clean it out")

Committed state is trustworthy and resumable. **Uncommitted working-tree changes are
disposable unless trivially legible** — for AI-generated code, incomprehensible WIP is far
more likely a symptom of a struggling agent than valuable lost work.

Two remedies, escalating, with deliberate gating on the destructive one:

1. **Reset working tree to the branch's last commit** (discard unclear WIP). Routine
   cleanup when resuming and the WIP isn't readily understood. Low-stakes; loses only
   uncommitted work.
2. **Blast the whole branch and restart the Task from its last-known-good base** (main, or
   the Stage's start). The heavier remedy for a cycle-out where the whole approach went
   wrong. **NOT an automatic framework reflex** — it is a remedy the **PM or Executive may
   choose when revising** an escalated Task. Reflexive branch-nuking would discard
   salvageable work and mask the real problem (usually a bad Task that needs PM revision).

A **graceful cycle-out** (§9-bounds) should, as part of being cycled out, give the
Developer one final turn to **commit WIP and write a "here's where I was" note** before the
Task is escalated to the PM — converting the worst case (silent mid-thought interruption)
into a soft handoff. True catastrophe (e.g. power loss) falls back to remedy 1, acceptable
because it's rare and small Stages keep the blast radius tiny.

### 8.4 Context loading (what an agent reads on activation)

On waking an agent on a Task, the harness assembles: the Task (description, conversation),
the relevant Stage Spec (and Stage Report if re-planning), the proposal as needed, and the
git state (checkout of the Task branch; main as the reviewed baseline). A resumed Task with
an uncommitted working tree should prompt the agent to **reconcile/understand the WIP diff
first** (or apply §8.3 remedy 1) before continuing — never charge ahead blindly.

---

## 9. Bounds, escalation, and the board schema

### 9.1 Iteration bounds (primitives now; policies tunable)

Two primitives exist from v1; their values are starting points, tunable, and the *policy*
is learned by experience:

- **Cycle-out:** **10 Developer activations** on a single Task (one "activation" = one time
  the framework wakes the Developer on that Task). On exceeding, escalate the Task to the
  **PM** for revision (after a graceful final commit-and-note turn, §8.3).
- **Time-out:** **1 hour total Task lifetime** (measured from first activation; not paused
  while the Task sits in a queue — the point is "this Task is taking too long"). On
  exceeding, escalate to the **PM** for revision.

Escalations go to the PM first (a stuck loop is usually a bad Task, not a problem the user
must handle). The PM may revise the Task, or — for a genuinely wrong approach — choose §8.3
remedy 2. Only if the PM cannot resolve it does the matter climb to the user.

### 9.2 Board schema submitted at instantiation

On proposal acceptance, the framework submits the board schema (`SPEC.md` §3.4) declaring
the roster (§3) as personified agents with capability tags, the team's rich status
vocabulary (e.g. `awaiting_review`, `changes_requested`, `blocked_on_capacity`), and any
descriptive dynamics (e.g. approval of coding Tasks expects `review`/`testing` capability —
descriptive only; the server enforces nothing). Rich status lives in Task `resources`; the
server's three-value `status` carries only cancellation-safety.

---

## 10. What is deliberately left to experience (not specified)

These are intentionally *not* frozen; they are learned in trial-by-fire and tuned:

- **Exact role launch prompts** and the precise behavior of each agent within an activation.
- **Iteration-bound values** (the 10 / 1hr starting points).
- **Tester behavior per domain** — what "testing" concretely means varies wildly with what's
  built; v1 targets web apps (build + run + headless browser + **mandatory screenshots at
  every significant UI state**, all in-VM — see §6.6). Which states count as "significant,"
  how many screenshots are enough, and how to name/organize them are tuned by experience;
  the requirement to take them at all is not optional.
- **Selection-policy sophistication** over the environment JSON (starts "first suitable
  reachable").
- **When harness-level tool limits replace prompt-level discipline** for group (a) tools.

---

## Appendix A — The complete picture in one screen

- **Process states:** IDLE → BIDDING → WORKING → complete.
- **Roster:** Architect (proposal), Executive (Stage choice / done-or-next), PM
  (decompose + revise), Developer (implement, sole editor), Reviewer (review + squash-merge),
  Tester (build/run in-VM + Stage Report).
- **Stage = two bracketing Tasks:** "plan the Stage" (→PM, holds Stage Spec) gates the
  implementation Tasks; "test the Stage" (→Tester, holds Stage Report) depends on all of
  them and self-reblocks behind bug Tasks.
- **Scheduler = 3 rules, subject to capacity:** wake active Task's agent; else activate a
  dependency-free inactive Task; else wake Executive. Can't activate (busy compute *or*
  user-assigned) → other useful work, else wait.
- **Models:** OpenAI-standard endpoints in an environment JSON; selection is "first suitable
  reachable" for now, grows without structural change.
- **State:** git (main = reviewed truth; branch-per-Task; commit-on-handoff;
  squash-merge-on-approve; release-branch-per-Stage) + Tasks/conversation/specs. Unclear WIP
  is disposable; branch-blast is deliberate, not reflex.
- **Bounds:** cycle-out 10 / time-out 1hr → PM revision.
- **Tools:** uniform dev tools (prompt-governed) + precise server-comms tools.
- **Hard limits:** in-VM only, no deployment; one active editor per codebase.
