// Minimal Jira Cloud REST client (basic auth with an API token). Read-only for now;
// writes (labels, comments) are added with the runner in build step 2.

export function createJira({ site, email, token }) {
  if (!email || !token) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN must be set (copy .env.example to .env)');
  }
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  async function call(method, path, body) {
    const res = await fetch(site + path, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Jira ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    // Issues matching JQL, with the fields the routes need.
    async search(jql) {
      const issues = [];
      let nextPageToken;
      do {
        const page = await call('POST', '/rest/api/3/search/jql', {
          jql,
          fields: ['summary', 'status', 'labels', 'issuelinks'],
          maxResults: 50,
          nextPageToken,
        });
        issues.push(...page.issues);
        nextPageToken = page.nextPageToken;
      } while (nextPageToken);
      return issues;
    },

    // All comments, oldest first. API v2 returns the body as plain text.
    async comments(key) {
      const out = [];
      let startAt = 0;
      for (;;) {
        const page = await call('GET', `/rest/api/2/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
        out.push(...page.comments);
        startAt += page.comments.length;
        if (!page.comments.length || startAt >= page.total) break;
      }
      return out.map((c) => ({ body: c.body || '', created: c.created }));
    },
  };
}
