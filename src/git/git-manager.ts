import * as fs from 'fs'
import * as path from 'path'
import simpleGit, { SimpleGit } from 'simple-git'

// ── GitManager ─────────────────────────────────────────────────────────────────
// Wraps simple-git behind a typed, role-aware interface.
// Only uses simple-git's typed API — never raw() with agent-supplied strings.
// The SimpleGit instance is created lazily on first use so that startup does not
// crash if WORK_DIR doesn't exist yet (it won't until the first project is run).

export class GitManager {
  private _git: SimpleGit | null = null

  constructor(
    private readonly repoPath: string,
    private readonly pushRemoteUrl?: string,
  ) {}

  private get git(): SimpleGit {
    if (!this._git) {
      if (!fs.existsSync(this.repoPath)) {
        throw new Error(
          `WORK_DIR does not exist: ${this.repoPath}\n` +
          `Create it and initialise a git repo before the team can work on a project:\n` +
          `  mkdir "${this.repoPath}" && cd "${this.repoPath}" && git init`,
        )
      }
      this._git = simpleGit(this.repoPath)
    }
    return this._git
  }

  /**
   * Ensure the working tree is on the shared `work` branch, creating it from main if needed.
   * Safe to call on resume — if the branch already exists, just checks it out.
   * Using a fixed branch name avoids UUID hallucination: neither the Developer nor the
   * Reviewer needs to recall or reproduce any task ID as a branch name.
   */
  async ensureWorkBranch(): Promise<{ existed: boolean }> {
    const summary = await this.git.branchLocal()

    if (summary.all.includes('work')) {
      await this.git.checkout('work')
      return { existed: true }
    } else {
      await this.git.checkout('main')
      await this.git.checkoutLocalBranch('work')
      return { existed: false }
    }
  }

  /**
   * Delete the `work` branch (e.g. for a PM-requested blast_branch reset).
   * Force-deletes even if it has unmerged commits. No-op if the branch doesn't exist.
   */
  async deleteWorkBranch(): Promise<void> {
    try {
      await this.git.checkout('main')
      await this.git.deleteLocalBranch('work', true)
    } catch {
      // Branch may not exist — that's fine
    }
  }

  /**
   * Stage all changes and commit.
   * Used by the Developer before handing off to the Reviewer.
   */
  async commitHandoff(message: string): Promise<void> {
    await this.git.add('.')
    await this.git.commit(message)
  }

  /**
   * Squash-merge the `work` branch into main, then delete it.
   * The Reviewer calls this after approving implementation.
   * Asserts the branch has at least one commit beyond main before merging.
   */
  async squashMergeToMain(commitMessage: string): Promise<void> {
    const branchName = 'work'

    // Verify the branch exists
    const summary = await this.git.branchLocal()
    if (!summary.all.includes(branchName)) {
      throw new Error(`Branch '${branchName}' does not exist — cannot squash-merge`)
    }

    // Verify there are commits ahead of main
    const log = await this.git.log({ from: 'main', to: branchName })
    if (log.total === 0) {
      throw new Error(`Branch '${branchName}' has no commits ahead of main — nothing to merge`)
    }

    // Checkout main, squash merge, commit
    await this.git.checkout('main')
    await this.git.merge([branchName, '--squash'])
    await this.git.commit(commitMessage)

    // Delete the work branch so the next task starts fresh
    await this.git.deleteLocalBranch(branchName, true)

    if (this.pushRemoteUrl) {
      try {
        await this.git.push(this.pushRemoteUrl, 'main')
        console.log('[git-host] pushed main')
      } catch (err) {
        console.warn('[git-host] push main failed:', err)
      }
    }
  }

  /**
   * Create a git tag on the current HEAD of main.
   * The Tester may call this after writing a successful Stage Report.
   */
  async cutReleaseTag(tagName: string): Promise<void> {
    // Validate tag name doesn't contain dangerous characters
    if (!/^[a-zA-Z0-9/_.-]+$/.test(tagName)) {
      throw new Error(`Invalid tag name: ${tagName}. Use only alphanumeric characters, /, _, ., -`)
    }
    await this.git.checkout('main')
    await this.git.addTag(tagName)

    if (this.pushRemoteUrl) {
      try {
        await this.git.pushTags(this.pushRemoteUrl)
        console.log(`[git-host] pushed tag ${tagName}`)
      } catch (err) {
        console.warn('[git-host] push tags failed:', err)
      }
    }
  }

  /**
   * Return uncommitted changes as a diff string.
   */
  async getDiff(): Promise<string> {
    return this.git.diff(['HEAD'])
  }

  /**
   * Discard all uncommitted changes (git checkout -- .).
   * Committed changes are not affected.
   */
  async resetToHead(): Promise<void> {
    await this.git.checkout(['.'])
  }

  /**
   * Switch to the main branch.
   */
  async checkoutMain(): Promise<void> {
    await this.git.checkout('main')
  }

  /**
   * Return the name of the current branch.
   */
  async currentBranch(): Promise<string> {
    const status = await this.git.status()
    return status.current ?? 'unknown'
  }

  /**
   * Return true if the working tree has uncommitted changes.
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status()
    return !status.isClean()
  }

  /**
   * Return the repo path this manager operates on.
   */
  getRepoPath(): string {
    return this.repoPath
  }
}
