import OpenAI from 'openai'
import type { ApiClient, Task, Project, Board, Proposal, ChangelogEvent } from '../client/api-client'
import { ApiError } from '../client/api-client'
import type { TeamConfig } from '../config/types'
import { Role, ROLE_CAPABILITY } from '../config/types'
import type { TokenStore } from '../identity/actor-store'
import type { WorkspaceManager } from '../git/workspace-manager'
import { GitManager } from '../git/git-manager'
import { buildBoardSchema } from '../board/schema'
import { saveProcessState, loadProcessState, clearProcessState, ProjectRecord } from './process-state'
import { schedule, BoardSnapshot, selectEndpointForRole } from '../scheduler/scheduler'
import { AgentHarness, createOpenAIClient } from '../agents/base-agent'
import { ArchitectAgent } from '../agents/architect'
import { ExecutiveAgent } from '../agents/executive'
import { PMAgent } from '../agents/pm'
import { DeveloperAgent } from '../agents/developer'
import { ReviewerAgent } from '../agents/reviewer'
import { TesterAgent } from '../agents/tester'
import { SysadminAgent } from '../agents/sysadmin'

// ── SoftwareTeamProcess ────────────────────────────────────────────────────────
// Multi-project coordinator.  The team stays alive indefinitely, bidding on new
// RFPs, executing board work, and monitoring completed projects for user
// follow-ups.  One agent activation is dispatched per tick; project switching
// only happens at tick boundaries so no running agent is ever interrupted.
//
// Priority order within a single tick:
//   1. checkForNewRFPs     — Architect bids on any new soliciting projects
//   2. checkBiddingProjects — handle proposal feedback / win-or-lose resolution
//   3. checkProjectActivity — advance changelog cursors; re-promote monitoring
//   4. dispatchWork         — run one scheduler action on the best project

export class SoftwareTeamProcess {
  /** All projects the team knows about, keyed by projectId. */
  private projects = new Map<string, ProjectRecord>()
  /** The project currently receiving board-work dispatches. */
  private currentWorkProjectId: string | null = null
  /**
   * Project IDs whose RFPs the Architect has already assessed this run.
   * Prevents re-waking the Architect on the same RFP every tick.
   * Populated on startup from savedState so recovery respects prior decisions.
   */
  private assessedProjectIds = new Set<string>()

  private readonly agents: Record<Role, AgentHarness>
  private readonly userClient: ApiClient

  constructor(
    private readonly config: TeamConfig,
    private readonly tokenStore: TokenStore,
    private readonly clientByRole: Record<Role, ApiClient>,
    private readonly workspaceManager: WorkspaceManager,
    userClient: ApiClient,
  ) {
    this.userClient = userClient
    this.agents = this.buildAgents()
  }

