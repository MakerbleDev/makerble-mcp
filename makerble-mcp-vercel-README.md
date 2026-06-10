# Makerble MCP Server — Vercel Deployment

Connects Claude, ChatGPT, and other AI assistants directly to Makerble. Exposes **37 tools** covering the full Makerble API.

Non-technical users get their personal link from **`/connect`** — no curl, no config files, no tokens to hunt down.

---

## Files in this folder

| File | Purpose |
|---|---|
| `server.js` | Express HTTP server — routing, auth, /connect page |
| `makerble-tools.js` | All 37 Makerble API tool definitions |
| `package.json` | Dependencies |
| `vercel.json` | Vercel routing config |
| `.gitignore` | Keeps secrets and node_modules out of git |

---

## Deployment (Abdulsalam)

### Step 1 — Push to GitHub

Create a new private repo called `makerble-mcp`, drop these 5 files in, and push:

```bash
git init
git add .
git commit -m "Makerble MCP server"
git remote add origin https://github.com/YOUR_ORG/makerble-mcp.git
git push -u origin main
```

### Step 2 — Deploy on Vercel

1. [vercel.com](https://vercel.com) → **Add New Project** → import the `makerble-mcp` repo
2. Framework preset: **Other**
3. Add one environment variable before deploying:

   | Name | Value |
   |---|---|
   | `MAKERBLE_BASE_URL` | `https://makerble.com/api/v2` |

   > No email or token needed — users supply their own credentials via the `/connect` page.

4. Click **Deploy**

The server will be live at e.g. `https://makerble-mcp.vercel.app`.

Verify by visiting `https://makerble-mcp.vercel.app/` — you should see a JSON health check.

---

## How end users connect (non-technical)

Share this URL with users: **`https://makerble-mcp.vercel.app/connect`**

They:
1. Enter their Makerble email and password
2. Copy their personal MCP link
3. Paste it into their AI assistant (instructions shown on the page)

That's it. No curl, no config files, no IT support needed (except for Copilot — see below).

---

## Per-platform connection instructions

### Claude (claude.ai — easiest)
Settings → Integrations → Add integration → Custom MCP → paste the link.

### Claude Desktop app
Settings → Integrations → paste the link.
Or add to `claude_desktop_config.json` (for IT-managed setups):
```json
{
  "mcpServers": {
    "makerble": {
      "type": "streamable-http",
      "url": "https://makerble-mcp.vercel.app/mcp?email=USER_EMAIL&token=USER_TOKEN"
    }
  }
}
```

### ChatGPT (Plus / Pro)
Settings → Apps → Create app → Remote MCP → paste the link.
Requires Developer Mode enabled (Settings → Connectors → Advanced → Developer Mode).

### Microsoft Copilot
Requires an IT admin to configure in Copilot Studio. Share the `/connect` page link with the IT team; they use the user's personal MCP URL to set up a declarative agent.

### Gemini
Currently requires a developer. Share the `/connect` page link with the IT team.

---

## Authentication — how it works

Three credential sources are checked in order:

| Priority | Source | Used by |
|---|---|---|
| 1 | `X-Makerble-Email` + `X-Makerble-Token` headers | Claude Code, programmatic clients |
| 2 | `?email=...&token=...` query params | Personal URLs from `/connect` page |
| 3 | `MAKERBLE_EMAIL` + `MAKERBLE_TOKEN` env vars | Single-org fallback / local dev |

Credentials are never stored on the server. The token lives in the user's personal URL only.

---

## Local development

```bash
npm install
node server.js
```

Server runs on `http://localhost:3000`.
Visit `http://localhost:3000/connect` to test the UI.

---

## Updating

Push any change to `main` and Vercel redeploys automatically.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/connect` page shows "Invalid email or password" | User should check their Makerble credentials at makerble.com |
| AI assistant says tools are unavailable | Check the MCP URL includes `?email=` and `?token=` parameters |
| 401 errors from Makerble API | User's token may be stale — have them revisit `/connect` to generate a new link |
| Vercel deploy fails | Check the build log; ensure `package.json` has `"type": "module"` |
