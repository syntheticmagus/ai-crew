import * as fs from 'fs'
import * as path from 'path'
import simpleGit from 'simple-git'
import { GitManager } from './git-manager'

// ── WorkspaceManager ───────────────────────────────────────────────────────────
// Manages a container directory whose subdirectories are per-project git repos.
// Each project lives at {workDir}/{slug}-{shortId}/ (or {workDir}/{projectId}/
// for projects without a slug) and has its own isolated git history.
//
// A lightweight index file ({workDir}/.projects.json) maps projectId → folder
// name so that folder names remain stable even when slug is not re-derived.

const INDEX_FILE = '.projects.json'

type ProjectIndex = Record<string, string> // projectId → folder name

export class WorkspaceManager {
  constructor(private readonly workDir: string) {}

  /**
   * Return a GitManager scoped to the project's folder.
   * The folder name is derived from the RFP slug on first call and remembered
   * in .projects.json for subsequent calls.  Pass `slug` on first use (when
   * creating the project); omit on subsequent calls (it is looked up).
   */
  async getOrCreateProjectRepo(projectId: string, slug?: string): Promise<GitManager> {
    // Ensure container root exists
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true })
    }

    const index = this.loadIndex()
    let folderName = index[projectId]

    if (!folderName) {
      // First time we've seen this project — derive and record folder name
      folderName = slug ? `${slug}-${projectId.slice(0, 8)}` : projectId
      index[projectId] = folderName
      this.saveIndex(index)
    }

    const projectPath = path.join(this.workDir, folderName)

    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true })
    }

    // Init repo if no .git directory
    const dotGit = path.join(projectPath, '.git')
    if (!fs.existsSync(dotGit)) {
      const git = simpleGit(projectPath)
      await git.init()
      // Create an empty initial commit so `main` branch exists and task
      // branches can be created off it.
      await git.addConfig('user.email', 'ai-crew@localhost')
      await git.addConfig('user.name', 'AI Crew')
      await git.commit('chore: initial commit', [], { '--allow-empty': null })
      // Ensure we're on `main` (git may have created `master` on older versions)
      const status = await git.status()
      if (status.current && status.current !== 'main') {
        await git.branch(['-m', status.current, 'main'])
      }
      console.log(`[workspace] Initialised new git repo at: ${projectPath}`)
    }

    return new GitManager(projectPath)
  }

  /**
   * Return the container directory path.
   */
  getWorkDir(): string {
    return this.workDir
  }

  // ── Index helpers ────────────────────────────────────────────────────────────

  private loadIndex(): ProjectIndex {
    const indexPath = path.join(this.workDir, INDEX_FILE)
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as ProjectIndex
    } catch {
      return {}
    }
  }

  private saveIndex(index: ProjectIndex): void {
    const indexPath = path.join(this.workDir, INDEX_FILE)
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  }
}
