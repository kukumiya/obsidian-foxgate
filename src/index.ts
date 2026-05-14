/**
 * FoxGate 🦊🚪
 * Obsidian Vault MCP Server on Cloudflare Workers
 * 
 * Reads/writes markdown files in a GitHub private repo,
 * exposing them as MCP tools for Claude, RikkaHub, etc.
 * 
 * Architecture:
 *   MCP Client → Worker (<your-worker>.workers.dev/mcp) → GitHub API → Vault repo
 * 
 * By 全一 & 木木 | Omnitopia
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────

interface Env {
  GITHUB_TOKEN: string;       // GitHub Personal Access Token
  GITHUB_OWNER: string;       // GitHub username (e.g. "your-github-username")
  GITHUB_REPO: string;        // Repo name (e.g. "my-obsidian-vault")
  GITHUB_BRANCH?: string;     // Branch name (default: "main")
  FOXGATE_TOKEN: string;      // Bearer token for MCP auth
  VAULT_INSTRUCTIONS?: string; // Optional: describe your vault to the AI (shown at connect time)
}

interface GitHubContent {
  name: string;
  path: string;
  type: "file" | "dir";
  sha: string;
  size?: number;
  content?: string;
  encoding?: string;
}

// ─── GitHub API Helper ───────────────────────────────────

class GitHubVault {
  private token: string;
  private owner: string;
  private repo: string;
  private branch: string;
  private baseUrl: string;

  constructor(env: Env) {
    this.token = env.GITHUB_TOKEN;
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || "main";
    this.baseUrl = `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "FoxGate-MCP/1.0",
      ...(options.headers as Record<string, string> || {}),
    };
    return fetch(url, { ...options, headers });
  }

  /**
   * List files in a directory
   */
  async listDirectory(dirPath: string = ""): Promise<{ name: string; path: string; type: string }[]> {
    const encodedPath = encodeURIComponent(dirPath).replace(/%2F/g, '/');
    const res = await this.request(`/contents/${encodedPath}?ref=${this.branch}`);
    
    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
    }

    const items: GitHubContent[] = await res.json();
    
    if (!Array.isArray(items)) {
      // It's a file, not a directory
      return [{ name: items.name, path: items.path, type: items.type }];
    }

    return items.map(item => ({
      name: item.name,
      path: item.path,
      type: item.type,
    }));
  }

  /**
   * Read a file's content (decoded from base64)
   */
  async readFile(filePath: string): Promise<{ content: string; sha: string }> {
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await this.request(`/contents/${encodedPath}?ref=${this.branch}`);
    
    if (!res.ok) {
      if (res.status === 404) throw new Error(`File not found: ${filePath}`);
      throw new Error(`GitHub API error: ${res.status}`);
    }

    const data: GitHubContent = await res.json();
    
    if (data.type !== "file") {
      throw new Error(`${filePath} is a directory, not a file`);
    }

    // GitHub returns base64-encoded content with newlines
    const content = atob(data.content!.replace(/\n/g, ""));
    // Handle UTF-8 properly
    const bytes = new Uint8Array([...content].map(c => c.charCodeAt(0)));
    const decoded = new TextDecoder("utf-8").decode(bytes);

    return { content: decoded, sha: data.sha };
  }

  /**
   * Write (create or update) a file
   */
  async writeFile(filePath: string, content: string, message?: string): Promise<void> {
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
    
    // Check if file exists to get its SHA
    let sha: string | undefined;
    try {
      const existing = await this.readFile(filePath);
      sha = existing.sha;
    } catch {
      // File doesn't exist, that's fine for creation
    }

    // Encode content to base64 (handling UTF-8)
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    const base64 = btoa(String.fromCharCode(...bytes));

    const body: Record<string, any> = {
      message: message || `FoxGate: update ${filePath}`,
      content: base64,
      branch: this.branch,
    };

    if (sha) {
      body.sha = sha;
    }

    const res = await this.request(`/contents/${encodedPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to write ${filePath}: ${res.status} ${error}`);
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(filePath: string, message?: string): Promise<void> {
    const { sha } = await this.readFile(filePath); // Will throw if not found
    const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, '/');
    
    const res = await this.request(`/contents/${encodedPath}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message || `FoxGate: delete ${filePath}`,
        sha,
        branch: this.branch,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to delete ${filePath}: ${res.status}`);
    }
  }

  /**
   * Search for files containing a query string
   * Uses GitHub Code Search API
   */
  async searchFiles(query: string): Promise<{ path: string; snippet: string }[]> {
    const searchQuery = encodeURIComponent(`${query} repo:${this.owner}/${this.repo}`);
    const res = await fetch(
      `https://api.github.com/search/code?q=${searchQuery}`,
      {
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/vnd.github.v3.text-match+json",
          "User-Agent": "FoxGate-MCP/1.0",
        },
      }
    );

    if (!res.ok) {
      throw new Error(`Search failed: ${res.status}`);
    }

    const data: any = await res.json();
    
    return (data.items || []).slice(0, 10).map((item: any) => {
      const matches = item.text_matches || [];
      const snippet = matches.length > 0 
        ? matches[0].fragment 
        : "(no preview available)";
      return { path: item.path, snippet };
    });
  }

  /**
   * Recursively list all .md files in a directory
   */
  async listNotesRecursive(dirPath: string = ""): Promise<string[]> {
    const encodedPath = dirPath ? encodeURIComponent(dirPath).replace(/%2F/g, '/') : '';
    // Use Git Trees API for recursive listing
    const res = await this.request(`/git/trees/${this.branch}?recursive=1`);
    
    if (!res.ok) {
      throw new Error(`Failed to list tree: ${res.status}`);
    }

    const data: any = await res.json();
    const prefix = dirPath ? dirPath + "/" : "";
    
    return (data.tree || [])
      .filter((item: any) => 
        item.type === "blob" && 
        item.path.endsWith(".md") &&
        (!dirPath || item.path.startsWith(prefix))
      )
      .map((item: any) => item.path);
  }
}

