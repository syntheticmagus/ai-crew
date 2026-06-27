import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import type OpenAI from 'openai'
import type { TeamConfig } from '../../config/types'

// ── PID registry ──────────────────────────────────────────────────────────────
// Tracks PIDs spawned by start_background_process so stop_process can safely
// refuse to kill anything the team didn't start itself.
const spawnedPids = new Set<number>()

// ── Dev tool definitions ───────────────────────────────────────────────────────
// These expose filesystem, shell, and reference-web capabilities to agents.
// Usage is shaped by role prompts, not enforced here — all agents see all dev tools.

export function buildDevToolDefinitions(): OpenAI.ChatCompletionTool[] {
  return [
    // ── Filesystem ─────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file\'s contents. ' +
          'Use start_line / end_line to read a specific range — useful when the compiler reports ' +
          'an error at a known line number and you only need to see that area.',
        parameters: {
          type: 'object',
          properties: {
            path:       { type: 'string', description: 'File path (relative to work directory, or absolute).' },
            start_line: { type: 'number', description: 'First line to return (1-indexed, inclusive). Omit for beginning of file.' },
            end_line:   { type: 'number', description: 'Last line to return (1-indexed, inclusive). Omit for end of file.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_file',
        description: 'Search a file for lines matching a regex pattern. ' +
          'Returns matching lines with their 1-indexed line numbers and optional context lines above/below each match. ' +
          'Use instead of read_file when you know the pattern but not the line number.',
        parameters: {
          type: 'object',
          properties: {
            path:          { type: 'string', description: 'File path (relative to work directory, or absolute).' },
            pattern:       { type: 'string', description: 'Regular expression pattern to search for.' },
            context_lines: { type: 'number', description: 'Lines to include before and after each match. Default 0.' },
          },
          required: ['path', 'pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new file (or fully overwrite an existing one). ' +
          'Use for new files and wholesale scaffolding. ' +
          'To make a targeted change to an existing file, use edit_file instead.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to work directory, or absolute).' },
            content: { type: 'string', description: 'Content to write.' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Make a targeted edit to an existing file by replacing an exact substring. ' +
          'Read the file first so you can quote old_content precisely. ' +
          'Fails clearly if old_content is not found or is ambiguous (multiple matches without replace_all).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to work directory, or absolute).' },
            old_content: { type: 'string', description: 'Exact substring to find and replace. Must match the file exactly, including whitespace and indentation.' },
            new_content: { type: 'string', description: 'Replacement text. Pass an empty string to delete the matched region.' },
            replace_all: { type: 'boolean', description: 'If true, replace every occurrence. Default false — errors if the string appears more than once, so you must be more specific.' },
          },
          required: ['path', 'old_content', 'new_content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file. Use with caution.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns file and subdirectory names.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (relative to work directory, or absolute).' },
          },
          required: ['path'],
        },
      },
    },
    // ── Shell ──────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'run_shell',
        description: 'Execute a shell command and return stdout/stderr. ' +
          'Use for: running tests, building projects, installing dependencies, and other dev tasks. ' +
          'The cwd parameter is required and must be within the work directory.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run.' },
            cwd: { type: 'string', description: 'Working directory for the command. Must be within the work directory.' },
            timeout_ms: {
              type: 'number',
              description: 'Timeout in milliseconds. Default is 120000 (2 minutes). Use longer values for builds.',
            },
          },
          required: ['command', 'cwd'],
        },
      },
    },
    // ── Background process management ─────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'start_background_process',
        description: 'Start a long-running process (e.g. a dev server) in the background and return its PID. ' +
          'Use this instead of running a server with & in run_shell. ' +
          'The process keeps running after this call returns; stop it later with stop_process(pid).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to run (e.g. "npm start", "node server.js").' },
            cwd: { type: 'string', description: 'Working directory. Must be within the work directory.' },
            startup_delay_ms: {
              type: 'number',
              description: 'Milliseconds to wait after spawning before returning, so the process can bind its port. Default 1500.',
            },
          },
          required: ['command', 'cwd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_process',
        description: 'Stop a background process by PID. Only works for processes started with start_background_process in this session. ' +
          'To free a port used by a leftover process from a previous run, use kill_port(port) instead.',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'Process ID to terminate (must have been started with start_background_process).' },
          },
          required: ['pid'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'kill_port',
        description: 'Kill whatever process is currently listening on a given TCP port. ' +
          'Use this when a server from a previous run is still occupying a port you need. ' +
          'Has a safety guard — will not kill the team process.',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'TCP port number (1–65535).' },
          },
          required: ['port'],
        },
      },
    },
    // ── Git ────────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'git_status',
        description: 'Show the git status of the repository: current branch, staged/unstaged changes.',
        parameters: {
          type: 'object',
          properties: {
            repo_path: { type: 'string', description: 'Path to the git repository. Defaults to work directory.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'Show uncommitted changes in the working tree (git diff HEAD). Use this to review what you have changed before committing.',
        parameters: {
          type: 'object',
          properties: {
            repo_path: { type: 'string', description: 'Path to the git repository. Defaults to work directory.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_log',
        description: 'Show recent commit history.',
        parameters: {
          type: 'object',
          properties: {
            repo_path: { type: 'string', description: 'Path to the git repository. Defaults to work directory.' },
            count: { type: 'number', description: 'Number of commits to show. Default 10.' },
          },
          required: [],
        },
      },
    },
    // ── Web reference ──────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Fetch the text content of a URL for reference. Use for documentation, package READMEs, and reference material — not for data exfiltration or API calls.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch.' },
          },
          required: ['url'],
        },
      },
    },
    // ── Codebase search ───────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'search_codebase',
        description:
          'Search all source files in the project for lines matching a pattern. ' +
          'Returns file path, line number, and the matching line for each hit. ' +
          'Automatically excludes node_modules, dist, build, and .git. ' +
          'Use this to locate symbols, function names, imports, or usage patterns ' +
          'across the whole project without knowing which file to look in. ' +
          'Prefer this over run_shell(\'grep -r ...\') for multi-file searches.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Regular expression or literal string to search for.',
            },
            glob: {
              type: 'string',
              description: 'Optional glob to restrict which files are searched (e.g. "**/*.ts", "src/**/*.json"). Defaults to common source file types.',
            },
            max_hits: {
              type: 'number',
              description: 'Maximum number of matching lines to return. Default 50.',
            },
          },
          required: ['pattern'],
        },
      },
    },
    // ── Harbor deployment ──────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'harbor_list_apps',
        description: 'List all apps currently registered with ai-harbor (the reverse proxy registry). ' +
          'Use before registering or deregistering to check current state.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'harbor_register_app',
        description: 'Register a running web server with ai-harbor so it becomes accessible through ' +
          'the Caddy reverse proxy. Returns the route path and optional TinyURL. ' +
          'The host (machine IP) is injected automatically — do not pass it. ' +
          'Call this after start_background_process confirms the server is up.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'App name — alphanumeric and hyphens, must start with alphanumeric. ' +
                'Use the project slug (e.g. "my-project-stage1"). Re-registering the same name updates it.',
            },
            port: {
              type: 'number',
              description: 'TCP port the server is listening on locally.',
            },
            description: {
              type: 'string',
              description: 'Optional human-readable description of the deployment.',
            },
          },
          required: ['name', 'port'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'harbor_deregister_app',
        description: 'Remove an app from ai-harbor, unregistering its Caddy route and TinyURL alias. ' +
          'Call this before re-deploying to a new port, or when tearing down a deployment.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'App name to deregister.' },
          },
          required: ['name'],
        },
      },
    },
    // ── Repo initialisation ────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'clone_repo',
        description:
          'Initialise your workspace from an existing git repository (HTTPS URL or absolute local path). ' +
          'Use this when the RFP or task specifies building upon or extending an existing codebase. ' +
          'The source remote is removed after fetching — all work is local-only; no push is possible. ' +
          'Must be called on an empty workspace (before any files have been created). ' +
          'Call this BEFORE git_ensure_work_branch and any file reads. ' +
          'Supports shallow clone (depth=1) for large repos when history is not needed.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Git repository to clone from: an HTTPS URL (https://...) or an absolute local path.',
            },
            branch: {
              type: 'string',
              description: "Branch to check out. Defaults to auto-detecting 'main' then 'master'.",
            },
            shallow: {
              type: 'boolean',
              description: 'Fetch only the latest commit (--depth=1). Faster for large repos. Default false.',
            },
          },
          required: ['url'],
        },
      },
    },
  ]
}