  // ── Main loop ──────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    console.log('[process] Starting software team process')
    await this.recoverState()
    while (true) {
      try {
        await this.tick()
      } catch (err) {
        console.error('[process] Tick error:', err)
      }
      await sleep(this.config.pollIntervalMs)
    }
  }

  async tick(): Promise<void> {
    await this.checkForNewRFPs()
    await this.checkBiddingProjects()
    const activeSet = await this.checkProjectActivity()
    await this.dispatchWork(activeSet)
  }

  // ── Phase 1: Poll for new RFPs ─────────────────────────────────────────────

  private async checkForNewRFPs(): Promise<void> {
    const architectClient = this.clientByRole[Role.Architect]
    const response = await architectClient.listSolicitingProjects()

    for (const project of response.data) {
      if (this.assessedProjectIds.has(project.id)) continue
      this.assessedProjectIds.add(project.id)

      console.log(`[rfp] New soliciting project: ${project.id} — waking Architect`)

      const syntheticTask = projectAsSyntheticTask(project)
      await this.agents[Role.Architect].activate(syntheticTask, undefined, project.rfp)

      let ourProposal = await this.findArchitectProposal(architectClient, project.id)

      if (!ourProposal) {
        // The model may have written its proposal as response text without calling
        // create_proposal() — a known failure mode.  Give it one recovery activation
        // with an explicit reminder.  If it intentionally declined it will just stop.
        console.log(`[rfp] Architect did not post proposal — re-activating with tool reminder`)
        const nudge = [
          `## Action Required`,
          `You just processed the above RFP but did NOT call \`create_proposal()\`.`,
          ``,
          `- **If you intended to bid:** Call \`create_proposal(project_id, content)\` right now with your full proposal text.`,
          `- **If you intentionally declined:** Simply stop without calling any tool.`,
        ].join('\n')
        await this.agents[Role.Architect].activate(syntheticTask, undefined, project.rfp, nudge)
        ourProposal = await this.findArchitectProposal(architectClient, project.id)
      }

      if (ourProposal) {
        console.log(`[rfp] Architect posted proposal ${ourProposal.id} — tracking project as BIDDING`)
        this.projects.set(project.id, {
          state: 'bidding',
          proposalId: ourProposal.id,
          boardId: null,
          lastChangelogSince: null,
          projectCompletionDeclared: false,
          slug: rfpToSlug(project.rfp),
        })
        await this.saveState()
      } else {
        console.log(`[rfp] Architect declined to bid on project ${project.id}`)
      }
      // Continue — assess all new RFPs in this tick (Architect handles them serially)
    }
  }

  /** Return the Architect's proposal for a project, or undefined if none posted yet. */
  private async findArchitectProposal(architectClient: ApiClient, projectId: string) {
    const proposals = await architectClient.listProposals(projectId)
    return proposals.data.find(
      p => p.authorAgentId === this.tokenStore.actors[Role.Architect].actorId,
    )
  }

  // ── Phase 2: Service bidding projects ─────────────────────────────────────

  private async checkBiddingProjects(): Promise<void> {
    for (const [projectId, record] of this.projects) {
      if (record.state !== 'bidding') continue
      await this.tickBidding(projectId, record)
    }
  }

  private async tickBidding(projectId: string, record: ProjectRecord): Promise<void> {
    const architectClient = this.clientByRole[Role.Architect]
    let project: Project
    try {
      project = await architectClient.getProject(projectId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        console.log(`[bidding] Project ${projectId} no longer exists — removing`)
        this.projects.delete(projectId)
        await this.saveState()
        return
      }
      throw err
    }

    // Project closed before selection
    if (project.phase === 'done') {
      console.log(`[bidding] Project ${projectId} ended — removing`)
      this.projects.delete(projectId)
      await this.saveState()
      return
    }

    // Recovery: board was already created (e.g. we restarted after creating it)
    if (project.phase === 'board_active' && project.boardId) {
      const board = await architectClient.getBoard(project.boardId)
      if (board.teamAgentId === this.tokenStore.actors[Role.Architect].actorId) {
        console.log(`[bidding] Board already active (recovery) — transitioning ${projectId} to WORKING`)
        record.state = 'working'
        record.boardId = project.boardId
        record.lastChangelogSince = null
        if (!this.currentWorkProjectId) this.currentWorkProjectId = projectId
        await this.saveState()
      } else {
        console.log(`[bidding] Another team was selected for ${projectId} — removing`)
        this.projects.delete(projectId)
        await this.saveState()
      }
      return
    }

    // We won — create the board
    if (project.selectedProposalId === record.proposalId) {
      console.log(`[bidding] Our proposal selected for ${projectId}! Creating board...`)
      const schema = buildBoardSchema(this.tokenStore.actors)
      const board = await this.clientByRole[Role.Architect].createBoard(projectId, schema)
      console.log(`[bidding] Board created: ${board.id} — transitioning ${projectId} to WORKING`)
      record.state = 'working'
      record.boardId = board.id
      record.lastChangelogSince = null
      if (!this.currentWorkProjectId) this.currentWorkProjectId = projectId
      await this.saveState()
      return
    }

    // Another team was selected
    if (project.selectedProposalId && project.selectedProposalId !== record.proposalId) {
      console.log(`[bidding] Another proposal selected for ${projectId} — removing`)
      this.projects.delete(projectId)
      await this.saveState()
      return
    }

    // Still soliciting — check for unhandled feedback on our proposal
    const proposals = await architectClient.listProposals(projectId)
    const architectActorId = this.tokenStore.actors[Role.Architect].actorId
    const ourProposal = proposals.data.find(p => p.id === record.proposalId)

    if (ourProposal) {
      const entries = await architectClient.listAllEntries(ourProposal.conversationId)
      const externalEntries = entries.filter(e => e.authorActorId !== architectActorId)
      const ourEntries       = entries.filter(e => e.authorActorId === architectActorId)

      const latestExternalTime = externalEntries.length > 0
        ? externalEntries[externalEntries.length - 1].createdAt : ''
      const latestOurTime = ourEntries.length > 0
        ? ourEntries[ourEntries.length - 1].createdAt : ''

      if (latestExternalTime > latestOurTime) {
        const latestFeedback = externalEntries[externalEntries.length - 1]
        console.log(`[bidding] Unhandled feedback on proposal for ${projectId} — waking Architect for revision`)
        const syntheticTask = proposalAsSyntheticTask(ourProposal, project)
        await this.agents[Role.Architect].activate(
          syntheticTask, ourProposal, project.rfp,
          `\n**New feedback requires attention.**\nLatest entry at ${latestFeedback.createdAt}.`,
        )
      }
    }
  }

  // ── Phase 3: Activity detection ───────────────────────────────────────────

  /**
   * Poll changelogs for all working and monitoring projects.
   * Returns the set of projectIds that have new activity this tick.
   * Also re-promotes any monitoring project that has activity (any event while
   * the team is idle = user-originated, so re-engage).
   */
  private async checkProjectActivity(): Promise<Set<string>> {
    const activeSet = new Set<string>()
    const executiveClient = this.clientByRole[Role.Executive]

    for (const [projectId, record] of this.projects) {
      if (record.state !== 'working' && record.state !== 'monitoring') continue
      if (!record.boardId) continue

      if (record.lastChangelogSince === null) {
        // First time checking this project — initialise cursor and treat as active
        record.lastChangelogSince = new Date().toISOString()
        activeSet.add(projectId)
        continue
      }

      try {
        const changelog = await executiveClient.getBoardChangelog(record.boardId, record.lastChangelogSince)
        if (changelog.data.length === 0) continue

        // Advance cursor
        if (changelog.next_since) record.lastChangelogSince = changelog.next_since
        activeSet.add(projectId)

        // Any activity on a monitoring project means the user touched something
        if (record.state === 'monitoring') {
          console.log(`[monitor] Activity detected on completed project ${projectId} — re-promoting to WORKING`)
          record.state = 'working'
          record.projectCompletionDeclared = false
          // Capture the triggering events so the Executive knows what changed
          // without having to hunt through the board.
          record.reengagementContext = formatReengagementContext(changelog.data)
          await this.saveState()
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Board gone — project was deleted
          console.log(`[monitor] Board for project ${projectId} not found — removing`)
          this.projects.delete(projectId)
          if (this.currentWorkProjectId === projectId) this.currentWorkProjectId = null
          await this.saveState()
        } else {
          console.warn(`[monitor] Changelog poll failed for project ${projectId}:`, err)
        }
      }
    }

    return activeSet
  }

  // ── Phase 4: Dispatch board work ───────────────────────────────────────────

  private async dispatchWork(activeSet: Set<string>): Promise<void> {
    // Determine which project to work on this tick.
    let targetId = this.currentWorkProjectId

    // Validate current target is still working
    if (targetId) {
      const rec = this.projects.get(targetId)
      if (!rec || rec.state !== 'working') targetId = null
    }

    // If current project has no activity but another working project does,
    // switch to the active one (we're at a tick boundary — convenient point).
    if (targetId && !activeSet.has(targetId)) {
      for (const projectId of activeSet) {
        const rec = this.projects.get(projectId)
        if (rec && rec.state === 'working' && projectId !== targetId) {
          console.log(`[dispatch] Switching focus from ${targetId} to active project ${projectId}`)
          targetId = projectId
          this.currentWorkProjectId = targetId
          break
        }
      }
    }

    // No current target — pick the oldest working project (map insertion order)
    if (!targetId) {
      for (const [projectId, rec] of this.projects) {
        if (rec.state === 'working') {
          targetId = projectId
          this.currentWorkProjectId = targetId
          break
        }
      }
    }

    if (!targetId) {
      const monitorCount = [...this.projects.values()].filter(r => r.state === 'monitoring').length
      const biddingCount = [...this.projects.values()].filter(r => r.state === 'bidding').length
      if (this.projects.size > 0) {
        console.log(`[dispatch] Idle — bidding:${biddingCount}, monitoring:${monitorCount}`)
      } else {
        console.log('[dispatch] Idle — no active projects')
      }
      return
    }

    const record = this.projects.get(targetId)!
    if (record.state !== 'working') return

    // Point all agents at the correct project git repo before any activation
    const gitManager = await this.workspaceManager.getOrCreateProjectRepo(targetId, record.slug)
    for (const agent of Object.values(this.agents)) {
      agent.setGitManager(gitManager)
    }

    await this.tickWorking(targetId, record, activeSet.has(targetId), gitManager)
  }

  // ── WORKING tick for a specific project ───────────────────────────────────

  private async tickWorking(projectId: string, record: ProjectRecord, hasActivity: boolean, gitManager: GitManager): Promise<void> {
    if (!record.boardId) {
      console.warn(`[working] Project ${projectId} has no boardId — skipping`)
      return
    }

    // Fetch fresh project state
    let project: Project
    try {
      const executiveClient = this.clientByRole[Role.Executive]
      project = await executiveClient.getProject(projectId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        console.log(`[working] Project ${projectId} was deleted — removing`)
        this.projects.delete(projectId)
        if (this.currentWorkProjectId === projectId) this.currentWorkProjectId = null
        await this.saveState()
        return
      }
      throw err
    }

    // User closed/archived the project
    if (project.phase === 'done') {
      console.log(`[working] Project ${projectId} phase=done — removing from registry`)
      this.projects.delete(projectId)
      if (this.currentWorkProjectId === projectId) this.currentWorkProjectId = null
      await this.saveState()
      return
    }

    // Executive already declared this project complete — nothing further until
    // user activity (handled by checkProjectActivity re-promoting to 'working').
    // This path shouldn't normally be reached (Executive declaration sets state
    // to 'monitoring'), but guard anyway.
    if (record.projectCompletionDeclared) {
      console.log(`[working] Project ${projectId} Executive-declared complete — back to monitoring`)
      record.state = 'monitoring'
      if (this.currentWorkProjectId === projectId) this.currentWorkProjectId = null
      await this.saveState()
      return
    }

    // Skip full task load when nothing changed since last tick
    if (!hasActivity) {
      console.log(`[working] No activity on project ${projectId} — waiting`)
      return
    }

    // Load all tasks
    const executiveClient = this.clientByRole[Role.Executive]
    const tasks = await executiveClient.listAllTasks(record.boardId!)

    // Build snapshot for scheduler
    const snapshot: BoardSnapshot = {
      tasks,
      actorIdByRole: Object.fromEntries(
        Object.entries(this.tokenStore.actors).map(([role, rec]) => [role, rec.actorId])
      ) as Record<Role, string>,
      userActorId: await this.getUserActorId(),
      endpoints: this.config.endpoints,
    }

    const action = schedule(snapshot)
    console.log(`[working:${projectId.slice(0, 8)}] Scheduler action: ${JSON.stringify(action)}`)

    switch (action.kind) {
      case 'wake': {
        let task = tasks.find(t => t.id === action.taskId)!

        if (action.role === Role.Developer) {
          const meta = ((task.resources as Record<string, unknown> ?? {})['team_meta'] as Record<string, unknown>) ?? {}

          // PM may set blast_branch to request a clean `work` branch before the next activation.
          if (meta['blast_branch']) {
            console.log(`[working:${projectId.slice(0, 8)}] blast_branch set — deleting work branch`)
            await gitManager.deleteWorkBranch()
            const clearedMeta = { ...meta, blast_branch: false }
            const clearedResources = { ...(task.resources as object ?? {}), team_meta: clearedMeta }
            await this.clientByRole[action.role].patchTask(action.taskId, { resources: clearedResources })
            task = await this.clientByRole[action.role].getTask(action.taskId)
          }

          // Always increment on every Developer wake — mirrors activate_and_wake so
          // activation_count correctly reflects total activations and cycle-out
          // escalation (>= 10) can actually trigger through this path.
          const updatedMeta = {
            ...meta,
            first_activated_at: (meta['first_activated_at'] as number) ?? Date.now(),
            activation_count: ((meta['activation_count'] as number) ?? 0) + 1,
          }
          const updatedResources = { ...(task.resources as object ?? {}), team_meta: updatedMeta }
          await this.clientByRole[action.role].patchTask(action.taskId, { resources: updatedResources })
          task = await this.clientByRole[action.role].getTask(action.taskId)
        }

        // Reset changelog cursor BEFORE waking the agent so that even if the
        // activation throws (e.g. APIConnectionTimeoutError), the cursor is not
        // left frozen at its pre-activation timestamp.  A frozen cursor causes
        // every subsequent tick to short-circuit on hasActivity===false and the
        // project stalls in a permanent "No activity" loop.
        record.lastChangelogSince = null
        await this.wakeAgent(action.role, task, projectId)
        break
      }

      case 'activate_and_wake': {
        const task = tasks.find(t => t.id === action.taskId)!
        const meta = (task.resources as Record<string, unknown>)?.['team_meta'] as Record<string, unknown> ?? {}
        const now = Date.now()
        const updatedMeta = {
          ...meta,
          activation_count: ((meta['activation_count'] as number) ?? 0) + 1,
          first_activated_at: meta['first_activated_at'] ?? now,
        }
        const updatedResources = { ...(task.resources as object ?? {}), team_meta: updatedMeta }

        await this.clientByRole[action.role].patchTask(action.taskId, {
          status: 'active',
          resources: updatedResources,
        })

        const updatedTask = await this.clientByRole[action.role].getTask(action.taskId)
        // Reset cursor before waking — same rationale as the 'wake' case above.
        record.lastChangelogSince = null
        await this.wakeAgent(action.role, updatedTask, projectId)
        break
      }

      case 'wake_executive': {
        const taskCountBefore = tasks.length
        // If all tasks are complete this is a post-completion re-engagement.
        // Pass the pre-captured context so the Executive sees the triggering
        // entries immediately rather than hunting through the board.
        const isReengagement = tasks.every(t => t.status === 'complete')
        const extra = isReengagement ? record.reengagementContext : undefined
        const syntheticTask = boardAsSyntheticTask(record.boardId!, projectId, tasks)
        const proposal = await this.getProposalForProject(projectId, record)
        // Reset cursor before activating — same rationale as 'wake'/'activate_and_wake'.
        // The completion-declaration branch below will advance it to NOW if needed.
        record.lastChangelogSince = null
        await this.agents[Role.Executive].activate(
          syntheticTask, proposal ?? undefined, undefined, extra ?? undefined)
        // Always clear stale context after the Executive has been given it.
        record.reengagementContext = undefined

        // Detect project completion declaration
        const tasksAfter = await executiveClient.listAllTasks(record.boardId!)
        if (tasksAfter.length === taskCountBefore && tasksAfter.every(t => t.status === 'complete')) {
          console.log(`[working:${projectId.slice(0, 8)}] Executive declared project complete — moving to MONITORING`)
          record.state = 'monitoring'
          record.projectCompletionDeclared = true
          // Advance the changelog cursor to NOW so the Executive's own completion
          // entry doesn't trigger a spurious re-promotion to 'working' on the next tick.
          record.lastChangelogSince = new Date().toISOString()
          if (this.currentWorkProjectId === projectId) this.currentWorkProjectId = null
          await this.saveState()
        }
        break
      }

      case 'escalate': {
        await this.handleEscalation(action.taskId, action.reason, tasks)
        break
      }

      case 'orphaned_tasks': {
        // Tasks assigned to unrecognised actor IDs — auto-reassign to PM for triage.
        console.log(`[working:${projectId.slice(0, 8)}] ${action.taskIds.length} orphaned task(s) found (unknown actors: ${action.unknownActorIds.join(', ')}) — reassigning to PM`)
        await this.healOrphanedTasks(action.taskIds, action.unknownActorIds)
        // Reset cursor so the next tick re-evaluates the (now-repaired) board.
        record.lastChangelogSince = null
        break
      }

      case 'wait': {
        console.log(`[working:${projectId.slice(0, 8)}] Waiting: ${action.reason}`)
        // Reset cursor so the board is always re-evaluated on the next tick.
        // Without this, a wait with no subsequent changelog activity means the
        // scheduler is never called again — the project silently stalls.
        record.lastChangelogSince = null
        break
      }
    }
  }

  // ── Agent wakeup ───────────────────────────────────────────────────────────

  private async wakeAgent(role: Role, task: Task, projectId: string): Promise<void> {
    console.log(`[working:${projectId.slice(0, 8)}] Waking ${role} for task ${task.id}`)
    const record = this.projects.get(projectId)
    const proposal = record ? await this.getProposalForProject(projectId, record) : null
    const project = await this.clientByRole[role].getProject(projectId)
    await this.agents[role].activate(task, proposal ?? undefined, project.rfp)
  }

  // ── Escalation handler ─────────────────────────────────────────────────────

  private async handleEscalation(taskId: string, reason: 'cycle_out' | 'time_out', tasks: Task[]): Promise<void> {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return

    const pmActorId = this.tokenStore.actors[Role.PM].actorId
    const pmClient = this.clientByRole[Role.PM]

    const reasonText = reason === 'cycle_out'
      ? `Developer reached the ${10}-activation cycle limit on this task.`
      : `Task has been open for more than 1 hour.`

    console.log(`[working] Escalating task ${taskId} to PM: ${reasonText}`)

    await pmClient.postEntry(
      task.conversationId,
      `**Escalation to PM**\n\n${reasonText}\nAutomatically escalated by the scheduler.\n\nPlease review the task and either revise the description, split the task, or request user clarification.`,
      { kind: 'escalation', reason },
    )

    const currentResources = (task.resources as Record<string, unknown>) ?? {}
    const currentMeta = (currentResources['team_meta'] as Record<string, unknown>) ?? {}
    const resetMeta = {
      ...currentMeta,
      first_activated_at: null,
      activation_count: 0,
    }
    await pmClient.patchTask(taskId, {
      assignee_actor_id: pmActorId,
      resources: { ...currentResources, team_meta: resetMeta },
    })
  }

  // ── Orphaned-task self-healing ────────────────────────────────────────────

  /**
   * Reassign tasks that are stuck with an unrecognised actor ID back to the PM.
   * This covers two root causes:
   *  - An agent bug that created a task with the user's actor ID (or any other
   *    non-team actor) instead of the intended team member.
   *  - A manual external assignment that used the wrong ID.
   * The PM receives a note explaining what happened so it can re-triage.
   */
  private async healOrphanedTasks(taskIds: string[], unknownActorIds: string[]): Promise<void> {
    const pmActorId = this.tokenStore.actors[Role.PM].actorId
    const pmClient = this.clientByRole[Role.PM]

    for (const taskId of taskIds) {
      try {
        await pmClient.patchTask(taskId, { assignee_actor_id: pmActorId })
        const task = await pmClient.getTask(taskId)
        if (task.conversationId) {
          await pmClient.postEntry(
            task.conversationId,
            `**⚠️ Auto-repair: task reassigned to PM for triage**\n\n` +
            `This task was assigned to an actor ID that is not a recognised team member: \`${unknownActorIds.join(', ')}\`\n\n` +
            `The scheduler detected the issue and has reassigned the task to the PM. ` +
            `Please review the task description, determine who it is intended for, and either:\n` +
            `- Reassign it to the correct team member and set status to inactive\n` +
            `- Split or rewrite it if the description is unclear\n` +
            `- Create a user-clarification task if user input is needed`,
          )
        }
        console.log(`[working] Healed orphaned task ${taskId} → PM`)
      } catch (err) {
        console.error(`[working] Failed to heal orphaned task ${taskId}:`, err)
      }
    }
  }

  // ── State persistence ──────────────────────────────────────────────────────

  private async saveState(): Promise<void> {
    const projects: Record<string, ProjectRecord> = {}
    for (const [id, rec] of this.projects) {
      projects[id] = { ...rec }
    }
    await saveProcessState({ projects, currentWorkProjectId: this.currentWorkProjectId })
  }

  // ── Startup recovery ───────────────────────────────────────────────────────

  /**
   * On startup: read .process-state.json (v2) and restore the project registry.
   * For each recovered project, verify its server state is still consistent
   * before restoring it. Stale or missing projects are silently dropped.
   */
  private async recoverState(): Promise<void> {
    const saved = await loadProcessState()
    if (!saved) return

    console.log(`[process] Recovering state — ${Object.keys(saved.projects).length} project(s) found`)

    for (const [projectId, record] of Object.entries(saved.projects)) {
      try {
        if (record.state === 'working') {
          const project = await this.clientByRole[Role.Executive].getProject(projectId)
          if (project.phase === 'board_active') {
            console.log(`[process] Resuming WORKING project ${projectId} (board ${record.boardId})`)
            // Reset changelog cursor so first tick does a full task load
            this.projects.set(projectId, { ...record, lastChangelogSince: null })
            this.assessedProjectIds.add(projectId)
          } else if (project.phase === 'done') {
            console.log(`[process] Recovered WORKING project ${projectId} is already done — skipping`)
          } else {
            console.warn(`[process] Recovered WORKING project ${projectId} has unexpected phase '${project.phase}' — skipping`)
          }

        } else if (record.state === 'bidding') {
          const project = await this.clientByRole[Role.Architect].getProject(projectId)
          if (project.phase === 'soliciting' || project.phase === 'board_active') {
            console.log(`[process] Resuming BIDDING project ${projectId} (phase: ${project.phase})`)
            this.projects.set(projectId, { ...record })
            this.assessedProjectIds.add(projectId)
          } else {
            console.warn(`[process] Recovered BIDDING project ${projectId} now '${project.phase}' — skipping`)
          }

        } else if (record.state === 'monitoring') {
          const project = await this.clientByRole[Role.Executive].getProject(projectId)
          if (project.phase !== 'done') {
            console.log(`[process] Resuming MONITORING project ${projectId}`)
            // Reset the cursor to null so checkProjectActivity reinitialises it
            // to NOW on the first tick.  This prevents a stale cursor from
            // treating the Executive's completion declaration as "new user activity"
            // and immediately re-promoting the project.
            this.projects.set(projectId, { ...record, lastChangelogSince: null })
            this.assessedProjectIds.add(projectId)
          } else {
            console.log(`[process] Recovered MONITORING project ${projectId} is now done/archived — skipping`)
          }
        }

      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          console.log(`[process] Recovered project ${projectId} no longer exists — skipping`)
        } else {
          console.warn(`[process] Recovery check failed for project ${projectId}:`, err)
        }
      }
    }

    // Restore current work pointer if the project is still working
    if (saved.currentWorkProjectId) {
      const rec = this.projects.get(saved.currentWorkProjectId)
      if (rec && rec.state === 'working') {
        this.currentWorkProjectId = saved.currentWorkProjectId
        console.log(`[process] Restored current work focus: ${saved.currentWorkProjectId}`)
      }
    }

    if (this.projects.size === 0) {
      console.log('[process] No recoverable projects — starting fresh')
      await clearProcessState()
    }
  }

  // ── Agent instantiation ────────────────────────────────────────────────────

  private buildAgents(): Record<Role, AgentHarness> {
    const openaiByRole = this.buildOpenAIClients()

    // Placeholder GitManager for agents that don't yet have a project assigned.
    // Points to the container root (workDir) so dev-tool path resolution works
    // for bidding-phase agents (Architect) that may list/read files.
    // setGitManager() replaces this with the per-project repo before any
    // working-phase activation.
    const placeholderGitManager = new GitManager(this.workspaceManager.getWorkDir())

    const architectActorId  = this.tokenStore.actors[Role.Architect].actorId
    const executiveActorId  = this.tokenStore.actors[Role.Executive].actorId
    const pmActorId         = this.tokenStore.actors[Role.PM].actorId
    const developerActorId  = this.tokenStore.actors[Role.Developer].actorId
    const reviewerActorId   = this.tokenStore.actors[Role.Reviewer].actorId
    const testerActorId     = this.tokenStore.actors[Role.Tester].actorId
    const sysadminActorId   = this.tokenStore.actors[Role.Sysadmin].actorId

    // Helper: set inference params after construction without breaking object-literal style
    const withInference = <T extends import('../agents/base-agent').AgentHarness>(agent: T, role: Role): T => {
      agent.setInferenceParams(this.inferenceParamsForRole(role))
      return agent
    }

    return {
      [Role.Architect]: withInference(new ArchitectAgent(
        architectActorId,
        openaiByRole[Role.Architect],
        this.clientByRole[Role.Architect],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Architect),
      ), Role.Architect),
      [Role.Executive]: withInference(new ExecutiveAgent(
        executiveActorId,
        openaiByRole[Role.Executive],
        this.clientByRole[Role.Executive],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Executive),
        pmActorId,
      ), Role.Executive),
      [Role.PM]: withInference(new PMAgent(
        pmActorId,
        openaiByRole[Role.PM],
        this.clientByRole[Role.PM],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.PM),
        developerActorId,
        testerActorId,
        this.config.harbor ? sysadminActorId : null,
      ), Role.PM),
      [Role.Developer]: withInference(new DeveloperAgent(
        developerActorId,
        openaiByRole[Role.Developer],
        this.clientByRole[Role.Developer],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Developer),
        reviewerActorId,
      ), Role.Developer),
      [Role.Reviewer]: withInference(new ReviewerAgent(
        reviewerActorId,
        openaiByRole[Role.Reviewer],
        this.clientByRole[Role.Reviewer],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Reviewer),
        developerActorId,
        pmActorId,
      ), Role.Reviewer),
      [Role.Tester]: withInference(new TesterAgent(
        testerActorId,
        openaiByRole[Role.Tester],
        this.clientByRole[Role.Tester],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Tester),
        developerActorId,
      ), Role.Tester),
      [Role.Sysadmin]: withInference(new SysadminAgent(
        sysadminActorId,
        openaiByRole[Role.Sysadmin],
        this.clientByRole[Role.Sysadmin],
        placeholderGitManager, this.config,
        this.modelNameForRole(Role.Sysadmin),
        developerActorId,
      ), Role.Sysadmin),
    }
  }

  private buildOpenAIClients(): Record<Role, OpenAI> {
    const result: Partial<Record<Role, OpenAI>> = {}
    for (const role of Object.values(Role)) {
      // Primary: endpoint matching this role's capability tag
      let endpoint = selectEndpointForRole(role, this.config.endpoints)
      // Fallback for the Sysadmin when no 'deployment' endpoint is configured —
      // avoids breaking existing environments.json files after the upgrade.
      if (!endpoint && role === Role.Sysadmin) {
        endpoint = this.config.endpoints[0] ?? null
        if (endpoint) {
          console.warn(`[config] No 'deployment' endpoint in environments.json — Sysadmin will use "${endpoint.name}". Add "deployment" to role_suitability to silence this warning.`)
        }
      }
      if (!endpoint) {
        throw new Error(`No model endpoint available for role: ${role}. Check your environments.json configuration.`)
      }
      result[role] = createOpenAIClient(endpoint)
    }
    return result as Record<Role, OpenAI>
  }

  private modelNameForRole(role: Role): string {
    const endpoint = selectEndpointForRole(role, this.config.endpoints)
    return endpoint?.model ?? endpoint?.name ?? 'default'
  }

  private inferenceParamsForRole(role: Role): import('../config/types').InferenceParams {
    const endpoint = selectEndpointForRole(role, this.config.endpoints)
    return endpoint?.inference ?? {}
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private async getProposalForProject(projectId: string, record: ProjectRecord): Promise<Proposal | null> {
    if (!record.proposalId) return null
    const client = this.clientByRole[Role.Executive]
    const proposals = await client.listProposals(projectId)
    return proposals.data.find(p => p.id === record.proposalId) ?? null
  }

  private cachedUserActorId: string | null = null
  private async getUserActorId(): Promise<string> {
    if (this.cachedUserActorId) return this.cachedUserActorId
    const me = await this.userClient.me()
    this.cachedUserActorId = me.id
    return me.id
  }
}

