import type { Task } from '../client/api-client'
import { Role, ROLE_CAPABILITY } from '../config/types'
import type { ResolvedEndpoint } from '../config/types'

// ── Role priority ──────────────────────────────────────────────────────────────
// When multiple tasks are eligible to run, higher-priority roles go first.
// Architect and Executive are control-plane: they set direction and close stages.
// PM is orchestration: planning and escalation must preempt implementation.
// Reviewer before Developer: clearing a review unblocks the next dev task faster
// than starting new work while reviews sit pending.
// Tester runs last: it validates completed work and gates stage closure.
const ROLE_PRIORITY: Role[] = [
  Role.Architect,
  Role.Executive,
  Role.PM,
  Role.Reviewer,
  Role.Developer,
  Role.Tester,
  Role.Sysadmin,  // deployment runs only after testing passes
]

function rolePriority(role: Role): number {
  const idx = ROLE_PRIORITY.indexOf(role)
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
}

// ── Scheduler types ────────────────────────────────────────────────────────────

export type SchedulerAction =
  | { kind: 'wake'; taskId: string; role: Role }
  | { kind: 'activate_and_wake'; taskId: string; role: Role }
  | { kind: 'wake_executive' }
  | { kind: 'escalate'; taskId: string; reason: 'cycle_out' | 'time_out' }
  | { kind: 'wait'; reason: string }
  /**
   * One or more runnable tasks are assigned to actor IDs that don't map to any
   * known team role.  The state machine should auto-reassign them to the PM for
   * triage rather than waiting indefinitely.
   */
  | { kind: 'orphaned_tasks'; taskIds: string[]; unknownActorIds: string[] }

export type BoardSnapshot = {
  tasks: Task[]
  /** Maps each role to the actor ID for that role */
  actorIdByRole: Record<Role, string>
  /** The user's actor ID (user tasks are un-activatable by the scheduler) */
  userActorId: string
  /** Available model endpoints for capacity checking */
  endpoints: ResolvedEndpoint[]
}

// ── Team metadata stored in task.resources ────────────────────────────────────

type TeamMeta = {
  activation_count?: number
  first_activated_at?: number
  blast_branch?: boolean
}

function getTeamMeta(task: Task): TeamMeta {
  const resources = task.resources as Record<string, unknown> | null | undefined
  return (resources?.['team_meta'] as TeamMeta) ?? {}
}

// ── Iteration bounds ───────────────────────────────────────────────────────────

const MAX_DEVELOPER_ACTIVATIONS = 10
const MAX_TASK_LIFETIME_MS = 60 * 60 * 1000 // 1 hour

// ── Pure scheduler function ────────────────────────────────────────────────────

/**
 * The scheduler is a pure function over a board snapshot.
 * It never makes API calls. Returns a single action for the state machine to execute.
 *
 * Three rules (in order of priority):
 * 1. Active task + agent not running → wake
 * 2. No active tasks → find dependency-free inactive task, activate + wake
 * 3. All tasks complete (or board empty) → wake_executive
 *
 * Iteration bounds checked before rule 1:
 * - Developer task with activation_count >= 10 → escalate (cycle_out)
 * - Any task open for > 1 hour → escalate (time_out)
 */
