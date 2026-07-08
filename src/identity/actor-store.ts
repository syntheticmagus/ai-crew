import * as fs from 'fs'
import { ApiClient, Actor } from '../client/api-client'
import { Role, ALL_ROLES, ROLE_DISPLAY_NAME } from '../config/types'
import { generateIdentity } from './name-generator'

// ── Token store shape ──────────────────────────────────────────────────────────

export type ActorRecord = {
  actorId: string
  token: string
  displayName: string
  personalName: string
}

export type TokenStore = {
  schemaVersion: 2
  teamName: string
  actors: Record<Role, ActorRecord>
}

/** Legacy shape written before identity generation was introduced. */
type LegacyTokenStore = {
  schemaVersion: 1
  actors: Record<Role, { actorId: string; token: string; displayName: string }>
}

// ── ActorStore ─────────────────────────────────────────────────────────────────

export class ActorStore {
  constructor(private readonly tokensFile: string) {}

  /** Load the token store from disk. Returns null if the file doesn't exist or is malformed. */
  load(): TokenStore | LegacyTokenStore | null {
    if (!fs.existsSync(this.tokensFile)) return null
    try {
      const raw = JSON.parse(fs.readFileSync(this.tokensFile, 'utf-8'))
      if (!this.isValid(raw)) {
        console.warn(`[actor-store] .tokens.json exists but is malformed — will re-bootstrap`)
        return null
      }
      return raw as TokenStore | LegacyTokenStore
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
   * Provision all agent actors on the server, mint tokens, and save to disk.
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

    const { teamName, agentNames } = generateIdentity(ALL_ROLES)
    console.log(`[actor-store] Team identity: ${teamName}`)

    // Fetch the full actor list once so we can look for reusable IDs.
    let existingActors: Actor[] = []
    try {
      existingActors = await userClient.listActors()
    } catch {
      console.warn('[actor-store] Could not list existing actors — will create fresh ones')
    }

    const actors: Partial<Record<Role, ActorRecord>> = {}

    for (const role of ALL_ROLES) {
      const personalName = agentNames[role]
      const displayName = `${personalName} (${ROLE_DISPLAY_NAME[role]}) · ${teamName}`

      // Pick the most recently created actor with this display name (if any).
      // On re-bootstrap we use the rich display name, so we won't accidentally reuse
      // old anonymous actors — they'd have a different displayName format.
      const existing = existingActors
        .filter(a => a.displayName === displayName)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

      if (existing) {
        console.log(`  Reusing actor: ${displayName} (${existing.id}) — minting fresh token`)
        const { token } = await userClient.createActorToken(existing.id)
        actors[role] = { actorId: existing.id, token, displayName, personalName }
      } else {
        console.log(`  Creating actor: ${displayName}`)
        const actor = await userClient.createActor(displayName)
        const { token } = await userClient.createActorToken(actor.id)
        actors[role] = { actorId: actor.id, token, displayName, personalName }
        console.log(`  ✓ ${displayName} — actorId: ${actor.id}`)
      }
    }

    const store: TokenStore = {
      schemaVersion: 2,
      teamName,
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
   *
   * If a v1 (legacy) store is found, generates identity and patches actor displayNames on
   * the server before returning, upgrading the file to v2 in place.
   */
  async ensure(serverBaseUrl: string, userPassword: string): Promise<TokenStore> {
    const existing = this.load()
    if (existing) {
      // Validate one token before trusting the whole store
      const testClient = ApiClient.asAgent(serverBaseUrl, existing.actors[Role.Architect].token)
      const valid = await this.validateToken(testClient)
      if (valid) {
        if (existing.schemaVersion === 1) {
          console.log('[actor-store] Upgrading v1 token store to v2 (adding team identity)...')
          return await this.upgradeToV2(existing, serverBaseUrl)
        }
        console.log(`[actor-store] Loaded existing actor tokens (validated) — Team: ${existing.teamName}`)
        return existing
      }
      console.log('[actor-store] Stored tokens are stale (server may have been reset) — re-bootstrapping')
    } else {
      console.log('[actor-store] No existing tokens found — bootstrapping from server')
    }

    const userClient = await ApiClient.loginAsUser(serverBaseUrl, userPassword)
    return this.bootstrap(userClient)
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Upgrade a v1 store to v2: generate identity, patch actor displayNames on the server,
   * and save the enriched store.
   */
  private async upgradeToV2(legacy: LegacyTokenStore, serverBaseUrl: string): Promise<TokenStore> {
    const { teamName, agentNames } = generateIdentity(ALL_ROLES)
    console.log(`[actor-store] Generated identity for upgrade: ${teamName}`)

    const actors: Partial<Record<Role, ActorRecord>> = {}

    for (const role of ALL_ROLES) {
      const old = legacy.actors[role]
      const personalName = agentNames[role]
      const displayName = `${personalName} (${ROLE_DISPLAY_NAME[role]}) · ${teamName}`

      // Each agent patches its own displayName using its own bearer token.
      try {
        const agentClient = ApiClient.asAgent(serverBaseUrl, old.token)
        await agentClient.patchActorDisplayName(old.actorId, displayName)
        console.log(`  Updated displayName: ${old.displayName} → ${displayName}`)
      } catch (err) {
        console.warn(`  Could not patch displayName for ${role}: ${err}`)
      }

      actors[role] = { actorId: old.actorId, token: old.token, displayName, personalName }
    }

    const store: TokenStore = {
      schemaVersion: 2,
      teamName,
      actors: actors as Record<Role, ActorRecord>,
    }

    this.save(store)
    return store
  }

  private async validateToken(client: ApiClient): Promise<boolean> {
    try {
      await client.me()
      return true
    } catch {
      return false
    }
  }

  private isValid(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false
    const obj = raw as Record<string, unknown>
    const ver = obj['schemaVersion']
    if (ver !== 1 && ver !== 2) return false
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