// ── Dev tool dispatch ──────────────────────────────────────────────────────────

export async function dispatchDevTool(
  name: string,
  args: Record<string, unknown>,
  config: TeamConfig,
  /** Effective working directory for this activation (per-project repo path).
   *  Relative file/shell paths are resolved against this, not config.workDir. */
  workDir: string,
): Promise<unknown> {
  switch (name) {
    case 'read_file': {
      const filePath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(filePath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}` }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const startLine = args['start_line'] as number | undefined
      const endLine   = args['end_line']   as number | undefined
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n')
        const from  = (startLine ?? 1) - 1                                      // 0-indexed
        const to    = endLine !== undefined ? endLine : lines.length             // exclusive upper bound
        const slice = lines.slice(from, to)
        const annotated = slice.map((l, i) => `${from + i + 1}\t${l}`).join('\n')
        return { path: filePath, start_line: from + 1, end_line: from + slice.length, content: annotated }
      }
      return { path: filePath, content }
    }

    case 'grep_file': {
      const filePath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(filePath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}` }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines   = content.split('\n')
      let pattern: RegExp
      try {
        pattern = new RegExp(args['pattern'] as string)
      } catch {
        return { error: `Invalid regex: ${args['pattern']}` }
      }
      const ctx = (args['context_lines'] as number | undefined) ?? 0

      const matchIndices = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => pattern.test(line))
        .map(({ i }) => i)

      if (matchIndices.length === 0) {
        return { path: filePath, pattern: args['pattern'], match_count: 0, content: '' }
      }

      // Merge overlapping context windows into contiguous blocks
      const blocks: Array<{ from: number; to: number }> = []
      for (const idx of matchIndices) {
        const from = Math.max(0, idx - ctx)
        const to   = Math.min(lines.length - 1, idx + ctx)
        const last = blocks[blocks.length - 1]
        if (last && from <= last.to + 1) {
          last.to = Math.max(last.to, to)
        } else {
          blocks.push({ from, to })
        }
      }

      const output = blocks
        .map(({ from, to }) =>
          lines.slice(from, to + 1).map((l, i) => `${from + i + 1}\t${l}`).join('\n')
        )
        .join('\n---\n')

      return { path: filePath, pattern: args['pattern'], match_count: matchIndices.length, content: output }
    }

    case 'write_file': {
      const filePath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(filePath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, args['content'] as string, 'utf-8')
      return { ok: true, path: filePath }
    }

    case 'edit_file': {
      const filePath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(filePath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${filePath}. Use write_file to create it.` }
      }
      // Normalize CRLF→LF so the match is line-ending-agnostic.
      // On Windows, fs.readFileSync returns raw \r\n bytes; agents always emit
      // \n in their string arguments.  Without normalization, edit_file fails
      // on every file that has ever been touched by a Windows text editor or
      // git with core.autocrlf=true.
      const oldContent = (args['old_content'] as string).replace(/\r\n/g, '\n')
      const newContent = (args['new_content'] as string).replace(/\r\n/g, '\n')
      const replaceAll = (args['replace_all'] as boolean | undefined) ?? false

      const rawContent = fs.readFileSync(filePath, 'utf-8')
      const current = rawContent.replace(/\r\n/g, '\n')
      const parts = current.split(oldContent)
      const occurrences = parts.length - 1

      if (occurrences === 0) {
        return { error: `old_content not found in ${filePath}. Read the file first to get the exact string (including whitespace and indentation).` }
      }
      if (occurrences > 1 && !replaceAll) {
        return { error: `old_content appears ${occurrences} times in ${filePath}. Pass replace_all: true to replace all, or make old_content more specific.` }
      }

      const updated = parts.join(newContent)
      fs.writeFileSync(filePath, updated, 'utf-8')
      return { ok: true, path: filePath, replacements: occurrences }
    }

    case 'delete_file': {
      const filePath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(filePath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        return { ok: true, deleted: filePath }
      }
      return { ok: false, error: `File not found: ${filePath}` }
    }

    case 'list_directory': {
      const dirPath = resolvePath(args['path'] as string, workDir)
      if (!isWithinWorkDir(dirPath, workDir)) {
        return { error: `Path must be within the project directory: ${workDir}` }
      }
      if (!fs.existsSync(dirPath)) {
        return { error: `Directory not found: ${dirPath}` }
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return {
        path: dirPath,
        entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
      }
    }

    case 'run_shell': {
      const command = args['command'] as string
      // Block all process-kill commands via run_shell.
      // Any process the team starts should be killed with stop_process(pid) or kill_port(port),
      // both of which have safety guards. Allowing raw taskkill/pkill/killall here is how
      // the team ends up killing itself.
      const DANGEROUS_KILL_PATTERNS = [
        /\btaskkill\b/i,
        /\bpkill\b/i,
        /\bkillall\b/i,
        /\bgit\s+push\b/i,
      ]
      if (DANGEROUS_KILL_PATTERNS.some(p => p.test(command))) {
        return {
          error: 'Blocked: use stop_process(pid) or kill_port(port) instead of running ' +
            'taskkill/pkill/killall directly. Those tools have safety guards that prevent ' +
            'accidentally killing the team process. ' +
            'git push is also blocked — all work is local-only; pushing to any remote is not permitted.',
        }
      }
      const cwd = resolvePath(args['cwd'] as string, workDir)
      if (!isWithinWorkDir(cwd, workDir)) {
        return { error: `cwd must be within the project directory: ${workDir}` }
      }
      const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 120_000
      return runShell(command, cwd, timeoutMs)
    }

    case 'start_background_process': {
      const cwd = resolvePath(args['cwd'] as string, workDir)
      if (!isWithinWorkDir(cwd, workDir)) {
        return { error: `cwd must be within the project directory: ${workDir}` }
      }
      const command = args['command'] as string
      const startupDelayMs = (args['startup_delay_ms'] as number | undefined) ?? 1_500

      const child = child_process.spawn(command, [], {
        cwd,
        shell: true,   // resolve npm/node via PATH; returns shell PID
        detached: true, // process group leader — kill /T will reach children
        stdio: 'ignore',
      })
      child.unref() // don't keep the team event loop alive waiting for this

      const pid = child.pid
      if (pid === undefined) {
        return { error: 'Failed to spawn process — no PID assigned.' }
      }

      // Brief pause so the server can bind its port before the caller probes it.
      await sleep(startupDelayMs)

      spawnedPids.add(pid) // register so stop_process will accept this PID
      return { pid, message: `Process started (PID ${pid}). Stop it with stop_process(${pid}).` }
    }

    case 'stop_process': {
      const pid = args['pid'] as number
      if (!Number.isInteger(pid) || pid <= 0) {
        return { error: `Invalid PID: ${pid}` }
      }
      if (pid === process.pid) {
        return { error: 'Blocked: that PID is the team process itself.' }
      }
      if (!spawnedPids.has(pid)) {
        return {
          error: `Blocked: PID ${pid} was not started by start_background_process. ` +
            'Only processes the team explicitly started can be stopped this way. ' +
            'To free a port occupied by a leftover process, use kill_port(port) instead.',
        }
      }
      const result = await killByPid(pid)
      if (result.killed) spawnedPids.delete(pid)
      return result
    }

    case 'kill_port': {
      const port = args['port'] as number
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: `Invalid port: ${port}` }
      }
      return killListeningPid(port)
    }

    case 'git_status': {
      const repoPath = getRepoPath(args['repo_path'], workDir)
      return runShell('git status', repoPath, 10_000)
    }

    case 'git_diff': {
      const repoPath = getRepoPath(args['repo_path'], workDir)
      return runShell('git diff HEAD', repoPath, 10_000)
    }

    case 'git_log': {
      const repoPath = getRepoPath(args['repo_path'], workDir)
      const count = (args['count'] as number | undefined) ?? 10
      return runShell(`git log --oneline -${count}`, repoPath, 10_000)
    }

    case 'fetch_url': {
      const url = args['url'] as string
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'ai-crew/1.0 (reference tool)' },
          signal: AbortSignal.timeout(15_000),
        })
        const text = await res.text()
        // Truncate very large responses
        const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n\n[truncated]' : text
        return { url, status: res.status, content: truncated }
      } catch (err) {
        return { url, error: String(err) }
      }
    }

    case 'search_codebase': {
      const pattern = args['pattern'] as string
      const glob    = args['glob']     as string | undefined
      const maxHits = (args['max_hits'] as number | undefined) ?? 50

      let lineRegex: RegExp
      try {
        lineRegex = new RegExp(pattern)
      } catch {
        return { error: `Invalid regex: ${pattern}` }
      }

      // Directories always excluded from search
      const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '__pycache__'])
      // Default file extensions to include
      const DEFAULT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.py', '.sh'])

      // Compile glob into a path regex if provided
      let globRegex: RegExp | null = null
      if (glob) {
        try {
          const escaped = glob
            .replace(/\\/g, '/')
            .replace(/[.+^${}()|[\]]/g, '\\$&')  // escape regex special chars except * ?
            .replace(/\*\*/g, ' ')           // temporarily replace **
            .replace(/\*/g, '[^/]*')              // * matches within one segment
            .replace(/ /g, '.*')             // ** matches across segments
            .replace(/\?/g, '[^/]')
          globRegex = new RegExp(escaped + '$')
        } catch {
          return { error: `Invalid glob: ${glob}` }
        }
      }

      const hits: Array<{ file: string; line: number; match: string }> = []

      function walkDir(dir: string): void {
        if (hits.length >= maxHits) return
        let entries: fs.Dirent[]
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

        for (const entry of entries) {
          if (hits.length >= maxHits) return
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walkDir(fullPath)
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (!DEFAULT_EXTS.has(ext)) continue
            const relPath = path.relative(workDir, fullPath).replace(/\\/g, '/')
            if (globRegex && !globRegex.test(relPath)) continue
            let content: string
            try { content = fs.readFileSync(fullPath, 'utf-8') } catch { continue }
            const lines = content.split('\n')
            for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
              if (lineRegex.test(lines[i])) {
                hits.push({ file: relPath, line: i + 1, match: lines[i].trim() })
              }
            }
          }
        }
      }

      walkDir(workDir)

      return {
        pattern,
        hit_count: hits.length,
        truncated: hits.length >= maxHits,
        hits,
      }
    }

    case 'clone_repo': {
      const url = args['url'] as string
      const branch = args['branch'] as string | undefined
      const shallow = (args['shallow'] as boolean | undefined) ?? false

      // Validate: only absolute local paths or HTTPS URLs
      if (!url.startsWith('https://') && !path.isAbsolute(url)) {
        return { error: 'url must be an HTTPS URL (https://...) or an absolute local path.' }
      }

      // Ensure workspace is empty — only the .git directory should exist from auto-init
      let existingEntries: string[]
      try {
        existingEntries = fs.readdirSync(workDir).filter(e => e !== '.git')
      } catch {
        return { error: `Cannot read workspace directory: ${workDir}` }
      }
      if (existingEntries.length > 0) {
        const listed = existingEntries.slice(0, 5).join(', ')
        const more = existingEntries.length > 5 ? ` …and ${existingEntries.length - 5} more` : ''
        return {
          error: `clone_repo can only be called on an empty workspace. ` +
            `The workspace already contains: ${listed}${more}`,
        }
      }

      const FETCH_TIMEOUT_MS = 5 * 60_000 // 5 minutes for large repos

      try {
        // Add source as a temporary remote
        const quotedUrl = JSON.stringify(url) // wraps in double-quotes; handles spaces and backslashes
        const addResult = await runShell(`git remote add _source ${quotedUrl}`, workDir, 15_000)
        if (addResult.exitCode !== 0) {
          return { error: `git remote add failed: ${addResult.stderr || addResult.stdout}` }
        }

        // Fetch from source (shallow or full history)
        const fetchCmd = shallow ? 'git fetch --depth=1 _source' : 'git fetch _source'
        const fetchResult = await runShell(fetchCmd, workDir, FETCH_TIMEOUT_MS)
        if (fetchResult.exitCode !== 0) {
          await runShell('git remote remove _source', workDir, 10_000)
          return { error: `git fetch failed: ${fetchResult.stderr || fetchResult.stdout}` }
        }

        // Reset workspace to the target branch
        let resolvedBranch: string
        if (branch) {
          const resetResult = await runShell(`git reset --hard _source/${branch}`, workDir, 30_000)
          if (resetResult.exitCode !== 0) {
            await runShell('git remote remove _source', workDir, 10_000)
            return { error: `Could not reset to branch '${branch}': ${resetResult.stderr}` }
          }
          resolvedBranch = branch
        } else {
          // Auto-detect: try main, fall back to master
          const mainResult = await runShell('git reset --hard _source/main', workDir, 30_000)
          if (mainResult.exitCode === 0) {
            resolvedBranch = 'main'
          } else {
            const masterResult = await runShell('git reset --hard _source/master', workDir, 30_000)
            if (masterResult.exitCode !== 0) {
              await runShell('git remote remove _source', workDir, 10_000)
              return {
                error: "Could not find branch 'main' or 'master'. Specify the branch explicitly via the branch parameter.",
              }
            }
            resolvedBranch = 'master'
          }
        }

        // Remove the remote — prevents any accidental push
        await runShell('git remote remove _source', workDir, 10_000)

        // Confirm with HEAD info
        const headResult = await runShell('git log -1 --format="%H %s"', workDir, 10_000)

        return {
          ok: true,
          branch: resolvedBranch,
          head: headResult.stdout.trim(),
          message: 'Workspace initialised from source repository. Remote removed — all work is local-only, no push is possible.',
        }
      } catch (err) {
        // Best-effort cleanup of the temporary remote
        try { await runShell('git remote remove _source', workDir, 10_000) } catch { /* ignore */ }
        return { error: String(err) }
      }
    }

    case 'harbor_list_apps': {
      if (!config.harbor) return { error: 'Harbor not configured — HARBOR_URL, HARBOR_AUTH_TOKEN, and HARBOR_DEPLOY_HOST are required.' }
      try {
        const res = await fetch(`${config.harbor.url}/api/apps`, {
          headers: { Authorization: `Bearer ${config.harbor.authToken}` },
          signal: AbortSignal.timeout(10_000),
        })
        return await res.json()
      } catch (err) {
        return { error: `Harbor request failed: ${String(err)}` }
      }
    }

    case 'harbor_register_app': {
      if (!config.harbor) return { error: 'Harbor not configured — HARBOR_URL, HARBOR_AUTH_TOKEN, and HARBOR_DEPLOY_HOST are required.' }
      const appName = args['name'] as string
      const appPort = args['port'] as number
      const appDesc = args['description'] as string | undefined
      try {
        const res = await fetch(`${config.harbor.url}/api/apps`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.harbor.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: appName, port: appPort, host: config.harbor.deployHost, description: appDesc }),
          signal: AbortSignal.timeout(15_000),
        })
        return await res.json()
      } catch (err) {
        return { error: `Harbor request failed: ${String(err)}` }
      }
    }

    case 'harbor_deregister_app': {
      if (!config.harbor) return { error: 'Harbor not configured — HARBOR_URL, HARBOR_AUTH_TOKEN, and HARBOR_DEPLOY_HOST are required.' }
      const appName = args['name'] as string
      try {
        const res = await fetch(`${config.harbor.url}/api/apps/${encodeURIComponent(appName)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${config.harbor.authToken}` },
          signal: AbortSignal.timeout(10_000),
        })
        return await res.json()
      } catch (err) {
        return { error: `Harbor request failed: ${String(err)}` }
      }
    }

    default:
      throw new Error(`Unknown dev tool: ${name}`)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolvePath(p: string, workDir: string): string {
  // path.resolve normalises .. components and handles both relative and absolute inputs.
  // For absolute paths it ignores workDir; for relative paths it joins first.
  return path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p))
}

function isWithinWorkDir(targetPath: string, workDir: string): boolean {
  const normalizedTarget = path.resolve(targetPath)
  const normalizedWork = path.resolve(workDir)
  return normalizedTarget === normalizedWork || normalizedTarget.startsWith(normalizedWork + path.sep)
}

function getRepoPath(arg: unknown, workDir: string): string {
  if (typeof arg === 'string' && arg) return resolvePath(arg, workDir)
  return workDir
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function killListeningPid(port: number): Promise<{ killed: boolean; message: string; pid?: number }> {
  // Find the PID listening on the port.
  const netstatCmd = process.platform === 'win32'
    ? `netstat -ano | findstr LISTENING | findstr ":${port} "`
    : `lsof -ti tcp:${port} -sTCP:LISTEN`

  const raw = await new Promise<string>(resolve => {
    child_process.exec(netstatCmd, (_err, stdout) => resolve(stdout ?? ''))
  })

  let pid: number | undefined
  if (process.platform === 'win32') {
    // netstat line ends with the owning PID — grab the last number on any matching line
    const match = raw.trim().split('\n')[0]?.match(/\s(\d+)\s*$/)
    if (match) pid = parseInt(match[1], 10)
  } else {
    pid = parseInt(raw.trim(), 10) || undefined
  }

  if (!pid || !Number.isFinite(pid)) {
    return { killed: false, message: `No process found listening on port ${port}.` }
  }
  if (pid === process.pid) {
    return { killed: false, message: `Blocked: the process on port ${port} is the team process (PID ${pid}).` }
  }
  const result = await killByPid(pid)
  return { ...result, pid }
}

function killByPid(pid: number): Promise<{ killed: boolean; message: string }> {
  return new Promise(resolve => {
    const killCmd = process.platform === 'win32'
      ? `taskkill /PID ${pid} /T /F`   // /T kills the process tree (shell → node child)
      : `kill -- -${pid}`              // negative PID kills the process group on POSIX

    child_process.exec(killCmd, (err) => {
      if (err) {
        resolve({ killed: false, message: `Failed to kill PID ${pid}: ${err.message}` })
      } else {
        resolve({ killed: true, message: `PID ${pid} terminated.` })
      }
    })
  })
}

const MAX_SHELL_STDOUT = 50_000
const MAX_SHELL_STDERR = 10_000

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise(resolve => {
    child_process.exec(command, { cwd, timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout, stderr) => {
      let outTrimmed = (stdout ?? '').trim()
      let errTrimmed = (stderr ?? '').trim()
      if (outTrimmed.length > MAX_SHELL_STDOUT)
        outTrimmed = outTrimmed.slice(0, MAX_SHELL_STDOUT) + `\n[stdout truncated — ${outTrimmed.length} total chars]`
      if (errTrimmed.length > MAX_SHELL_STDERR)
        errTrimmed = errTrimmed.slice(0, MAX_SHELL_STDERR) + `\n[stderr truncated — ${errTrimmed.length} total chars]`
      resolve({
        stdout: outTrimmed,
        stderr: errTrimmed,
        exitCode: err ? (err.code ?? 1) : 0,
      })
    })
  })
}
