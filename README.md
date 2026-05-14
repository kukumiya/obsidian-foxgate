# FoxGate 🦊🚪

> Access your Obsidian vault from anywhere — phone, tablet, or any MCP client.
> Zero cost. Zero servers to maintain. Always online.

English | [中文](./README_CN.md)

A lightweight MCP server deployed on Cloudflare Workers that gives AI (Claude, RikkaHub, etc.) 24/7 read/write access to your Obsidian vault via GitHub API.

## Why

Local MCP servers work great on desktop, but they need your computer to stay online. That means:

- Leave the house → connection drops
- Tools like Tailscale help, but steal your VPN slot on Android
- No way to use Claude mobile app with a local MCP

FoxGate solves this by putting the MCP server in the cloud (Cloudflare Workers), reading/writing your vault through GitHub API. Your computer can be off. It just works.

## Architecture

```
Phone (Claude app / RikkaHub / any MCP client)
         │
         │ HTTPS (Streamable HTTP)
         ▼
Cloudflare Worker (your-domain.com/mcp)
         │
         │ GitHub REST API (token auth)
         ▼
GitHub Private Repo (your vault)
         │
         │ Obsidian Git plugin (auto pull/push)
         ▼
Your computer / phone Obsidian (local mirror)
```

## Features

- **6 MCP tools**: `obsidian_list`, `obsidian_read`, `obsidian_write`, `obsidian_append`, `obsidian_search`, `obsidian_delete`
- **Bearer token auth** — simple and effective
- **Stateless** — no database, no Durable Objects, runs on Workers Free plan
- **Every write is a git commit** — built-in version history, accidental deletes recoverable
- **Custom domain support** — point your own subdomain to the Worker

## Cost

| Item | Cost |
|------|------|
| Cloudflare Workers Free | $0 (100k requests/day) |
| GitHub Free | $0 (unlimited private repos) |
| **Total** | **$0/month** |

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/Omnitopia/foxgate.git
cd foxgate
npm install
```

### 2. Configure secrets

You need 4 secrets. Run each command and paste the value when prompted:

```bash
# GitHub Personal Access Token (needs 'repo' scope)
# Generate at: https://github.com/settings/tokens
npx wrangler secret put GITHUB_TOKEN

# Your GitHub username
npx wrangler secret put GITHUB_OWNER

# Your vault repository name
npx wrangler secret put GITHUB_REPO

# Auth token for MCP access (generate a random one)
# Example: openssl rand -hex 32
npx wrangler secret put FOXGATE_TOKEN
```

> First time running `wrangler`? It will open your browser to log in to Cloudflare.

### 3. Deploy

```bash
npm run deploy
```

Test it:
```bash
curl https://foxgate.<your-account>.workers.dev/health
# Should return: {"status":"ok","service":"FoxGate 🦊🚪","version":"1.0.0"}
```

### 4. Custom domain (optional)

1. Cloudflare Dashboard → Workers & Pages → `foxgate`
2. Settings → Domains & Routes → Add → Custom Domain
3. Enter your subdomain (e.g. `foxgate.yourdomain.com`)
4. Wait a few minutes for DNS propagation

### 5. Connect your MCP client

**RikkaHub (Android):**
- Transport: Streamable HTTP
- URL: `https://your-domain.com/mcp?token=YOUR_FOXGATE_TOKEN`

**Claude app (iOS/Android):**
1. Open **claude.ai** on desktop
2. Settings → Connectors → Add Custom Connector
3. Name: `FoxGate`
4. URL: `https://your-domain.com/mcp?token=YOUR_FOXGATE_TOKEN`
5. Settings sync to mobile automatically

**Claude Desktop (via mcp-remote):**
```json
{
  "mcpServers": {
    "foxgate": {
      "command": "npx",
      "args": ["mcp-remote@latest", "https://your-domain.com/mcp?token=YOUR_FOXGATE_TOKEN"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `obsidian_list` | List files and folders in the vault |
| `obsidian_read` | Read a note's content |
| `obsidian_write` | Create or overwrite a note |
| `obsidian_append` | Append content to a note |
| `obsidian_search` | Full-text search across notes |
| `obsidian_delete` | Delete a note (requires confirmation) |

## Prerequisites

- A GitHub account with your Obsidian vault in a private repo (use [Obsidian Git](https://github.com/denolehov/obsidian-git) plugin to sync)
- A Cloudflare account (free)
- Node.js installed on your computer

## FAQ

**Q: Is my data safe?**
Your vault stays in your private GitHub repo. The Worker only accesses it via your personal GitHub token. Bearer token auth prevents unauthorized MCP access.

**Q: What if I delete something by accident?**
Every write goes through GitHub as a git commit. You can always revert via git history.

**Q: Does it work with other AI apps besides Claude?**
Yes — any app that supports remote MCP via Streamable HTTP can connect.

**Q: Can I use this without a custom domain?**
Yes. Cloudflare gives you a free `*.workers.dev` domain automatically.

## License

MIT

## Credits

Built with 🦊 by [Omnitopia](https://github.com/Omnitopia)
