import type { TokenStore } from '../identity/actor-store'
import { Role } from '../config/types'

// ── Board schema ───────────────────────────────────────────────────────────────
// This is the opaque JSON blob submitted to the server when the team instantiates
// a board. It declares the team's agents, rich statuses, and descriptive dynamics.
// The server stores but never interprets this blob.

export function buildBoardSchema(actors: TokenStore['actors']): object {
  return {
    team: 'ai-crew',
    version: '1.0',

    /**
     * The team roster. Each entry declares an agent actor with display name,
     * title, and the capability tag(s) they carry. The scheduler uses capability
     * tags to route tasks; the server just stores them.
     */
    agents: [
      {
        actor_id: actors[Role.Architect].actorId,
        display_name: 'Architect',
        title: 'Architect',
        capabilities: ['architecture'],
        description: 'Bids on projects and owns the proposal contract. Does not implement.',
      },
      {
        actor_id: actors[Role.Executive].actorId,
        display_name: 'Executive',
        title: 'Executive',
        capabilities: ['planning'],
        description: 'Owns progress toward the proposal. Chooses Stages. Decides done-or-next.',
      },
      {
        actor_id: actors[Role.PM].actorId,
        display_name: 'PM',
        title: 'Project Manager',
        capabilities: ['planning'],
        description: 'Decomposes Stage Specs into Tasks. Revises tasks on escalation.',
      },
      {
        actor_id: actors[Role.Developer].actorId,
        display_name: 'Developer',
        title: 'Developer',
        capabilities: ['coding'],
        description: 'Sole active editor of the codebase. Implements tasks and unit tests.',
      },
      {
        actor_id: actors[Role.Reviewer].actorId,
        display_name: 'Reviewer',
        title: 'Reviewer',
        capabilities: ['review'],
        description: 'Reviews implementations. Approves (squash-merge) or returns for changes.',
      },
      {
        actor_id: actors[Role.Tester].actorId,
        display_name: 'Tester',
        title: 'Tester',
        capabilities: ['testing'],
        description: 'Builds and runs the Stage in-VM. Files bugs or writes the Stage Report.',
      },
      {
        actor_id: actors[Role.Sysadmin].actorId,
        display_name: 'Sysadmin',
        title: 'Systems Administrator',
        capabilities: ['deployment'],
        description: 'Deploys completed Stage builds as live web apps via ai-harbor. Files deployment bugs.',
      },
    ],

    /**
     * Rich status vocabulary beyond the three core statuses (inactive/active/complete).
     * These live in task.resources and are interpreted by the team, not the server.
     */
    statuses: [
      'awaiting_review',
      'changes_requested',
      'in_review',
      'awaiting_test',
      'test_failed',
      'escalated_to_pm',
      'blocked_on_user',
    ],

    /**
     * Descriptive dynamics: human-readable rules describing expected workflow.
     * The server stores these but enforces nothing. These document team conventions
     * for the benefit of agents loading the board schema.
     */
    dynamics: [
      {
        rule: 'coding_tasks_require_review',
        description: 'Tasks with capability "coding" must pass through a Reviewer (review capability) before being marked complete.',
      },
      {
        rule: 'stage_tasks_require_testing',
        description: 'The "test Stage" task must be worked by an agent with testing capability.',
      },
      {
        rule: 'one_active_editor',
        description: 'Only the Developer (coding capability) edits the codebase. All other agents are read-only on git.',
      },
      {
        rule: 'stage_mechanism',
        description: 'Work proceeds in Stages. Each Stage has a planning task (PM), implementation tasks (Developer→Reviewer), and a test task (Tester). Stages are bracketed by the Executive.',
      },
      {
        rule: 'web_stages_require_deployment',
        description: 'Stages producing web applications include a deploy task (Sysadmin) that depends on the test task. The stage is not complete until deployment succeeds or is explicitly skipped.',
      },
    ],
  }
}
