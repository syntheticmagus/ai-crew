/**
 * ai-crew — AI Software Development Team
 *
 * Entry point. Loads config, bootstraps actors, starts the polling loop.
 */

// Load .env file automatically so you can just run `npm run dev` without
// any shell setup. Variables already in the environment take precedence.
import 'dotenv/config'

import { loadConfig } from './config/loader'
import { ActorStore } from './identity/actor-store'
import { ApiClient } from './client/api-client'
import { WorkspaceManager } from './git/workspace-manager'
import { SoftwareTeamProcess } from './process/state-machine'
import { Role, ALL_ROLES } from './config/types'

async function main(): Promise<void> {
  console.log('=== ai-crew: AI Software Development Team ===')

  // ── Step 1: Load configuration ─────────────────────────────────────────────
  console.log('\n[startup] Loading configuration...')
  const config = loadConfig()
  console.log(`[startup] Server: ${config.server.baseUrl}`)
  console.log(`[startup] Work container: ${config.workDir}`)
  console.log(`[startup] Poll interval: ${config.pollIntervalMs}ms`)
  console.log(`[startup] Endpoints: ${config.endpoints.map(e => e.name).join(', ')}`)

  // ── Step 2: Bootstrap actors ───────────────────────────────────────────────
  console.log('\n[startup] Ensuring agent actors are provisioned...')
  const actorStore = new ActorStore(config.tokensFile)
  const tokenStore = await actorStore.ensure(config.server.baseUrl, config.server.userPassword)
  console.log(`[startup] Team: ${tokenStore.teamName}`)
  console.log(`[startup] All agents ready:`)
  for (const role of ALL_ROLES) {
    const record = tokenStore.actors[role]
    console.log(`  ${role}: ${record.displayName} (${record.actorId})`)
  }

  // Inject team identity into config so agents can use their names in prompts.
  config.teamIdentity = {
    teamName: tokenStore.teamName,
    agentPersonalNames: Object.fromEntries(
      ALL_ROLES.map(role => [tokenStore.actors[role].actorId, tokenStore.actors[role].personalName])
    ),
  }

  // ── Step 3: Build per-role API clients ─────────────────────────────────────
  console.log('\n[startup] Building API clients...')
  const clientByRole: Record<Role, ApiClient> = {} as Record<Role, ApiClient>
  for (const role of ALL_ROLES) {
    clientByRole[role] = actorStore.getClient(role, config.server.baseUrl, tokenStore)
  }

  // Also build a user client for operations that require user auth (notifications, etc.)
  // Note: this client is used sparingly — only for things that require user perspective
  const userClient = await ApiClient.loginAsUser(config.server.baseUrl, config.server.userPassword)
  console.log(`[startup] User client authenticated`)

  // ── Step 4: Build workspace manager ───────────────────────────────────────
  console.log(`\n[startup] Initializing workspace container at: ${config.workDir}`)
  const workspaceManager = new WorkspaceManager(config.workDir, config.gitHost)

  // ── Step 5: Start process ──────────────────────────────────────────────────
  console.log('\n[startup] Starting software team process...\n')
  const process = new SoftwareTeamProcess(config, tokenStore, clientByRole, workspaceManager, userClient)

  // Top-level error handler: log and restart after 30s
  while (true) {
    try {
      await process.run()
    } catch (err) {
      console.error('\n[main] Unhandled error — restarting in 30s:', err)
      await sleep(30_000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Surface any promise rejection that escapes the main loop's try/catch so it
// doesn't silently kill the process without a log entry.
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection (process continues):', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception (process continues):', err)
})

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
