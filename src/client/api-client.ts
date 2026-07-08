import * as crypto from 'crypto'

// ── Types (mirrors server Prisma models) ───────────────────────────────────────

export type Actor = {
  id: string; kind: 'user' | 'agent'; displayName: string
  createdAt: string; updatedAt: string
}
export type Project = {
  id: string; phase: 'soliciting' | 'board_active' | 'done'
  rfp: string; selectedProposalId: string | null; boardId: string | null
  createdAt: string; updatedAt: string
}
export type Proposal = {
  id: string; projectId: string; authorAgentId: string; content: string
  teamName?: string; conversationId: string; createdAt: string; updatedAt: string
}
export type Board = {
  id: string; projectId: string; teamAgentId: string; activeSchemaVersion: number
  createdAt: string; updatedAt: string
}
export type BoardSchema = { boardId: string; version: number; schema: unknown; createdAt: string }
export type Task = {
  id: string; boardId: string; assigneeActorId: string
  status: 'inactive' | 'active' | 'complete'
  description: string; resources: unknown; conversationId: string
  depends_on: string[]; createdAt: string; updatedAt: string
}
export type ConversationEntry = {
  id: string; conversationId: string; authorActorId: string; body: string
  stateChangeRef: unknown; createdAt: string; attachments: Attachment[]
}
export type Attachment = {
  id: string; ownerKind: 'entry' | 'rfp'; ownerId: string
  kind: 'text' | 'audio' | 'file'; filename: string; contentType: string
  byteSize: number; storageKey: string; createdAt: string
}
export type Notification = {
  id: string; actorId: string; kind: 'task_assigned' | 'project_done'
  payload: unknown; read: boolean; createdAt: string; updatedAt: string
}
export type PagedResponse<T> = { data: T[]; next_cursor: string | null; total: number }

// ── Changelog types (mirrors reference-team/src/client.ts) ────────────────────

export type TaskCreatedEvent   = { type: 'task_created';   timestamp: string; task_id: string; assignee_actor_id: string; description: string; status: 'inactive' | 'active' | 'complete'; depends_on: string[] }
export type TaskUpdatedEvent   = { type: 'task_updated';   timestamp: string; task_id: string; assignee_actor_id: string; description: string; status: 'inactive' | 'active' | 'complete'; depends_on: string[] }
export type EntryAddedEvent    = { type: 'entry_added';    timestamp: string; entry_id: string; task_id: string | null; conversation_id: string; author_actor_id: string; body: string; state_change_ref: unknown | null }
export type SchemaUpdatedEvent = { type: 'schema_updated'; timestamp: string; version: number }
export type ChangelogEvent     = TaskCreatedEvent | TaskUpdatedEvent | EntryAddedEvent | SchemaUpdatedEvent
export type BoardChangelog     = { data: ChangelogEvent[]; next_since: string | null }

export type CreateTaskBody = {
  assignee_actor_id: string
  description: string
  status?: 'inactive' | 'active' | 'complete'
  depends_on?: string[]
  resources?: unknown
}
export type PatchTaskBody = {
  assignee_actor_id?: string
  status?: string
  description?: string
  depends_on?: string[]
  resources?: unknown
}

// ── Auth types ─────────────────────────────────────────────────────────────────

type Auth =
  | { type: 'user'; cookie: string }
  | { type: 'bearer'; token: string }

// ── ApiError ───────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message)
  }
}

// ── PollCursor ─────────────────────────────────────────────────────────────────
// Tracks the latest updatedAt seen across list calls, for incremental polling.

export class PollCursor {
  private since = new Date(0).toISOString()

  advance(items: { updatedAt: string }[]): void {
    const latest = items.reduce(
      (max, i) => (i.updatedAt > max ? i.updatedAt : max),
      this.since,
    )
    this.since = latest
  }

  get value(): string {
    return this.since
  }

  reset(): void {
    this.since = new Date(0).toISOString()
  }
}

// ── ApiClient ──────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] // exponential backoff, max 3 retries

export class ApiClient {
  constructor(readonly baseUrl: string, private auth: Auth) {}

