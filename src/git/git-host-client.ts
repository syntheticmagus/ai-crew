// ── Git host HTTP client ───────────────────────────────────────────────────────
// Thin helper for talking to the git-host REST API (POST /api/repos).
// All other git communication uses the standard Git Smart HTTP protocol,
// which simple-git handles automatically once the remote URL is set.

/**
 * Sanitize an arbitrary folder name so it is safe to use as a git-host repo name.
 * git-host only allows [A-Za-z0-9_-]; everything else becomes "-".
 * Leading/trailing dashes and runs of dashes are collapsed.
 */
export function sanitizeRepoName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Ensure a repo exists on the git-host server, creating it if necessary.
 * Returns the authenticated HTTP push URL for use as a git remote.
 *
 * Treats HTTP 409 (already exists) as success — idempotent across restarts.
 * Throws on network errors or unexpected HTTP status codes.
 */
export async function ensureGitHostRepo(
  gitHostUrl: string,
  password: string,
  repoName: string,
): Promise<string> {
  const sanitized = sanitizeRepoName(repoName)
  const credentials = Buffer.from(`git:${password}`).toString('base64')

  const response = await fetch(`${gitHostUrl}/api/repos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`,
    },
    body: JSON.stringify({ name: sanitized }),
  })

  if (response.status !== 201 && response.status !== 409) {
    const body = await response.text()
    throw new Error(`git-host returned HTTP ${response.status}: ${body}`)
  }

  // Build authenticated remote URL: http://git:password@host/repo.git
  const baseUrl = new URL(gitHostUrl)
  const pushUrl = `${baseUrl.protocol}//${encodeURIComponent('git')}:${encodeURIComponent(password)}@${baseUrl.host}/${sanitized}.git`
  return pushUrl
}