// ─── MCP Server Setup ────────────────────────────────────

function createFoxGateServer(env: Env): McpServer {
  const vault = new GitHubVault(env);
  
  const server = new McpServer({
    name: "FoxGate",
    version: "1.0.0",
  });

  // ── Tool: list_notes ──
  server.tool(
    "list_notes",
    "List notes in the Obsidian vault. Optionally filter by directory path.",
    {
      path: z.string().optional().describe("Directory path to list (e.g. 'Notes/Journal'). Empty for root."),
      recursive: z.boolean().optional().describe("If true, list all .md files recursively. Default: false."),
    },
    async ({ path, recursive }) => {
      try {
        if (recursive) {
          const notes = await vault.listNotesRecursive(path || "");
          return {
            content: [{
              type: "text" as const,
              text: notes.length > 0
                ? `Found ${notes.length} notes:\n${notes.join("\n")}`
                : `No notes found in ${path || "vault root"}`,
            }],
          };
        }

        const items = await vault.listDirectory(path || "");
        const formatted = items.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.name}`).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: items.length > 0
              ? `Contents of ${path || "/"}:\n${formatted}`
              : `Empty directory: ${path || "/"}`,
          }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ── Tool: read_note ──
  server.tool(
    "read_note",
    "Read the content of a note from the Obsidian vault.",
    {
      path: z.string().describe("Path to the note (e.g. 'Notes/2026-04-22.md')"),
    },
    async ({ path }) => {
      try {
        const { content } = await vault.readFile(path);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ── Tool: write_note ──
  server.tool(
    "write_note",
    "Write or update a note in the Obsidian vault. Creates the file if it doesn't exist.",
    {
      path: z.string().describe("Path for the note (e.g. 'Notes/2026-04-22.md')"),
      content: z.string().describe("Full content of the note (Markdown)"),
      message: z.string().optional().describe("Git commit message. Default: 'FoxGate: update <path>'"),
    },
    async ({ path, content, message }) => {
      try {
        await vault.writeFile(path, content, message);
        return {
          content: [{ type: "text" as const, text: `✅ Successfully wrote: ${path}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ── Tool: search_notes ──
  server.tool(
    "search_notes",
    "Search for notes containing specific text in the Obsidian vault.",
    {
      query: z.string().describe("Search query text"),
    },
    async ({ query }) => {
      try {
        const results = await vault.searchFiles(query);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results found for: "${query}"` }] };
        }
        const formatted = results.map(r => `📄 ${r.path}\n   ${r.snippet}`).join("\n\n");
        return {
          content: [{ type: "text" as const, text: `Found ${results.length} results:\n\n${formatted}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ── Tool: delete_note ──
  server.tool(
    "delete_note",
    "Delete a note from the Obsidian vault. Requires exact path confirmation.",
    {
      path: z.string().describe("Path to the note to delete"),
      confirm_path: z.string().describe("Must match 'path' exactly to confirm deletion"),
    },
    async ({ path, confirm_path }) => {
      if (path !== confirm_path) {
        return {
          content: [{ type: "text" as const, text: "❌ Deletion cancelled: confirm_path does not match path." }],
        };
      }
      try {
        await vault.deleteFile(path);
        return {
          content: [{ type: "text" as const, text: `🗑️ Deleted: ${path}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  // ── Tool: append_note ──
  server.tool(
    "append_note",
    "Append content to the end of an existing note. Creates the file if it doesn't exist.",
    {
      path: z.string().describe("Path to the note"),
      content: z.string().describe("Content to append"),
      message: z.string().optional().describe("Git commit message"),
    },
    async ({ path, content: appendContent, message }) => {
      try {
        let existing = "";
        try {
          const file = await vault.readFile(path);
          existing = file.content;
        } catch {
          // File doesn't exist, will create new
        }
        const newContent = existing ? `${existing}\n${appendContent}` : appendContent;
        await vault.writeFile(path, newContent, message || `FoxGate: append to ${path}`);
        return {
          content: [{ type: "text" as const, text: `✅ Appended to: ${path}` }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
      }
    }
  );

  return server;
}

// ─── Worker Entry Point ──────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ──
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "FoxGate 🦊🚪",
        version: "1.0.0",
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
        },
      });
    }

    // ── MCP endpoint ──
    if (url.pathname === "/mcp") {
      // Auth check
      const authHeader = request.headers.get("Authorization");
      const tokenParam = url.searchParams.get("token");
      const providedToken = authHeader?.replace("Bearer ", "") || tokenParam;

      if (!providedToken || providedToken !== env.FOXGATE_TOKEN) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Handle MCP protocol
      if (request.method === "POST") {
        try {
          const body = await request.json() as any;
          const server = createFoxGateServer(env);

          // JSON-RPC handling
          if (body.method === "initialize") {
            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                  tools: {},
                },
                serverInfo: {
                  name: "FoxGate",
                  version: "1.0.0",
                },
                ...(env.VAULT_INSTRUCTIONS ? { instructions: env.VAULT_INSTRUCTIONS } : {}),
              },
            });
          }

          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 204 });
          }

          if (body.method === "tools/list") {
            // Return our tool definitions
            const tools = [
              {
                name: "obsidian_list",
                description: "List files and folders in the Obsidian vault (a personal knowledge base of Markdown notes). Use this to browse the vault structure before reading or writing notes.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Directory path in the Obsidian vault to list. Leave empty to list root folders." },
                    recursive: { type: "boolean", description: "If true, list all .md note files recursively including subfolders. Default: false." },
                  },
                },
              },
              {
                name: "obsidian_read",
                description: "Read the full Markdown content of a note from the Obsidian vault. Use this when you need to see what's written in a specific note. The path must include the .md extension.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Full path to the note file, e.g. 'journal/2026-04-22.md'" },
                  },
                  required: ["path"],
                },
              },
              {
                name: "obsidian_write",
                description: "Create a new note or overwrite an existing note in the Obsidian vault. The content should be in Markdown format. This will create a git commit in the vault's GitHub repository.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Full path for the note file, e.g. 'journal/2026-04-22.md'. Parent directories are created automatically." },
                    content: { type: "string", description: "Full Markdown content of the note" },
                    message: { type: "string", description: "Optional git commit message describing what changed" },
                  },
                  required: ["path", "content"],
                },
              },
              {
                name: "obsidian_search",
                description: "Search for notes in the Obsidian vault that contain specific text. Returns matching file paths and text snippets. Useful for finding notes about a topic.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Text to search for across all notes in the vault" },
                  },
                  required: ["query"],
                },
              },
              {
                name: "obsidian_delete",
                description: "Delete a note from the Obsidian vault. For safety, you must provide the path twice (in both 'path' and 'confirm_path') to confirm deletion.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Path of the note to delete" },
                    confirm_path: { type: "string", description: "Must be identical to 'path' to confirm deletion" },
                  },
                  required: ["path", "confirm_path"],
                },
              },
              {
                name: "obsidian_append",
                description: "Append additional content to the end of an existing note in the Obsidian vault. If the note doesn't exist, it will be created. Useful for adding journal entries, logs, or new sections.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Path to the note to append to" },
                    content: { type: "string", description: "Markdown content to add at the end of the note" },
                    message: { type: "string", description: "Optional git commit message" },
                  },
                  required: ["path", "content"],
                },
              },
            ];

            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools },
            });
          }

          if (body.method === "tools/call") {
            const { name, arguments: args } = body.params;
            const vault = new GitHubVault(env);
            let result: any;

            try {
              switch (name) {
                case "obsidian_list": {
                  if (args?.recursive) {
                    const notes = await vault.listNotesRecursive(args?.path || "");
                    result = notes.length > 0
                      ? `Found ${notes.length} notes:\n${notes.join("\n")}`
                      : `No notes found in ${args?.path || "vault root"}`;
                  } else {
                    const items = await vault.listDirectory(args?.path || "");
                    const formatted = items.map((i: any) => `${i.type === "dir" ? "📁" : "📄"} ${i.name}`).join("\n");
                    result = items.length > 0
                      ? `Contents of ${args?.path || "/"}:\n${formatted}`
                      : `Empty directory: ${args?.path || "/"}`;
                  }
                  break;
                }
                case "obsidian_read": {
                  const file = await vault.readFile(args.path);
                  result = file.content;
                  break;
                }
                case "obsidian_write": {
                  await vault.writeFile(args.path, args.content, args.message);
                  result = `✅ Successfully wrote: ${args.path}`;
                  break;
                }
                case "obsidian_search": {
                  const results = await vault.searchFiles(args.query);
                  if (results.length === 0) {
                    result = `No results found for: "${args.query}"`;
                  } else {
                    result = results.map((r: any) => `📄 ${r.path}\n   ${r.snippet}`).join("\n\n");
                  }
                  break;
                }
                case "obsidian_delete": {
                  if (args.path !== args.confirm_path) {
                    result = "❌ Deletion cancelled: confirm_path does not match path.";
                  } else {
                    await vault.deleteFile(args.path);
                    result = `🗑️ Deleted: ${args.path}`;
                  }
                  break;
                }
                case "obsidian_append": {
                  let existing = "";
                  try {
                    const file = await vault.readFile(args.path);
                    existing = file.content;
                  } catch { /* new file */ }
                  const newContent = existing ? `${existing}\n${args.content}` : args.content;
                  await vault.writeFile(args.path, newContent, args.message || `FoxGate: append to ${args.path}`);
                  result = `✅ Appended to: ${args.path}`;
                  break;
                }
                default:
                  result = `Unknown tool: ${name}`;
              }
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }

            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: result }],
              },
            });
          }

          // Unknown method
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -32601,
              message: `Method not found: ${body.method}`,
            },
          });
        } catch (e: any) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: e.message,
            },
          }, 500);
        }
      }

      // GET /mcp — server info (some clients probe this)
      if (request.method === "GET") {
        return jsonResponse({
          name: "FoxGate",
          version: "1.0.0",
          description: "Obsidian Vault MCP Server by Omnitopia 🦊",
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ── Root ──
    if (url.pathname === "/") {
      return new Response(
        "🦊🚪 FoxGate — Obsidian Vault MCP Server",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Helper ──

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
