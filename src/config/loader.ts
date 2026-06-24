import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { ModelEndpoint, ResolvedEndpoint, TeamConfig } from './types'

// ── Zod schema for environments.json ──────────────────────────────────────────

const InferenceParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p:       z.number().min(0).max(1).optional(),
  max_tokens:  z.number().positive().int().optional(),
  extra_body:  z.record(z.unknown()).optional(),
}).optional()

const ModelEndpointSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  role_suitability: z.array(z.string()).min(1),
  token_cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }),
  max_context: z.number().positive(),
  notes: z.string().optional(),
  model: z.string().optional(),
  inference: InferenceParamsSchema,
})

const EnvironmentsSchema = z.array(ModelEndpointSchema).min(1, 'environments.json must contain at least one endpoint')

// ── Loader ─────────────────────────────────────────────────────────────────────

/**
 * Load and validate all runtime configuration.
 * Throws a descriptive error at startup if anything is missing or malformed.
 * Every other module receives a TeamConfig — nothing reads process.env directly.
 */
export function loadConfig(): TeamConfig {
  // ── Required env vars ────────────────────────────────────────────────────
  const serverBaseUrl = requireEnv('SERVER_BASE_URL')
  const serverUserPassword = requireEnv('SERVER_USER_PASSWORD')

  // ── Optional env vars with defaults ──────────────────────────────────────
  const workDir = process.env['WORK_DIR']
    ?? (process.platform === 'win32' ? 'C:\\ai_workspace' : '/home/ai/workspace')

  const tokensFile = process.env['TOKENS_FILE'] ?? path.join(process.cwd(), '.tokens.json')
  const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '60000', 10)
  const environmentsFile = process.env['ENVIRONMENTS_FILE'] ?? path.join(process.cwd(), 'environments.json')

  if (isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(`POLL_INTERVAL_MS must be a number >= 1000 (got ${process.env['POLL_INTERVAL_MS']})`)
  }

  // ── Load and parse environments.json ──────────────────────────────────────
  if (!fs.existsSync(environmentsFile)) {
    throw new Error(
      `Model endpoints config not found at: ${environmentsFile}\n` +
      `Copy environments.example.json to environments.json and fill in your endpoints.\n` +
      `Or set ENVIRONMENTS_FILE to point to your config file.`,
    )
  }

  let rawEndpoints: unknown
  try {
    rawEndpoints = JSON.parse(fs.readFileSync(environmentsFile, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to parse ${environmentsFile}: ${String(err)}`)
  }

  const parseResult = EnvironmentsSchema.safeParse(rawEndpoints)
  if (!parseResult.success) {
    throw new Error(
      `Invalid environments.json:\n${parseResult.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }

  // ── Resolve api_key_env → api_key ──────────────────────────────────────────
  const endpoints: ResolvedEndpoint[] = parseResult.data.map((ep: ModelEndpoint & { model?: string }) => {
    const apiKey = process.env[ep.api_key_env]
    if (!apiKey) {
      throw new Error(
        `Endpoint "${ep.name}" references env var ${ep.api_key_env} which is not set.\n` +
        `Set it in your environment or .env file before starting.`,
      )
    }
    const { api_key_env, ...rest } = ep
    void api_key_env // consumed
    return { ...rest, api_key: apiKey }
  })

  // ── Validate workDir exists (or warn) ────────────────────────────────────
  if (!fs.existsSync(workDir)) {
    console.warn(`[config] WORK_DIR does not exist: ${workDir} — it should be created before the team runs a project`)
  }

  // ── Optional git-host integration ────────────────────────────────────────
  const gitHostUrl = process.env['GIT_HOST_URL']
  const gitHostPassword = process.env['GIT_HOST_PASSWORD']
  if ((gitHostUrl && !gitHostPassword) || (!gitHostUrl && gitHostPassword)) {
    throw new Error('GIT_HOST_URL and GIT_HOST_PASSWORD must both be set, or both omitted.')
  }
  const gitHost = gitHostUrl && gitHostPassword
    ? { url: gitHostUrl, password: gitHostPassword }
    : undefined

  return {
    server: { baseUrl: serverBaseUrl, userPassword: serverUserPassword },
    endpoints,
    workDir,
    tokensFile,
    pollIntervalMs,
    gitHost,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set. See .env.example for details.`)
  }
  return value
}

/**
 * Find the first endpoint that lists the given capability tag as suitable.
 * V1 policy: first match wins.
 */
export function selectEndpoint(endpoints: ResolvedEndpoint[], capability: string): ResolvedEndpoint | null {
  return endpoints.find(ep => ep.role_suitability.includes(capability)) ?? null
}