// ── Synthetic task factories ───────────────────────────────────────────────────

function projectAsSyntheticTask(project: Project): Task {
  return {
    id: project.id,
    boardId: '',
    assigneeActorId: '',
    status: 'active',
    description: `Assess and bid on project: ${project.rfp.slice(0, 100)}...`,
    resources: { synthetic: true, projectId: project.id },
    conversationId: '',
    depends_on: [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function proposalAsSyntheticTask(proposal: Proposal, project: Project): Task {
  return {
    id: proposal.id,
    boardId: '',
    assigneeActorId: '',
    status: 'active',
    description: `Revise proposal for project: ${project.rfp.slice(0, 100)}...`,
    resources: { synthetic: true, projectId: project.id, proposalId: proposal.id },
    conversationId: proposal.conversationId,
    depends_on: [],
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  }
}

function boardAsSyntheticTask(boardId: string, projectId: string, tasks: Task[]): Task {
  const completedTasks = tasks.filter(t => t.status === 'complete').length
  return {
    id: `synthetic-board-${boardId}`,
    boardId,
    assigneeActorId: '',
    status: 'active',
    description: `Board evaluation: ${tasks.length} total tasks, ${completedTasks} complete. Assess project progress and choose next Stage or complete the project.`,
    resources: { synthetic: true, boardId, projectId, taskCount: tasks.length, completedCount: completedTasks },
    conversationId: '',
    depends_on: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Format changelog events into a human-readable context string for the Executive.
 * Called when a monitoring project is re-promoted so the Executive knows exactly
 * what the user posted without having to read through all task conversations.
 */
function formatReengagementContext(events: ChangelogEvent[]): string {
  const lines: string[] = ['## What triggered this re-engagement', '']
  for (const event of events) {
    if (event.type === 'entry_added') {
      const location = event.task_id ? `task ${event.task_id}` : `board conversation ${event.conversation_id}`
      lines.push(`**New entry** on ${location} at ${event.timestamp} by actor \`${event.author_actor_id}\`:`)
      const body = event.body.length > 500 ? event.body.slice(0, 500) + '…' : event.body
      lines.push(body)
      lines.push('')
    } else if (event.type === 'task_created') {
      lines.push(`**Task created** (${event.task_id}) at ${event.timestamp} — status: ${event.status}`)
      lines.push('')
    } else if (event.type === 'task_updated') {
      lines.push(`**Task updated** (${event.task_id}) at ${event.timestamp} — status: ${event.status}`)
      lines.push('')
    }
  }
  if (lines.length === 2) {
    lines.push('_(No detailed event data available — check the board manually.)_')
  }
  return lines.join('\n')
}

/**
 * Derive a short, filesystem-safe slug from the first ~60 characters of an RFP.
 * Returns undefined if the result is too short to be meaningful.
 * Used to give project workspace folders a human-readable name.
 * Examples:
 *   "Build a Todo app in React"  → "build-a-todo-app-in-react"
 *   "Refactor auth module"       → "refactor-auth-module"
 */
function rfpToSlug(rfp: string): string | undefined {
  const slug = rfp
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug.length >= 3 ? slug : undefined
}
