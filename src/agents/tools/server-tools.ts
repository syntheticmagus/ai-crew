import type OpenAI from 'openai'
import type { ApiClient, CreateTaskBody, PatchTaskBody } from '../../client/api-client'

// ── Server tool definitions ────────────────────────────────────────────────────
// These wrap every ApiClient method as an OpenAI tool definition.
// Descriptions are the primary mechanism for teaching agents when to use each tool.

export function buildServerToolDefinitions(): OpenAI.ChatCompletionTool[] {
  return [
    // ── Projects ──────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'get_project',
        description: 'Get details of the current project including its phase, RFP text, and linked proposals/board.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'The project ID.' },
          },
          required: ['project_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_proposals',
        description: 'List all proposals submitted for a project. Use this to see competing bids or your own existing proposal.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
          },
          required: ['project_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_proposal',
        description: 'Submit a new proposal for a project. The Architect uses this to bid on a project for the FIRST TIME. The content field is your full proposal text (markdown). For revisions to an existing proposal, use patch_proposal instead.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            content: { type: 'string', description: 'Full proposal text in markdown.' },
          },
          required: ['project_id', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'patch_proposal',
        description: 'Update the content of your existing proposal in-place. Use this when revising in response to user feedback — the proposal ID and conversation history are preserved. Only works while the project is still soliciting, and only for the original author. After patching, post_entry a reply summarising what changed.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            proposal_id: { type: 'string' },
            content: { type: 'string', description: 'The full revised proposal text in markdown.' },
          },
          required: ['project_id', 'proposal_id', 'content'],
        },
      },
    },
    // complete_project intentionally omitted — that endpoint is user-only (returns 403 for agents).
    // Re-enable here once the server supports AI-initiated project completion.

    // ── Boards ─────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'get_board',
        description: 'Get board metadata including the active schema version.',
        parameters: {
          type: 'object',
          properties: {
            board_id: { type: 'string' },
          },
          required: ['board_id'],
        },
      },
    },
    // ── Tasks ──────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'create_task',
        description: 'Create a new task on the board. ' +
          'PM uses this for implementation tasks (each must depend on the "plan Stage" task) and the "test Stage" task (must depend on ALL implementation tasks). ' +
          'Tester uses this to file bug tasks discovered during Stage testing.',
        parameters: {
          type: 'object',
          properties: {
            board_id: { type: 'string' },
            assignee_actor_id: { type: 'string', description: 'Actor ID of the agent or user to assign this task to.' },
            description: { type: 'string', description: 'Clear description of what this task requires. Be specific about inputs, outputs, and definition of done.' },
            status: {
              type: 'string',
              enum: ['inactive', 'active', 'complete'],
              description: 'Initial status. Default is inactive. Use active only if you want the scheduler to pick it up immediately.',
            },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of task IDs that must be complete before this task can start. Critical for wiring the Stage structure correctly.',
            },
            resources: {
              type: 'object',
              description: 'Opaque JSON blob for team-specific metadata about this task.',
            },
          },
          required: ['board_id', 'assignee_actor_id', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: 'List tasks on the board. ' +
          'Use summary:true for a compact board overview — descriptions are truncated to 300 chars ' +
          'and resources are omitted server-side; ideal for orientation on a large/long-running board. ' +
          'Filter by status to reduce noise further: status:\'inactive\' for work that still needs doing, ' +
          'status:\'active\' for in-flight tasks. ' +
          'Completed tasks always have descriptions truncated to 300 chars even without summary mode. ' +
          'Call get_task for the full record of any individual task.',
        parameters: {
          type: 'object',
          properties: {
            board_id:          { type: 'string' },
            status:            { type: 'string', enum: ['inactive', 'active', 'complete'] },
            assignee_actor_id: { type: 'string' },
            summary:           { type: 'boolean', description: 'Truncate all descriptions to 300 chars and drop resources. Use for board orientation.' },
          },
          required: ['board_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_task',
        description: 'Get full details of a single task including its conversation ID and depends_on list.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'patch_task',
        description: 'Update a task\'s assignee, status, depends_on, description, or resources. ' +
          'Use this to: hand off (change assignee_actor_id), close a task (set status=complete), ' +
          'or add new dependencies (extend depends_on — e.g. Tester adding bug task IDs). ' +
          'IMPORTANT: always call post_entry first so the audit trail explains the change.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            assignee_actor_id: { type: 'string', description: 'Reassign to this actor.' },
            status: { type: 'string', enum: ['inactive', 'active', 'complete'] },
            description: { type: 'string' },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Replace the full depends_on list. To add dependencies, include existing ones plus the new ones.',
            },
            resources: { type: 'object' },
          },
          required: ['task_id'],
        },
      },
    },
    // ── Conversations ──────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'list_entries',
        description: 'Read the conversation history for a task or proposal. Returns all entries in chronological order.',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string' },
          },
          required: ['conversation_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'post_entry',
        description: 'Append a message to a task or proposal conversation. ' +
          'Call this before any state change (task reassignment, status update) to provide audit trail context. ' +
          'This is the primary way agents communicate with each other and with the user.',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string' },
            body: { type: 'string', description: 'Message body in markdown. Be specific and actionable.' },
            state_change_ref: {
              type: 'object',
              description: 'Optional: reference to the state change this entry documents (e.g. { kind: "handoff", from: "developer", to: "reviewer" }).',
            },
          },
          required: ['conversation_id', 'body'],
        },
      },
    },
    // ── Attachments ────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'upload_text_attachment',
        description: 'Attach a text document to a conversation entry. Use this for Stage Specs, Stage Reports, design documents, and other textual artifacts. The entry must exist first (call post_entry, then attach to that entry).',
        parameters: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'ID of the conversation entry to attach to.' },
            filename: { type: 'string', description: 'Filename for the attachment, e.g. "stage-1-spec.md".' },
            content: { type: 'string', description: 'Full text content of the document.' },
          },
          required: ['entry_id', 'filename', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_attachment_content',
        description: 'Download and return the content of an attachment by its ID. Use this to read Stage Specs, Stage Reports, or other documents attached to conversation entries.',
        parameters: {
          type: 'object',
          properties: {
            attachment_id: { type: 'string' },
          },
          required: ['attachment_id'],
        },
      },
    },
  ]
}

