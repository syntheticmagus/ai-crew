import OpenAI from 'openai'
import type { ApiClient, Task, ConversationEntry, Proposal } from '../client/api-client'
import type { TeamConfig, InferenceParams } from '../config/types'
import type { GitManager } from '../git/git-manager'
import { buildTools, dispatchTool } from './tool-registry'

// ── Context types for agent activation ────────────────────────────────────────

export type ActivationContext = {
  task: Task
  conversationEntries: ConversationEntry[]
  /** RFP text for the project */
  rfp?: string
  /** Proposal content (if this is a working-phase activation) */
  proposal?: Proposal
  /** Any extra context injected by the subclass or state machine */
  extra?: string
}

// ── AgentHarness ───────────────────────────────────────────────────────────────

/**
 * Abstract base class for all six role agents.
 * Implements the OpenAI tool-call loop (one activation = one task wake-up).
 * Subclasses provide: systemPrompt() and optionally override buildContext().
 */
export abstract class AgentHarness {
  /** Sampling / inference overrides applied to every API call for this agent. */
  private inferenceParams: InferenceParams = {}

  constructor(
    protected readonly actorId: string,
    protected readonly openai: OpenAI,
    protected readonly client: ApiClient,
    protected gitManager: GitManager,
    protected readonly config: TeamConfig,
    protected readonly modelName: string,
  ) {}

  /**
   * Update the git manager used for subsequent activations.
   * Call this before activating an agent that will perform git operations so
   * that it operates on the correct per-project repository.
   * Safe to call between activations — all agents share a single instance, and
   * activations are serialised, so there is no concurrency hazard.
   */
  setGitManager(gm: GitManager): void {
    this.gitManager = gm
  }

  /**
   * Set inference / sampling overrides for this agent.
   * Call this once after construction (e.g. from the state machine) before
   * the first activation.  Safe to update between activations.
   */
  setInferenceParams(params: InferenceParams): void {
    this.inferenceParams = params
  }

  /** Subclasses implement this to provide the role-specific system prompt. */
  protected abstract systemPrompt(): string

  /**
   * Build the user-turn context string passed to the LLM.
   * Subclasses may override to add role-specific context (e.g. Reviewer gets the diff).
   */
  protected async buildContext(ctx: ActivationContext): Promise<string> {
    const lines: string[] = []

    // ── Task description ───────────────────────────────────────────────────
    lines.push(`## Your Task`)
    lines.push(`**Task ID:** ${ctx.task.id}`)
    if (ctx.task.boardId) lines.push(`**Board ID:** ${ctx.task.boardId}`)
    lines.push(`**Status:** ${ctx.task.status}`)
    lines.push(`**Description:**`)
    lines.push(ctx.task.description)
    lines.push('')

    // ── Dependencies ───────────────────────────────────────────────────────
    if (ctx.task.depends_on.length > 0) {
      lines.push(`**Depends on:** ${ctx.task.depends_on.join(', ')}`)
      lines.push('')
    }

    // ── Resources (team_meta etc.) ─────────────────────────────────────────
    if (ctx.task.resources) {
      lines.push(`**Task resources:**`)
      lines.push('```json')
      lines.push(JSON.stringify(ctx.task.resources, null, 2))
      lines.push('```')
      lines.push('')
    }

    // ── Proposal ───────────────────────────────────────────────────────────
    if (ctx.proposal) {
      lines.push(`## Project Proposal (the contract)`)
      lines.push(ctx.proposal.content)
      lines.push('')
    }

    // ── RFP ────────────────────────────────────────────────────────────────
    if (ctx.rfp && !ctx.proposal) {
      lines.push(`## Project RFP`)
      lines.push(ctx.rfp)
      lines.push('')
    }

    // ── Conversation history ───────────────────────────────────────────────
    if (ctx.conversationEntries.length > 0) {
      lines.push(`## Conversation History (${ctx.conversationEntries.length} entries)`)
      for (const entry of ctx.conversationEntries) {
        lines.push(`---`)
        lines.push(`**Author:** ${entry.authorActorId}  **Time:** ${entry.createdAt}`)
        lines.push(entry.body)
        if (entry.attachments.length > 0) {
          lines.push(`*Attachments: ${entry.attachments.map(a => `${a.filename} (${a.id})`).join(', ')}*`)
        }
      }
      lines.push('')
    }

    // ── Extra context ──────────────────────────────────────────────────────
    if (ctx.extra) {
      lines.push(ctx.extra)
    }

    return lines.join('\n')
  }

  /**
   * Load context from the server for a given task.
   * This is the standard context loader; subclasses may augment.
   */
  protected async loadContext(task: Task, proposal?: Proposal, rfp?: string, extra?: string): Promise<ActivationContext> {
    const conversationEntries = task.conversationId
      ? await this.client.listAllEntries(task.conversationId)
      : []
    return { task, conversationEntries, proposal, rfp, extra }
  }