export function schedule(snapshot: BoardSnapshot): SchedulerAction {
  const { tasks, actorIdByRole, userActorId, endpoints } = snapshot

  // ── Check escalation conditions on active Developer tasks ──────────────────
  for (const task of tasks) {
    if (task.status !== 'active') continue
    if (task.assigneeActorId !== actorIdByRole[Role.Developer]) continue

    const meta = getTeamMeta(task)
    const now = Date.now()

    if ((meta.activation_count ?? 0) >= MAX_DEVELOPER_ACTIVATIONS) {
      return { kind: 'escalate', taskId: task.id, reason: 'cycle_out' }
    }

    if (meta.first_activated_at && (now - meta.first_activated_at) > MAX_TASK_LIFETIME_MS) {
      return { kind: 'escalate', taskId: task.id, reason: 'time_out' }
    }
  }

  // Compute completed set once — used by both Rule 1 (dep guard) and Rule 2 (runnable filter)
  const completedTaskIds = new Set(tasks.filter(t => t.status === 'complete').map(t => t.id))

  // ── Rule 1: Wake an already-active task (highest-priority role first) ────────
  // Collect all eligible active tasks, sort by role priority, wake the top one.
  // This ensures PM tasks preempt Developer/Tester tasks, Reviewer tasks run
  // before new Developer tasks start, etc. — regardless of creation order.
  const activeEligible: Array<{ task: Task; role: Role }> = []
  for (const task of tasks) {
    if (task.status !== 'active') continue

    // Skip tasks blocked by unfinished dependencies — they should not be re-activated
    // until all deps complete (e.g. a test task waiting on bug fixes).
    if (!task.depends_on.every(depId => completedTaskIds.has(depId))) continue

    // Skip user-assigned tasks — user is un-activatable
    if (task.assigneeActorId === userActorId) continue

    const role = roleForActorId(task.assigneeActorId, actorIdByRole)
    if (!role) continue // Unknown actor — skip

    activeEligible.push({ task, role })
  }

  if (activeEligible.length > 0) {
    activeEligible.sort((a, b) => rolePriority(a.role) - rolePriority(b.role))
    const { task, role } = activeEligible[0]
    if (!hasCapacity(role, endpoints)) {
      return { kind: 'wait', reason: `No available endpoint for role: ${role}` }
    }
    return { kind: 'wake', taskId: task.id, role }
  }

  // ── Rule 2: Activate a dependency-free inactive task (highest-priority first) ─

  const runnable = tasks.filter(task => {
    if (task.status !== 'inactive') return false
    // Skip user-assigned tasks
    if (task.assigneeActorId === userActorId) return false
    // All dependencies must be complete
    return task.depends_on.every(depId => completedTaskIds.has(depId))
  })

  if (runnable.length > 0) {
    // Separate tasks with known roles from orphaned (unrecognised actor ID) tasks.
    const runnableKnown: Array<{ task: Task; role: Role }> = []
    const orphanedActorIds = new Set<string>()

    for (const task of runnable) {
      const role = roleForActorId(task.assigneeActorId, actorIdByRole)
      if (role) {
        runnableKnown.push({ task, role })
      } else {
        orphanedActorIds.add(task.assigneeActorId)
      }
    }

    if (runnableKnown.length > 0) {
      runnableKnown.sort((a, b) => rolePriority(a.role) - rolePriority(b.role))
      const { task, role } = runnableKnown[0]
      if (!hasCapacity(role, endpoints)) {
        return { kind: 'wait', reason: `No available endpoint for role: ${role}` }
      }
      return { kind: 'activate_and_wake', taskId: task.id, role }
    }

    // All runnable tasks have unrecognised actor IDs — signal for self-healing.
    // The state machine will reassign them to the PM rather than waiting forever.
    return {
      kind: 'orphaned_tasks',
      taskIds: runnable.map(t => t.id),
      unknownActorIds: [...orphanedActorIds],
    }
  }

  // Check if only user-assigned inactive tasks remain (waiting on user)
  const userInactiveTasks = tasks.filter(
    t => t.status === 'inactive' && t.assigneeActorId === userActorId &&
    t.depends_on.every(depId => completedTaskIds.has(depId))
  )
  if (userInactiveTasks.length > 0) {
    return { kind: 'wait', reason: 'Waiting for user to complete assigned tasks' }
  }

  // ── Rule 3: All tasks complete (or board empty) → wake Executive ───────────
  const allComplete = tasks.length === 0 || tasks.every(t => t.status === 'complete')
  if (allComplete) {
    if (!hasCapacity(Role.Executive, endpoints)) {
      return { kind: 'wait', reason: 'No available endpoint for Executive role' }
    }
    return { kind: 'wake_executive' }
  }

  // ── Deadlock: tasks exist but none are actionable ──────────────────────────
  // This can happen if there are inactive tasks with unsatisfied dependencies
  // that will never be satisfied (e.g., a dep task failed to be created).
  return { kind: 'wait', reason: 'No actionable tasks (possible dependency deadlock — check board)' }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Find which role corresponds to a given actor ID.
 */
function roleForActorId(actorId: string, actorIdByRole: Record<Role, string>): Role | null {
  for (const [role, id] of Object.entries(actorIdByRole)) {
    if (id === actorId) return role as Role
  }
  return null
}

/**
 * V1 capacity check: is there at least one endpoint that lists the role's capability?
 * Full implementation would do a live health check; V1 just checks configuration.
 * The Sysadmin falls back to "any endpoint available" when no 'deployment' tag is present,
 * so existing environments.json files don't need to be updated to run deploy tasks.
 */
function hasCapacity(role: Role, endpoints: ResolvedEndpoint[]): boolean {
  const capability = ROLE_CAPABILITY[role]
  if (endpoints.some(ep => ep.role_suitability.includes(capability))) return true
  if (role === Role.Sysadmin) return endpoints.length > 0
  return false
}

/**
 * Find the appropriate endpoint for a role.
 * V1: first suitable endpoint wins.
 */
export function selectEndpointForRole(role: Role, endpoints: ResolvedEndpoint[]): ResolvedEndpoint | null {
  const capability = ROLE_CAPABILITY[role]
  return endpoints.find(ep => ep.role_suitability.includes(capability)) ?? null
}
