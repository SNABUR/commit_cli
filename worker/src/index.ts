export interface Env {
  DB: D1Database;
  AGENT_SECRET?: string;
}

export interface CommitPayload {
  installation_id?: string;
  repository: string;
  message: string;
  branch?: string;
  commit_hash?: string;
  author?: string;
  platform?: string;
  timestamp?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ status: "ok", service: "commit-agent-worker" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Query endpoint (GET /v1/commits?repo=...&limit=...)
    if (request.method === "GET" && url.pathname === "/v1/commits") {
      const authHeader = request.headers.get("Authorization");
      const clientKey = request.headers.get("X-Agent-Key") || (authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null);
      if (env.AGENT_SECRET && clientKey !== env.AGENT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const repo = url.searchParams.get("repo") || url.searchParams.get("repository");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);

      let query = "SELECT * FROM commit_messages";
      const params: any[] = [];
      if (repo) {
        query += " WHERE repository = ?";
        params.push(repo);
      }
      query += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      try {
        const stmt = env.DB.prepare(query).bind(...params);
        const results = await stmt.all();
        return new Response(JSON.stringify({ success: true, count: results.results?.length ?? 0, commits: results.results }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: "Failed to query database", details: err?.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Commits receiver endpoint (POST /v1/commits)
    if (request.method === "POST" && url.pathname === "/v1/commits") {
      // Optional security header validation
      if (env.AGENT_SECRET) {
        const authHeader = request.headers.get("Authorization");
        const clientKey = request.headers.get("X-Agent-Key") || (authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null);
        if (clientKey !== env.AGENT_SECRET) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      let payload: CommitPayload;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!payload.repository || typeof payload.repository !== "string" || !payload.message || typeof payload.message !== "string") {
        return new Response(JSON.stringify({ error: "Missing required fields: 'repository' and 'message' are required strings" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Extract first line as title if multi-line
      const cleanMessage = payload.message.trim().split(/\r?\n/)[0].trim();
      const installationId = (payload.installation_id && typeof payload.installation_id === "string") ? payload.installation_id.slice(0, 100) : "default";
      const repoName = payload.repository.trim().slice(0, 150);
      const createdAt = payload.timestamp || new Date().toISOString();
      const branch = payload.branch ? String(payload.branch).slice(0, 100) : null;
      const commitHash = payload.commit_hash ? String(payload.commit_hash).slice(0, 64) : null;
      const author = payload.author ? String(payload.author).slice(0, 100) : null;
      const platform = payload.platform ? String(payload.platform).slice(0, 50) : null;

      try {
        await env.DB.prepare(`
          INSERT INTO commit_messages (installation_id, repository, message, branch, commit_hash, author, platform, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          installationId,
          repoName,
          cleanMessage,
          branch,
          commitHash,
          author,
          platform,
          createdAt
        ).run();

        return new Response(JSON.stringify({
          success: true,
          message: "Commit recorded successfully",
          recorded: {
            repository: repoName,
            title: cleanMessage,
            created_at: createdAt
          }
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (dbErr: any) {
        return new Response(JSON.stringify({ error: "Database insertion failed", details: dbErr?.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