  /**
   * Activate this agent on the given task.
   * One activation = one burst of work (one LLM invocation loop until finish_reason === 'stop').
   */
  async activate(task: Task, proposal?: Proposal, rfp?: string, extra?: string): Promise<void> {
    const ctx = await this.loadContext(task, proposal, rfp, extra)
    const contextText = await this.buildContext(ctx)

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: contextText },
    ]

    await this.runToolLoop(messages)
  }

  /**
   * The core tool-call loop.
   * Calls the LLM, executes tool calls sequentially, feeds results back, repeat.
   * Terminates when finish_reason === 'stop' (agent chose to stop).
   *
   * Verbose mode: set VERBOSE=true (or VERBOSE=1) in the environment to log
   * the agent's reasoning text, full tool arguments, and tool results.
   */
  private async runToolLoop(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
    const tools = buildTools(this.client, this.gitManager, this.config)
    const ACTIVATION_TIMEOUT_MS = 45 * 60 * 1000 // 45 minutes — terminates stuck activations
    const activationStart = Date.now()
    const verbose = process.env['VERBOSE'] === 'true' || process.env['VERBOSE'] === '1'

    while (Date.now() - activationStart < ACTIVATION_TIMEOUT_MS) {
      // Stream the response — keeps the connection alive and lets verbose mode print
      // content tokens as they arrive instead of waiting for the full response.
      // Spread standard inference overrides and extra_body (server-specific knobs like
      // llama.cpp's chat_template_kwargs) into the request — all are optional.
      const { extra_body: extraBody, ...standardParams } = this.inferenceParams
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- extra_body fields are not in OpenAI types
      const stream = await (this.openai.chat.completions.create as (...a: any[]) => any)({
        model: this.modelName,
        messages,
        tools,
        tool_choice: 'auto',
        stream: true,
        ...(standardParams.temperature !== undefined && { temperature: standardParams.temperature }),
        ...(standardParams.top_p       !== undefined && { top_p:       standardParams.top_p }),
        ...(standardParams.max_tokens  !== undefined && { max_tokens:  standardParams.max_tokens }),
        ...(extraBody ?? {}),
      }) as AsyncIterable<OpenAI.ChatCompletionChunk>

      // ── Accumulate stream chunks ──────────────────────────────────────────
      let contentText = ''
      let finishReason: string | null = null
      let contentStarted = false
      const toolCallBuilders = new Map<number, { id: string; name: string; arguments: string }>()

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        // Content tokens — print inline in verbose mode as they arrive
        if (delta.content) {
          if (verbose) {
            if (!contentStarted) { process.stdout.write('  [thought]\n'); contentStarted = true }
            process.stdout.write(delta.content)
          }
          contentText += delta.content
        }

        // Tool call chunks — accumulate by index; id/name arrive in first chunk only
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallBuilders.has(tc.index)) {
              toolCallBuilders.set(tc.index, { id: '', name: '', arguments: '' })
            }
            const b = toolCallBuilders.get(tc.index)!
            if (tc.id) b.id = tc.id
            if (tc.function?.name) b.name += tc.function.name
            if (tc.function?.arguments) b.arguments += tc.function.arguments
          }
        }

        if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
      }

      // End the streamed thought line before any subsequent logging
      if (verbose && contentStarted) process.stdout.write('\n')

      // ── Reconstruct the assistant message from accumulated chunks ─────────
      const toolCalls = toolCallBuilders.size > 0
        ? [...toolCallBuilders.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
        : undefined

      const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: contentText || null,
      }
      if (toolCalls) assistantMessage.tool_calls = toolCalls
      messages.push(assistantMessage)

      // ── Handle finish reason ──────────────────────────────────────────────
      if (finishReason === 'stop') {
        // Agent chose to stop — activation complete
        if (verbose && contentText) {
          console.log(`  [stop] Final response streamed above`)
        }
        break
      }

      if (finishReason === 'tool_calls') {
        const calls = toolCalls ?? []

        // Execute tool calls SEQUENTIALLY — concurrent git ops corrupt repo state
        for (const call of calls) {
          if (verbose) {
            let args: unknown
            try { args = JSON.parse(call.function.arguments) } catch { args = call.function.arguments }
            console.log(`  [tool] ${call.function.name} ${JSON.stringify(args)}`)
          } else {
            console.log(`  [tool] ${call.function.name}`)
          }

          const result = await dispatchTool(call, this.client, this.gitManager, this.config)

          if (verbose) {
            const resultStr = JSON.stringify(result)
            const MAX_RESULT_LOG = 2000
            const truncated = resultStr.length > MAX_RESULT_LOG
              ? resultStr.slice(0, MAX_RESULT_LOG) + `…[+${resultStr.length - MAX_RESULT_LOG} chars]`
              : resultStr
            console.log(`  [result] ${truncated}`)
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          })
        }
        continue
      }

      if (finishReason === 'length') {
        // Hit max_tokens — log and stop to avoid corruption
        console.warn(`  [agent] Hit max_tokens limit during activation`)
        break
      }

      // Unexpected finish reason
      console.warn(`  [agent] Unexpected finish_reason: ${finishReason}`)
      break
    }

    const elapsedMs = Date.now() - activationStart
    if (elapsedMs >= ACTIVATION_TIMEOUT_MS) {
      console.warn(`  [agent] Activation timeout (${Math.round(elapsedMs / 60000)}min) — stopping activation`)
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a pre-configured OpenAI client for a given endpoint.
 */
export function createOpenAIClient(endpoint: { base_url: string; api_key: string }): OpenAI {
  return new OpenAI({
    baseURL: endpoint.base_url,
    apiKey: endpoint.api_key,
  })
}
