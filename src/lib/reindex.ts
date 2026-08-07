/**
 * ASKING FOR A REINDEX.
 *
 * Publishing fires this and does not wait for it. The record is readable the
 * moment it is written; being findable a minute later is the right way round,
 * because a record nobody can find is a nuisance and a record nobody can read
 * is a broken link.
 *
 * A failure here is logged and swallowed for the same reason. The scheduled
 * run catches anything a lost dispatch missed, and refusing to publish
 * because a search index could not be scheduled would be the wrong trade.
 */

export async function requestReindex(env: any, reason: string): Promise<boolean> {
  const token = env?.GITHUB_DISPATCH_TOKEN;
  const repo = env?.GITHUB_REPO;
  if (!token || !repo) return false;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'scipath',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'records-changed',
        client_payload: { reason },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
