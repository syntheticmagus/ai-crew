import * as fs from 'fs'
import * as path from 'path'
import { ApiClient, Actor } from '../client/api-client'
import { Role, ALL_ROLES, ROLE_DISPLAY_NAME } from '../config/types'

// ── Token store shape ──────────────────────────────────────────────────────────

export type ActorRecord = {
  actorId: string
  token: string
  displayName: string
}

export type TokenStore = {
  schemaVersion: 1
  actors: Record<Role, ActorRecord>
}

// ── ActorStore ─────────────────────────────────────────────────────────────────

export class ActorStore {
  constructor(private readonly tokensFile: string) {}

  /** Load the token store from disk. Returns null if the file doesn't exist or is malformed. */
  load(): TokenStore | null {
    if (!fs.existsSync(this.tokensFile)) return null
    try {
      const raw = JSON.parse(fs.readFileSync(this.tokensFile, 'utf-8'))
      if (!this.isValid(raw)) {
        console.warn(`[actor-store] .tokens.json exists but is malformed — will re-bootstrap`)
        return null
      }
      return raw as TokenStore
    } catch {
      console.warn(`[actor-store] Failed to parse .tokens.json — will re-bootstrap`)
      return null
    }
  }

  /** Atomic write: write to .tokens.json.tmp, then rename. */
  save(store: TokenStore): void {
    const tmp = `${this.tokensFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
    fs.renameSync(tmp, this.tokensFile)
    console.log(`[actor-store] Saved actor tokens to ${this.tokensFile}`)
  }

  /**
   * Provision all six agent actors on the server, mint tokens, and save to disk.
   * Requires a user-authenticated ApiClient (the only place user credentials are used).
   *
   * Reuse strategy: before creating a new actor, look for an existing actor with
   * the matching display name. If one is found, mint a fresh token for it rather
   * than creating a duplicate. This keeps actor IDs stable across server resets so
   * task assignments on existing boards remain valid after token expiry.
   *
   * If multiple actors share a display name (accumulated from previous bootstraps
   * before this fix), the most recently created one is chosen — it is the one most
   * recently active and most likely to match existing board data.
   */
  async bootstrap(userClient: ApiClient): Promise<TokenStore> {
    console.log('[actor-store] Bootstrapping agent actors...')

    // Fetch the full actor list once so we can look for reusable IDs.
    let existingActors: Actor[] = []
    try {
      existingActors = await userClient.listActors()
    } catch {
      console.warn('[actor-store] Could not list existing actors — will create fresh ones')
    }

    const actors: Partial<Record<Role, ActorRecord>> = {}

    for (const role of ALL_ROLES) {
      const displayName = ROLE_DISPLAY_NAME[role]

      // Pick the most recently created actor with this display name (if any).
      const existing = existingActors
        .filter(a => a.displayName === displayName)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

      if (existing) {
        console.log(`  Reusing actor: ${displayName} (${existing.id}) — minting fresh token`)
        const { token } = await userClient.createActorToken(existing.id)
        actors[role] = { actorId: existing.id, token, displayName }
      } else {
        console.log(`  Creating actor: ${displayName}`)
        const actor = await userClient.createActor(displayName)
        const { token } = await userClient.createActorToken(actor.id)
        actors[role] = { actorId: actor.id, token, displayName }
        console.log(`  ✓ ${displayName} — actorId: ${actor.id}`)
      }
    }

    const store: TokenStore = {
      schemaVersion: 1,
      actors: actors as Record<Role, ActorRecord>,
    }

    this.save(store)
    return store
  }

  /**
   * Return an ApiClient authenticated as the given role.
   * Throws if the role is not found in the store.
   */
  getClient(role: Role, baseUrl: string, store: TokenStore): ApiClient {
    const record = store.actors[role]
    if (!record) throw new Error(`No actor record for role: ${role}`)
    return ApiClient.asAgent(baseUrl, record.token)
  }

  /**
   * Ensure the store is loaded and tokens are valid, bootstrapping from server if needed.
   * Handles the case where the server database was reset (common in dev): if stored tokens
   * return 401, automatically discards them and re-provisions fresh actors.
   */
  async ensure(serverBaseUrl: string, userPassword: string): Promise<TokenStore> {
    const existing = this.load()
    if (existing) {
      // Validate one token before trusting the whole store
      const testClient = ApiClient.asAgent(serverBaseUrl, existing.actors[Role.Architect].token)
      const valid = await this.validateToken(testClient)
      if (valid) {
        console.log('[actor-store] Loaded existing actor tokens (validated)')
        return existing
      }
      console.log('[actor-store] Stored tokens are stale (server may have been reset) — re-bootstrapping')
    } else {
      console.log('[actor-store] No existing tokens found — bootstrapping from server')
    }

    const userClient = await ApiClient.loginAsUser(serverBaseUrl, userPassword)
    return this.bootstrap(userClient)
  }

  private async validateToken(client: ApiClient): Promise<boolean> {
    try {
      await client.me()
      return true
    } catch {
      return false
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private isValid(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false
    const obj = raw as Record<string, unknown>
    if (obj['schemaVersion'] !== 1) return false
    if (typeof obj['actors'] !== 'object' || obj['actors'] === null) return false
    const actors = obj['actors'] as Record<string, unknown>
    for (const role of ALL_ROLES) {
      const record = actors[role]
      if (!record || typeof record !== 'object') return false
      const r = record as Record<string, unknown>
      if (typeof r['actorId'] !== 'string' || typeof r['token'] !== 'string') return false
    }
    return true
  }
}
