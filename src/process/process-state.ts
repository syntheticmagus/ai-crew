import * as fs from 'fs/promises'

// ── Process state persistence ──────────────────────────────────────────────────
// Saves the multi-project registry to .process-state.json so the team can
// resume all in-flight work after a kill/restart without losing track of any
// project. Pattern mirrors actor-store.ts: atomic write via tmp → rename.
//
// Schema v2 replaces the v1 single-project schema. Any v1 file is discarded
// on load (the team will re-discover projects from the server).

const STATE_FILE     = '.process-state.json'
const STATE_FILE_TMP = '.process-state.json.tmp'

export type ProjectRecord = {
  /** 'bidding'    — Architect has submitted a proposal, awaiting selection.
   *  'working'    — Board is active; team is executing tasks.
   *  'monitoring' — Executive declared the project complete; watching for
   *                 user activity before the user formally closes it. */
  state: 'bidding' | 'working' | 'monitoring'
  proposalId: string | null
  boardId: string | null
  /** Changelog cursor (ISO timestamp). null = first tick; initialised on first poll. */
  lastChangelogSince: string | null
  /** Set when Executive posts a "## Project Complete" declaration. */
  projectCompletionDeclared: boolean
  /** Short human-readable slug derived from the project RFP (e.g. "build-a-todo-app").
   *  Combined with the first 8 chars of projectId to form the workspace folder name.
   *  undefined for projects recovered from state files written before this field existed. */
  slug?: string
  /** Pre-formatted markdown summary of the changelog events that re-promoted this project
   *  from 'monitoring' back to 'working'. Injected as `extra` context when the Executive
   *  is woken for post-completion re-engagement, then cleared. Persisted so it survives
   *  restarts between re-promotion and the Executive's first activation. */
  reengagementContext?: string
}

export type ProcessStateFile = {
  schemaVersion: 2
  /** All projects the team is currently tracking, keyed by projectId. */
  projects: Record<string, ProjectRecord>
  /** The project being actively worked on right now (may be null when idle). */
  currentWorkProjectId: string | null
}

export async function saveProcessState(data: Omit<ProcessStateFile, 'schemaVersion'>): Promise<void> {
  const payload: ProcessStateFile = { schemaVersion: 2, ...data }
  await fs.writeFile(STATE_FILE_TMP, JSON.stringify(payload, null, 2), 'utf-8')
  await fs.rename(STATE_FILE_TMP, STATE_FILE)
}

export async function loadProcessState(): Promise<ProcessStateFile | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as ProcessStateFile
    if (parsed.schemaVersion !== 2) return null
    return parsed
  } catch {
    return null
  }
}

export async function clearProcessState(): Promise<void> {
  try { await fs.unlink(STATE_FILE) } catch { /* already gone — ignore */ }
}
