import type OpenAI from 'openai'
import type { ApiClient } from '../client/api-client'
import type { TeamConfig } from '../config/types'
import type { GitManager } from '../git/git-manager'
import { buildServerToolDefinitions, dispatchServerTool } from './tools/server-tools'
import { buildDevToolDefinitions, dispatchDevTool } from './tools/dev-tools'

// ── Tool registry ──────────────────────────────────────────────────────────────

/**
 * Build the complete list of OpenAI tool definitions for all agents.
 * Every agent sees every tool; role prompts shape which tools are used.
 */
export function buildTools(
  _client: ApiClient,
  _gitManager: GitManager,
  _config: TeamConfig,
): OpenAI.ChatCompletionTool[] {
  return [
    ...buildServerToolDefinitions(),
    ...buildDevToolDefinitions(),
    ...buildGitManagerToolDefinitions(),
  ]
}

/**
 * Dispatch a tool call to the appropriate implementation.
 * Returns a JSON-serializable result.
 */
export async function dispatchTool(
  call: OpenAI.ChatCompletionMessageToolCall,
  client: ApiClient,
  gitManager: GitManager,
  config: TeamConfig,
): Promise<unknown> {
  const name = call.function.name
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    return { error: `Failed to parse tool arguments for ${name}: ${call.function.arguments}` }
  }

  try {
    // Route to the correct implementation
    if (isServerTool(name)) {
      return await dispatchServerTool(name, args, client)
    }
    if (isGitManagerTool(name)) {
      return await dispatchGitManagerTool(name, args, gitManager)
    }
    if (isDevTool(name)) {
      return await dispatchDevTool(name, args, config, gitManager.getRepoPath())
    }
    return { error: `Unknown tool: ${name}` }
  } catch (err) {
    // Return errors as structured results rather than throwing —
    // the agent should see error messages and decide how to respond.
    return { error: String(err) }
  }
}

// ── Tool routing sets ──────────────────────────────────────────────────────────

const SERVER_TOOLS = new Set([
  'get_project', 'list_proposals', 'create_proposal', 'patch_proposal', 'complete_project',
  'get_board', 'create_task', 'list_tasks', 'get_task', 'patch_task',
  'list_entries', 'post_entry', 'upload_text_attachment', 'get_attachment_content',
])

const GIT_MANAGER_TOOLS = new Set([
  'git_ensure_work_branch', 'git_commit_handoff', 'git_squash_merge_to_main',
  'git_cut_release_tag', 'git_checkout_main', 'git_current_branch',
  'git_reset_to_head',
])

const DEV_TOOLS = new Set([
  'read_file', 'grep_file', 'write_file', 'edit_file', 'delete_file', 'list_directory',
  'run_shell', 'start_background_process', 'stop_process', 'kill_port',
  'git_status', 'git_diff', 'git_log', 'fetch_url',
  'search_codebase', 'clone_repo',
  'harbor_list_apps', 'harbor_register_app', 'harbor_deregister_app',
])

function isServerTool(name: string): boolean { return SERVER_TOOLS.has(name) }
function isGitManagerTool(name: string): boolean { return GIT_MANAGER_TOOLS.has(name) }
function isDevTool(name: string): boolean { return DEV_TOOLS.has(name) }

// ── Git manager tool definitions ───────────────────────────────────────────────
// These are separate from dev-tools because they use the typed GitManager API
// rather than raw shell commands — safer for AI-driven git operations.

function buildGitManagerToolDefinitions(): OpenAI.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'git_ensure_work_branch',
        description: 'Ensure you are on the `work` branch, creating it from main if it does not exist. Call this at the start of every Developer activation before making any changes. Takes no arguments.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_commit_handoff',
        description: 'Stage all changes and create a commit. Call this before handing off the task to the Reviewer. The commit message should describe what was implemented.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message.' },
          },
          required: ['message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_squash_merge_to_main',
        description: 'Squash-merge the `work` branch into main and delete it. The Reviewer calls this after approving implementation. Creates a single clean commit on main.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message for the squash commit on main.' },
          },
          required: ['message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_cut_release_tag',
        description: 'Create a git tag on the current main HEAD. The Tester may call this after writing a successful Stage Report to mark the release point.',
        parameters: {
          type: 'object',
          properties: {
            tag_name: { type: 'string', description: 'Tag name, e.g. "release/stage-1".' },
          },
          required: ['tag_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_checkout_main',
        description: 'Switch to the main branch. Call this when you need to be on main (e.g., before reading the current state of the codebase as a Reviewer or Tester).',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_current_branch',
        description: 'Return the name of the current git branch.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_reset_to_head',
        description: 'Discard all uncommitted changes in the working tree (git checkout -- .). Use this to clean up messy WIP before starting fresh. Committed changes are not affected.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ]
}

async function dispatchGitManagerTool(
  name: string,
  args: Record<string, unknown>,
  gitManager: GitManager,
): Promise<unknown> {
  switch (name) {
    case 'git_ensure_work_branch': {
      const result = await gitManager.ensureWorkBranch()
      return {
        ok: true,
        branch: 'work',
        existed: result.existed,
        note: result.existed ? 'Branch `work` already existed — check git_log() for commits from previous activations before implementing.' : 'New branch `work` created from main.',
      }
    }

    case 'git_commit_handoff':
      await gitManager.commitHandoff(args['message'] as string)
      return { ok: true }

    case 'git_squash_merge_to_main':
      await gitManager.squashMergeToMain(args['message'] as string)
      return { ok: true }

    case 'git_cut_release_tag':
      await gitManager.cutReleaseTag(args['tag_name'] as string)
      return { ok: true, tag: args['tag_name'] }

    case 'git_checkout_main':
      await gitManager.checkoutMain()
      return { ok: true, branch: 'main' }

    case 'git_current_branch': {
      const branch = await gitManager.currentBranch()
      return { branch }
    }

    case 'git_reset_to_head':
      await gitManager.resetToHead()
      return { ok: true }

    default:
      throw new Error(`Unknown git manager tool: ${name}`)
  }
}