  static async loginAsUser(baseUrl: string, password: string): Promise<ApiClient> {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      redirect: 'manual',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, body, `Login failed: ${res.status}`)
    }
    const cookie = res.headers.get('set-cookie') ?? ''
    return new ApiClient(baseUrl, { type: 'user', cookie })
  }

  static asAgent(baseUrl: string, token: string): ApiClient {
    return new ApiClient(baseUrl, { type: 'bearer', token })
  }

  private authHeaders(): Record<string, string> {
    if (this.auth.type === 'user') {
      return { Cookie: this.auth.cookie }
    }
    return { Authorization: `Bearer ${this.auth.token}` }
  }

  async apiFetch<T>(path: string, init?: RequestInit & { skipContentType?: boolean }): Promise<T> {
    const { skipContentType, ...fetchInit } = init ?? {}
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers as Record<string, string> ?? {}),
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1]
        const jitter = Math.random() * 0.25 * delay
        await sleep(delay + jitter)
      }

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...fetchInit,
          headers,
          redirect: 'manual',
        })

        if (res.status === 204) return undefined as T

        // Retry on 5xx server errors
        if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
          const body = await res.json().catch(() => ({}))
          lastError = new ApiError(res.status, body, `${init?.method ?? 'GET'} ${path} → ${res.status} (will retry)`)
          continue
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new ApiError(res.status, body, `${init?.method ?? 'GET'} ${path} → ${res.status}`)
        }

        return res.json() as Promise<T>
      } catch (err) {
        if (err instanceof ApiError) throw err // non-retriable 4xx
        // Network error — retry
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt >= RETRY_DELAYS_MS.length) break
      }
    }

    throw lastError ?? new Error(`${init?.method ?? 'GET'} ${path} failed after retries`)
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  me(): Promise<Actor> {
    return this.apiFetch('/auth/me')
  }

  // ── Actors ─────────────────────────────────────────────────────────────────

  createActor(displayName: string): Promise<Actor> {
    return this.apiFetch('/api/actors', {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    })
  }

  patchActorDisplayName(actorId: string, displayName: string): Promise<Actor> {
    return this.apiFetch(`/api/actors/${actorId}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: displayName }),
    })
  }

  createActorToken(actorId: string): Promise<{ token: string }> {
    return this.apiFetch(`/api/actors/${actorId}/tokens`, { method: 'POST', body: JSON.stringify({}) })
  }

  listActors(): Promise<Actor[]> {
    return this.apiFetch('/api/actors')
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  createProject(rfp: string): Promise<Project> {
    return this.apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ rfp }),
    })
  }

  listProjects(params?: Record<string, string>): Promise<PagedResponse<Project>> {
    return this.apiFetch('/api/projects?' + new URLSearchParams(params))
  }

  /** Convenience: poll for open RFPs the Architect should assess. */
  listSolicitingProjects(updatedSince?: string): Promise<PagedResponse<Project>> {
    const params: Record<string, string> = { phase: 'soliciting' }
    if (updatedSince) params['updated_since'] = updatedSince
    return this.listProjects(params)
  }

  getProject(id: string): Promise<Project> {
    return this.apiFetch(`/api/projects/${id}`)
  }

  patchProject(id: string, rfp: string): Promise<Project> {
    return this.apiFetch(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rfp }),
    })
  }

  listProposals(projectId: string, params?: Record<string, string>): Promise<PagedResponse<Proposal>> {
    return this.apiFetch(`/api/projects/${projectId}/proposals?` + new URLSearchParams(params))
  }

  createProposal(projectId: string, content: string, teamName?: string): Promise<Proposal> {
    return this.apiFetch(`/api/projects/${projectId}/proposals`, {
      method: 'POST',
      body: JSON.stringify({ content, ...(teamName ? { team_name: teamName } : {}) }),
    })
  }

  patchProposal(projectId: string, proposalId: string, content: string): Promise<Proposal> {
    return this.apiFetch(`/api/projects/${projectId}/proposals/${proposalId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    })
  }

  selectProposal(projectId: string, proposalId: string): Promise<Project> {
    return this.apiFetch(`/api/projects/${projectId}/select`, {
      method: 'POST',
      body: JSON.stringify({ proposal_id: proposalId }),
    })
  }

  completeProject(projectId: string): Promise<Project> {
    return this.apiFetch(`/api/projects/${projectId}/complete`, { method: 'POST', body: JSON.stringify({}) })
  }

  deleteProject(projectId: string): Promise<void> {
    return this.apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' })
  }

  createBoard(projectId: string, schema: unknown): Promise<Board> {
    return this.apiFetch(`/api/projects/${projectId}/board`, {
      method: 'POST',
      body: JSON.stringify({ schema }),
    })
  }

  // ── Boards ─────────────────────────────────────────────────────────────────

  getBoard(id: string): Promise<Board> {
    return this.apiFetch(`/api/boards/${id}`)
  }

  /**
   * Unified activity feed since a timestamp. Pass `next_since` back as `since` on the next call.
   * Replaces N+1 per-poll fetches: one call returns task_created, task_updated, entry_added,
   * and schema_updated events merged in chronological order.
   */
  getBoardChangelog(boardId: string, since: string, params?: { limit?: number }): Promise<BoardChangelog> {
    const q = new URLSearchParams({ since })
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    return this.apiFetch(`/api/boards/${boardId}/changelog?${q}`)
  }

  getBoardSchema(boardId: string, version?: number): Promise<BoardSchema> {
    const q = version !== undefined ? `?version=${version}` : ''
    return this.apiFetch(`/api/boards/${boardId}/schema${q}`)
  }

  putBoardSchema(boardId: string, schema: unknown): Promise<BoardSchema> {
    return this.apiFetch(`/api/boards/${boardId}/schema`, {
      method: 'PUT',
      body: JSON.stringify({ schema }),
    })
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  createTask(boardId: string, body: CreateTaskBody): Promise<Task> {
    return this.apiFetch(`/api/boards/${boardId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  listTasks(boardId: string, params?: Record<string, string>): Promise<PagedResponse<Task>> {
    return this.apiFetch(`/api/boards/${boardId}/tasks?` + new URLSearchParams(params))
  }

  /** Fetch all tasks on a board, paginating through all pages. */
  async listAllTasks(boardId: string, updatedSince?: string, summary?: boolean): Promise<Task[]> {
    const tasks: Task[] = []
    let cursor: string | null = null
    do {
      const params: Record<string, string> = { limit: '1000' }
      if (updatedSince) params['updated_since'] = updatedSince
      if (summary)      params['summary'] = 'true'
      if (cursor)       params['cursor'] = cursor
      const page = await this.listTasks(boardId, params)
      tasks.push(...page.data)
      cursor = page.next_cursor
    } while (cursor !== null)
    return tasks
  }

  getTask(id: string): Promise<Task> {
    return this.apiFetch(`/api/tasks/${id}`)
  }

  patchTask(id: string, patch: PatchTaskBody): Promise<Task> {
    return this.apiFetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  listEntries(convId: string, params?: Record<string, string>): Promise<PagedResponse<ConversationEntry>> {
    return this.apiFetch(`/api/conversations/${convId}/entries?` + new URLSearchParams(params))
  }

  /** Fetch all entries for a conversation, paginating through all pages. */
  async listAllEntries(convId: string): Promise<ConversationEntry[]> {
    const entries: ConversationEntry[] = []
    let cursor: string | null = null
    do {
      const params: Record<string, string> = { limit: '1000' }
      if (cursor) params['cursor'] = cursor
      const page = await this.listEntries(convId, params)
      entries.push(...page.data)
      cursor = page.next_cursor
    } while (cursor !== null)
    return entries
  }

  postEntry(convId: string, body: string, stateChangeRef?: unknown): Promise<ConversationEntry> {
    return this.apiFetch(`/api/conversations/${convId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ body, state_change_ref: stateChangeRef }),
    })
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async uploadAttachment(
    file: Buffer,
    filename: string,
    contentType: string,
    ownerKind: 'entry' | 'rfp',
    ownerId: string,
  ): Promise<Attachment> {
    const boundary = `----FormBoundary${crypto.randomBytes(8).toString('hex')}`
    const CRLF = '\r\n'

    const fieldPart = (name: string, value: string) =>
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      )

    const filePart = Buffer.concat([
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
        `Content-Type: ${contentType}${CRLF}${CRLF}`,
      ),
      file,
      Buffer.from(CRLF),
    ])

    const body = Buffer.concat([
      fieldPart('owner_kind', ownerKind),
      fieldPart('owner_id', ownerId),
      fieldPart('kind', contentType.startsWith('audio/') ? 'audio' : contentType.startsWith('text/') ? 'text' : 'file'),
      fieldPart('filename', filename),
      fieldPart('content_type', contentType),
      filePart,
      Buffer.from(`--${boundary}--${CRLF}`),
    ])

    return this.apiFetch('/api/attachments', {
      method: 'POST',
      body,
      skipContentType: true,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    })
  }

  getAttachment(id: string): Promise<Attachment> {
    return this.apiFetch(`/api/attachments/${id}`)
  }

  async getAttachmentContent(id: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}/content`, {
      headers: this.authHeaders(),
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new ApiError(res.status, {}, `GET /api/attachments/${id}/content → ${res.status}`)
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const data = Buffer.from(await res.arrayBuffer())
    return { data, contentType }
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  listNotifications(params?: Record<string, string>): Promise<PagedResponse<Notification>> {
    return this.apiFetch('/api/notifications?' + new URLSearchParams(params))
  }

  markRead(id: string): Promise<Notification> {
    return this.apiFetch(`/api/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) })
  }

  // ── Raw fetch (for diagnostics / tests that expect non-2xx) ───────────────

  async rawFetch(path: string, init?: RequestInit & { skipContentType?: boolean }): Promise<{ status: number; body: unknown }> {
    const { skipContentType, ...fetchInit } = init ?? {}
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers as Record<string, string> ?? {}),
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...fetchInit, headers, redirect: 'manual' })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
