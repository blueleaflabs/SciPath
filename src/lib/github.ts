/**
 * COMMITTING THE ARCHIVE.
 *
 * The published site builds from files in the repository, and the people who
 * publish are students running a club. Asking them to download a zip, unzip
 * it at a repository root, and push was a design that only worked for whoever
 * wrote it. Almost nobody who uses this will have the repository, or git, or
 * a reason to learn either.
 *
 * So the application commits. One commit per record, through the Git Data
 * API, which is six calls and gives a single commit containing every file
 * rather than one commit per file.
 *
 * The cost is a token, and the earlier objection to this was that it is one
 * more secret nobody rotates. That is a maintenance worry and not a reason to
 * put a command line between a student and publishing their work. A
 * fine-grained token scoped to contents on one repository is the smallest
 * thing that does the job.
 *
 * When it is not configured, publishing falls back to the bundle download, so
 * a local checkout with no token still works and nothing is blocked.
 */

export interface RepoFile {
  path: string;
  /** Text is committed as UTF-8; bytes are base64 encoded for the blob API. */
  body: Uint8Array | string;
}

export interface RepoConfig {
  token: string;
  /** owner/name */
  repo: string;
  branch: string;
}

export function repoConfig(env: any): RepoConfig | null {
  const token = env?.GITHUB_TOKEN;
  const repo = env?.GITHUB_REPO;
  if (!token || !repo) return null;
  return { token, repo, branch: env?.GITHUB_BRANCH || 'main' };
}

const API = 'https://api.github.com';

async function call(
  config: RepoConfig,
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<any> {
  const { json, ...rest } = init ?? {};

  const response = await fetch(`${API}/repos/${config.repo}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      /* Required, and a request without one is rejected outright. */
      'User-Agent': 'scipath',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text();
    /* The token is in the request, never in the message. */
    throw new Error(
      `GitHub ${response.status} on ${path}: ${detail.slice(0, 300)}`
    );
  }

  return response.json();
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface CommitResult {
  sha: string;
  url: string;
  files: number;
}

/**
 * One commit, every file, on the configured branch.
 *
 * Blobs, then a tree, then a commit, then move the ref. Doing it file by file
 * through the contents API would be one commit each and a partial publish if
 * the third of five failed.
 */
export async function commitFiles(
  config: RepoConfig,
  message: string,
  files: RepoFile[]
): Promise<CommitResult> {
  if (files.length === 0) throw new Error('nothing to commit');

  const ref = await call(config, `/git/ref/heads/${config.branch}`);
  const headSha = ref.object.sha;

  const head = await call(config, `/git/commits/${headSha}`);
  const baseTree = head.tree.sha;

  const tree = [];
  for (const file of files) {
    const blob =
      typeof file.body === 'string'
        ? await call(config, '/git/blobs', {
            method: 'POST',
            json: { content: file.body, encoding: 'utf-8' },
          })
        : await call(config, '/git/blobs', {
            method: 'POST',
            json: { content: toBase64(file.body), encoding: 'base64' },
          });

    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await call(config, '/git/trees', {
    method: 'POST',
    json: { base_tree: baseTree, tree },
  });

  const commit = await call(config, '/git/commits', {
    method: 'POST',
    json: { message, tree: newTree.sha, parents: [headSha] },
  });

  await call(config, `/git/refs/heads/${config.branch}`, {
    method: 'PATCH',
    json: { sha: commit.sha, force: false },
  });

  return {
    sha: commit.sha,
    url: `https://github.com/${config.repo}/commit/${commit.sha}`,
    files: files.length,
  };
}
