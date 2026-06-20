// ── Raw shape from environments.json ──────────────────────────────────────────

/**
 * Optional sampling / inference overrides forwarded verbatim to the
 * OpenAI-compatible completions API.  All fields are optional; omitted fields
 * fall back to whatever the server default is.
 *
 * `extra_body` is a free-form escape hatch for server-specific parameters
 * (e.g. llama.cpp's `chat_template_kwargs: { enable_thinking: true }`).
 */
export type InferenceParams = {
  temperature?: number
  top_p?: number
  max_tokens?: number
  /** Forwarded verbatim into the request body — use for server-specific knobs. */
  extra_body?: Record<string, unknown>
}

export type ModelEndpoint = {
  /** Human-readable name for logging */
  name: string
  /** Base URL for the OpenAI-compatible API */
  base_url: string
  /** Name of the environment variable that holds the API key */
  api_key_env: string
  /** Capability tags this endpoint can serve — must include at least one of the role capability tags */
  role_suitability: string[]
  /** Rough cost per million tokens, for logging/reporting */
  token_cost: { input: number; output: number }
  /** Maximum context window in tokens */
  max_context: number
  /** Optional human notes */
  notes?: string
  /** Optional sampling / inference overrides */
  inference?: InferenceParams
}

// ── Resolved at load time: api_key_env is replaced with the actual key value ───

export type ResolvedEndpoint = Omit<ModelEndpoint, 'api_key_env'> & {
  api_key: string
  /** The model name to pass to the API (defaults to the endpoint name if not specified) */
  model?: string
}

// ── Full runtime configuration ─────────────────────────────────────────────────

export type TeamConfig = {
  server: {
    /** Full base URL of the ai_captain server, e.g. http://localhost:3000 */
    baseUrl: string
    /** Password for the single user account — used only during actor bootstrapping */
    userPassword: string
  }
  /** All model endpoints, with api keys already resolved from environment variables */
  endpoints: ResolvedEndpoint[]
  /** Absolute path to the directory where project repos will be checked out/built */
  workDir: string
  /** Path to the .tokens.json file */
  tokensFile: string
  /** How often to poll the server in milliseconds */
  pollIntervalMs: number
}

// ── Role enum ─────────────────────────────────────────────────────────────────
// Capability tags match the board schema capability declarations.

export enum Role {
  Architect = 'architect',
  Executive = 'executive',
  PM = 'pm',
  Developer = 'developer',
  Reviewer = 'reviewer',
  Tester = 'tester',
}

export const ALL_ROLES: Role[] = [
  Role.Architect,
  Role.Executive,
  Role.PM,
  Role.Developer,
  Role.Reviewer,
  Role.Tester,
]

/** Maps each role to the capability tag it advertises in the board schema. */
export const ROLE_CAPABILITY: Record<Role, string> = {
  [Role.Architect]: 'architecture',
  [Role.Executive]: 'planning',
  [Role.PM]: 'planning',
  [Role.Developer]: 'coding',
  [Role.Reviewer]: 'review',
  [Role.Tester]: 'testing',
}

/** Human-readable display names submitted to the server. */
export const ROLE_DISPLAY_NAME: Record<Role, string> = {
  [Role.Architect]: 'Architect',
  [Role.Executive]: 'Executive',
  [Role.PM]: 'PM',
  [Role.Developer]: 'Developer',
  [Role.Reviewer]: 'Reviewer',
  [Role.Tester]: 'Tester',
}