// ── Server tool dispatch ───────────────────────────────────────────────────────

export async function dispatchServerTool(
  name: string,
  args: Record<string, unknown>,
  client: ApiClient,
): Promise<unknown> {
  switch (name) {
    case 'get_project': {
      return client.getProject(args['project_id'] as string)
    }
    case 'list_proposals': {
      const res = await client.listProposals(args['project_id'] as string)
      return res.data
    }
    case 'create_proposal': {
      return client.createProposal(
        args['project_id'] as string,
        args['content'] as string,
      )
    }
    case 'patch_proposal': {
      return client.patchProposal(
        args['project_id'] as string,
        args['proposal_id'] as string,
        args['content'] as string,
      )
    }
    case 'complete_project': {
      return client.completeProject(args['project_id'] as string)
    }
    case 'get_board': {
      return client.getBoard(args['board_id'] as string)
    }
    case 'create_task': {
      const body: CreateTaskBody = {
        assignee_actor_id: args['assignee_actor_id'] as string,
        description: args['description'] as string,
        status: args['status'] as 'inactive' | 'active' | 'complete' | undefined,
        depends_on: args['depends_on'] as string[] | undefined,
        resources: args['resources'],
      }
      return client.createTask(args['board_id'] as string, body)
    }
    case 'list_tasks': {
      const summary = args['summary'] as boolean | undefined
      let res = await client.listAllTasks(args['board_id'] as string, undefined, summary)

      // Apply filters — these were built but silently ignored before (listAllTasks
      // didn't receive them).  Post-filter client-side; avoids changing pagination logic.
      if (args['status'])            res = res.filter(t => t.status === args['status'])
      if (args['assignee_actor_id']) res = res.filter(t => t.assigneeActorId === args['assignee_actor_id'])

      // Trim complete-task descriptions — their full specs are historical noise.
      // Active/inactive tasks keep full descriptions; use get_task for full detail on a complete task.
      const COMPLETE_DESC_LIMIT = 300
      res = res.map(t => {
        if (t.status !== 'complete') return t
        const d = t.description
        if (d.length <= COMPLETE_DESC_LIMIT) return t
        return { ...t, description: d.slice(0, COMPLETE_DESC_LIMIT) + `…[+${d.length - COMPLETE_DESC_LIMIT} chars, status: complete]` }
      })

      return res
    }
    case 'get_task': {
      return client.getTask(args['task_id'] as string)
    }
    case 'patch_task': {
      const patch: PatchTaskBody = {}
      if (args['assignee_actor_id'] !== undefined) patch.assignee_actor_id = args['assignee_actor_id'] as string
      if (args['status'] !== undefined) patch.status = args['status'] as string
      if (args['description'] !== undefined) patch.description = args['description'] as string
      if (args['depends_on'] !== undefined) patch.depends_on = args['depends_on'] as string[]
      if (args['resources'] !== undefined) patch.resources = args['resources']
      return client.patchTask(args['task_id'] as string, patch)
    }
    case 'list_entries': {
      const res = await client.listAllEntries(args['conversation_id'] as string)
      return res
    }
    case 'post_entry': {
      return client.postEntry(
        args['conversation_id'] as string,
        args['body'] as string,
        args['state_change_ref'],
      )
    }
    case 'upload_text_attachment': {
      const content = args['content'] as string
      const filename = args['filename'] as string
      const buffer = Buffer.from(content, 'utf-8')
      return client.uploadAttachment(buffer, filename, 'text/markdown', 'entry', args['entry_id'] as string)
    }
    case 'get_attachment_content': {
      const { data, contentType } = await client.getAttachmentContent(args['attachment_id'] as string)
      return { content: data.toString('utf-8'), contentType }
    }
    default:
      throw new Error(`Unknown server tool: ${name}`)
  }
}
