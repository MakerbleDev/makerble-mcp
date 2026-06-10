/**
 * server.js — Makerble MCP HTTP Server
 *
 * Authentication — three sources checked in order of priority:
 *   1. Request headers:  X-Makerble-Email + X-Makerble-Token  (programmatic / Claude Code)
 *   2. Query parameters: ?email=...&token=...                  (personal URL from /connect page)
 *   3. Environment vars: MAKERBLE_EMAIL + MAKERBLE_TOKEN       (single-org fallback / local dev)
 *
 * Endpoints:
 *   GET  /          — health check
 *   GET  /connect   — self-service web UI for non-technical users to get their personal MCP URL
 *   POST /auth      — JSON endpoint called by the /connect page (email+password → token+URL)
 *   POST /mcp       — Streamable HTTP transport (MCP spec 2025-03-26)
 *   GET  /sse       — Legacy SSE stream (MCP spec 2024-11-05)
 *   POST /messages  — Legacy SSE message endpoint
 *
 * Environment variables (Vercel dashboard):
 *   MAKERBLE_BASE_URL — optional, defaults to https://makerble.com/api/v2
 *   MAKERBLE_EMAIL    — optional org-wide fallback email
 *   MAKERBLE_TOKEN    — optional org-wide fallback token
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { makeApiClient, buildTools, registerTools } from "./makerble-tools.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL  = process.env.MAKERBLE_BASE_URL || "https://makerble.com/api/v2";
const ENV_EMAIL = process.env.MAKERBLE_EMAIL    || "";
const ENV_TOKEN = process.env.MAKERBLE_TOKEN    || "";
const PORT      = process.env.PORT              || 3000;

// ─── Credential resolution ────────────────────────────────────────────────────
// Called per-request so each user's credentials are isolated.

function resolveCredentials(req) {
  // 1. Headers (programmatic clients / Claude Code)
  const headerEmail = req.headers["x-makerble-email"];
  const headerToken = req.headers["x-makerble-token"];
  if (headerEmail && headerToken) {
    return { email: headerEmail, token: headerToken, source: "headers" };
  }

  // 2. Query params (personal URL from /connect page)
  const queryEmail = req.query.email;
  const queryToken = req.query.token;
  if (queryEmail && queryToken) {
    return { email: queryEmail, token: queryToken, source: "query" };
  }

  // 3. Environment variables (org-wide fallback / local dev)
  if (ENV_EMAIL && ENV_TOKEN) {
    return { email: ENV_EMAIL, token: ENV_TOKEN, source: "env" };
  }

  return null;
}

// ─── MCP Server factory ───────────────────────────────────────────────────────
// Creates a fresh Server instance per session with credentials scoped to that user.

function createMcpServer(email, token) {
  const api    = makeApiClient(BASE_URL, email, token);
  const tools  = buildTools(api);
  const server = new Server(
    { name: "makerble-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  registerTools(server, tools);
  return server;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Session store: sessionId → { transport, email, token }
const sessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// Favicon — Makerble shield SVG (used by Claude as the connector icon)
// ─────────────────────────────────────────────────────────────────────────────

const SHIELD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 136">
  <defs>
    <clipPath id="shield">
      <path d="M60 4 L114 32 L114 90 Q114 120 60 132 Q6 120 6 90 L6 32 Z"/>
    </clipPath>
  </defs>
  <!-- Shield outline -->
  <path d="M60 4 L114 32 L114 90 Q114 120 60 132 Q6 120 6 90 L6 32 Z"
        fill="white" stroke="#1e3a5f" stroke-width="6"/>
  <!-- Coloured dots -->
  <circle cx="60"  cy="20"  r="5.5" fill="#e91e8c"/>
  <circle cx="74"  cy="23"  r="5.5" fill="#c2185b"/>
  <circle cx="86"  cy="32"  r="5.5" fill="#9c27b0"/>
  <circle cx="92"  cy="46"  r="5.5" fill="#673ab7"/>
  <circle cx="90"  cy="61"  r="5.5" fill="#1976d2"/>
  <circle cx="82"  cy="74"  r="5.5" fill="#0288d1"/>
  <circle cx="69"  cy="82"  r="5.5" fill="#00897b"/>
  <circle cx="51"  cy="82"  r="5.5" fill="#43a047"/>
  <circle cx="38"  cy="74"  r="5.5" fill="#7cb342"/>
  <circle cx="30"  cy="61"  r="5.5" fill="#f9a825"/>
  <circle cx="28"  cy="46"  r="5.5" fill="#fb8c00"/>
  <circle cx="34"  cy="32"  r="5.5" fill="#e53935"/>
  <circle cx="46"  cy="23"  r="5.5" fill="#f06292"/>
  <!-- M lettermark -->
  <text x="60" y="70" text-anchor="middle"
        font-family="Arial,sans-serif" font-weight="700" font-size="30"
        fill="#c2185b">M</text>
</svg>`;

app.get("/favicon.svg", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(SHIELD_SVG);
});

app.get("/favicon.ico", (_req, res) => res.redirect(301, "/favicon.svg"));

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "Makerble MCP Server",
    version: "1.0.0",
    status: "ok",
    endpoints: {
      connect:        "GET  /connect  — get your personal MCP URL (no technical knowledge needed)",
      streamableHttp: "POST /mcp      — MCP Streamable HTTP transport",
      sseStream:      "GET  /sse      — MCP legacy SSE transport",
      sseMessages:    "POST /messages — MCP legacy SSE messages",
    },
    auth: "Pass credentials via headers (X-Makerble-Email / X-Makerble-Token), " +
          "query params (?email=&token=), or set MAKERBLE_EMAIL / MAKERBLE_TOKEN env vars.",
    docs: "https://app.swaggerhub.com/apis/makerble/makerble-api/2.0.0",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /connect — self-service page for non-technical users
// ─────────────────────────────────────────────────────────────────────────────

app.get("/connect", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connect to Makerble — AI Integration</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Quicksand", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      color: #1a1a2e;
    }

    /* ── Full-width header ── */
    .site-header {
      width: 100%;
      background: #fff;
      border-bottom: 1px solid #e8eaed;
      padding: 0 32px;
      height: 64px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .site-header a {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
    }

    .site-header img {
      height: 40px;
      width: auto;
      display: block;
    }

    /* ── Page body ── */
    .page-body {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 24px;
    }

    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      width: 100%;
      max-width: 480px;
      padding: 40px;
    }

    h1 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .subtitle {
      font-size: 15px;
      color: #555;
      margin-bottom: 28px;
      line-height: 1.5;
    }

    label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #333;
    }

    input {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #dde1e9;
      border-radius: 8px;
      font-size: 15px;
      font-family: "Quicksand", sans-serif;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 18px;
      background: #fafbfc;
    }

    input:focus { border-color: #0d6efd; background: #fff; }

    button {
      width: 100%;
      padding: 13px;
      background: #0d6efd;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      font-family: "Quicksand", sans-serif;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }

    button:hover:not(:disabled) { background: #0b5ed7; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }

    .error {
      margin-top: 16px;
      padding: 12px 14px;
      background: #fff0f0;
      border: 1px solid #ffc5c5;
      border-radius: 8px;
      color: #c0392b;
      font-size: 14px;
      display: none;
    }

    .result {
      margin-top: 24px;
      display: none;
    }

    .result h2 {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #1a7a4a;
    }

    .result p {
      font-size: 14px;
      color: #555;
      margin-bottom: 14px;
      line-height: 1.5;
    }

    .url-box {
      position: relative;
      margin-bottom: 18px;
    }

    .url-display {
      width: 100%;
      padding: 11px 44px 11px 14px;
      border: 1.5px solid #b7e4c7;
      border-radius: 8px;
      font-size: 13px;
      background: #f0fdf4;
      color: #1a1a2e;
      word-break: break-all;
      font-family: "SF Mono", "Fira Code", "Fira Mono", monospace;
      line-height: 1.5;
      white-space: pre-wrap;
      cursor: text;
      min-height: 48px;
    }

    .copy-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      width: 32px;
      height: 32px;
      padding: 0;
      background: #fff;
      border: 1.5px solid #b7e4c7;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s;
      flex-shrink: 0;
    }

    .copy-btn:hover { background: #f0fdf4; }
    .copy-btn svg { width: 16px; height: 16px; stroke: #1a7a4a; }
    .copy-btn.copied { background: #dcfce7; border-color: #86efac; }

    .security-note {
      display: flex;
      gap: 10px;
      padding: 12px 14px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 8px;
      font-size: 13px;
      color: #78350f;
      line-height: 1.5;
      margin-bottom: 18px;
    }

    .security-note svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      margin-top: 1px;
      stroke: #b45309;
    }

    .regen-btn {
      background: none;
      color: #0d6efd;
      border: 1.5px solid #0d6efd;
      margin-top: 4px;
      font-size: 14px;
      padding: 10px;
    }

    .regen-btn:hover:not(:disabled) { background: #f0f6ff; }

    .platforms {
      margin-top: 20px;
    }

    .platforms h3 {
      font-size: 14px;
      font-weight: 700;
      color: #333;
      margin-bottom: 12px;
    }

    .platform {
      margin-bottom: 14px;
    }

    .platform-name {
      font-size: 13px;
      font-weight: 600;
      color: #444;
      margin-bottom: 4px;
    }

    .platform-steps {
      font-size: 13px;
      color: #666;
      line-height: 1.6;
      padding-left: 2px;
    }

    .platform-steps code {
      background: #f0f0f0;
      padding: 1px 5px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }

    .divider {
      border: none;
      border-top: 1px solid #eee;
      margin: 20px 0;
    }

    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2.5px solid rgba(255,255,255,0.4);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header class="site-header">
    <a href="https://www.makerble.com" target="_self" rel="noopener">
      <!-- Makerble shield mark -->
      <svg width="36" height="40" viewBox="0 0 120 136" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M60 4 L114 32 L114 90 Q114 120 60 132 Q6 120 6 90 L6 32 Z"
              fill="white" stroke="#1e3a5f" stroke-width="6"/>
        <circle cx="60"  cy="20"  r="5.5" fill="#e91e8c"/>
        <circle cx="74"  cy="23"  r="5.5" fill="#c2185b"/>
        <circle cx="86"  cy="32"  r="5.5" fill="#9c27b0"/>
        <circle cx="92"  cy="46"  r="5.5" fill="#673ab7"/>
        <circle cx="90"  cy="61"  r="5.5" fill="#1976d2"/>
        <circle cx="82"  cy="74"  r="5.5" fill="#0288d1"/>
        <circle cx="69"  cy="82"  r="5.5" fill="#00897b"/>
        <circle cx="51"  cy="82"  r="5.5" fill="#43a047"/>
        <circle cx="38"  cy="74"  r="5.5" fill="#7cb342"/>
        <circle cx="30"  cy="61"  r="5.5" fill="#f9a825"/>
        <circle cx="28"  cy="46"  r="5.5" fill="#fb8c00"/>
        <circle cx="34"  cy="32"  r="5.5" fill="#e53935"/>
        <circle cx="46"  cy="23"  r="5.5" fill="#f06292"/>
        <text x="60" y="70" text-anchor="middle"
              font-family="Quicksand,Arial,sans-serif" font-weight="700" font-size="30"
              fill="#c2185b">M</text>
      </svg>
      <!-- Makerble wordmark -->
      <span style="font-family:'Quicksand',sans-serif;font-size:22px;font-weight:700;color:#1a1a2e;letter-spacing:0.2px;">Makerble</span>
    </a>
  </header>

  <div class="page-body">
  <div class="card">

    <div id="formSection">
      <h1>Connect to your AI assistant</h1>
      <p class="subtitle">
        Sign in with your Makerble account to get a personal link that lets
        Claude, ChatGPT, and other AI assistants access your Makerble data.
      </p>

      <label for="email">Makerble email</label>
      <input type="email" id="email" placeholder="you@yourorganisation.org" autocomplete="email" />

      <label for="password">Makerble password</label>
      <input type="password" id="password" placeholder="••••••••" autocomplete="current-password" />

      <button id="connectBtn" onclick="connect()">Get my personal link</button>
      <div class="error" id="errorBox"></div>
    </div>

    <div class="result" id="resultSection">
      <h2>✓ Your personal MCP link is ready</h2>
      <p>Copy the link below and paste it into your AI assistant. That's it — no further setup needed.</p>

      <div class="url-box">
        <div class="url-display" id="urlDisplay"></div>
        <button class="copy-btn" id="copyBtn" onclick="copyUrl()" title="Copy link">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>

      <div class="security-note">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span>
          <strong>Keep this link private.</strong> It gives access to your Makerble data.
          Don't share it in emails, Slack, or anywhere others might see it.
          If you think it's been compromised, use the button below to generate a new one.
        </span>
      </div>

      <button class="regen-btn" onclick="regenerate()">Generate a new link</button>

      <hr class="divider" />

      <div class="platforms">
        <h3>How to connect your AI assistant</h3>

        <div class="platform">
          <div class="platform-name">Claude (claude.ai)</div>
          <div class="platform-steps">
            Click your profile icon → <strong>Customize</strong>, then click
            <strong>Connectors</strong> in the left menu, then click the
            <strong>+ Add Connector</strong> button (top right), choose
            <strong>Add custom connector</strong>, and paste your link.
          </div>
        </div>

        <div class="platform">
          <div class="platform-name">Claude Desktop app</div>
          <div class="platform-steps">
            Open <strong>Settings → Integrations</strong> and paste your link,
            or ask your IT team to add it to the config file for you.
          </div>
        </div>

        <div class="platform">
          <div class="platform-name">ChatGPT (Plus / Pro)</div>
          <div class="platform-steps">
            Go to <strong>Settings → Apps → Create app → Remote MCP</strong>
            and paste your link. (Requires ChatGPT Plus or Pro with Developer Mode enabled.)
          </div>
        </div>

        <div class="platform">
          <div class="platform-name">Microsoft Copilot</div>
          <div class="platform-steps">
            Copilot currently requires an IT admin to connect MCP servers via Copilot Studio.
            Share this page with your IT team and give them your link.
          </div>
        </div>

        <div class="platform">
          <div class="platform-name">Gemini</div>
          <div class="platform-steps">
            MCP connections for Gemini currently require a developer.
            Share this page with your IT team and give them your link.
          </div>
        </div>
      </div>
    </div>
  </div>
  </div> <!-- /.page-body -->

  <script>
    let currentUrl = "";

    async function connect() {
      const email    = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      const btn      = document.getElementById("connectBtn");
      const errorBox = document.getElementById("errorBox");

      if (!email || !password) {
        showError("Please enter both your email address and password.");
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Connecting…';
      errorBox.style.display = "none";

      try {
        const res  = await fetch("/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (!res.ok) {
          showError(data.error || "Sign-in failed. Please check your email and password.");
          return;
        }

        currentUrl = data.mcp_url;
        document.getElementById("urlDisplay").textContent = currentUrl;
        document.getElementById("formSection").style.display  = "none";
        document.getElementById("resultSection").style.display = "block";

      } catch {
        showError("Something went wrong. Please try again in a moment.");
      } finally {
        btn.disabled = false;
        btn.textContent = "Get my personal link";
      }
    }

    function showError(msg) {
      const box = document.getElementById("errorBox");
      box.textContent = msg;
      box.style.display = "block";
    }

    async function copyUrl() {
      try {
        await navigator.clipboard.writeText(currentUrl);
        const btn = document.getElementById("copyBtn");
        btn.classList.add("copied");
        btn.innerHTML = \`<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>\`;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = \`<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\`;
        }, 2000);
      } catch {
        // Fallback: select the text
        const el = document.getElementById("urlDisplay");
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    }

    function regenerate() {
      currentUrl = "";
      document.getElementById("urlDisplay").textContent = "";
      document.getElementById("resultSection").style.display = "none";
      document.getElementById("formSection").style.display   = "block";
      document.getElementById("email").value    = "";
      document.getElementById("password").value = "";
      document.getElementById("errorBox").style.display = "none";
    }

    // Allow Enter key to submit
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter") connect();
    });
  </script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// /auth — called by the /connect page
// Accepts { email, password }, calls Makerble sign-in, returns personal MCP URL
// ─────────────────────────────────────────────────────────────────────────────

app.post("/auth", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required." });
  }

  try {
    const BASE_URL = process.env.MAKERBLE_BASE_URL || "https://makerble.com/api/v2";
    const body = new URLSearchParams({
      "user[email]":    email,
      "user[password]": password,
    });
    const response = await fetch(`${BASE_URL}/users/sign_in`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = await response.json();

    if (!response.ok || !data.authentication_token) {
      return res.status(401).json({
        error: "Invalid email or password. Please try again.",
      });
    }

    // Build the personal MCP URL with credentials as query params.
    // Force https in production; fall back to http only on localhost.
    const reqHost  = req.get("host");
    const isLocal  = reqHost.startsWith("localhost") || reqHost.startsWith("127.");
    const protocol = isLocal ? "http" : "https";
    const host     = `${protocol}://${reqHost}`;
    const mcpUrl   = `${host}/mcp?email=${encodeURIComponent(email)}&token=${encodeURIComponent(data.authentication_token)}`;

    return res.json({
      mcp_url:  mcpUrl,
      user_id:  data.user_id,
    });

  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Streamable HTTP transport  (MCP 2025-03-26)
// ─────────────────────────────────────────────────────────────────────────────

app.all("/mcp", async (req, res) => {
  const creds = resolveCredentials(req);

  if (!creds) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Unauthorised: no Makerble credentials supplied. " +
                 "Visit /connect to get your personal MCP link, or pass " +
                 "X-Makerble-Email and X-Makerble-Token headers.",
      },
      id: null,
    });
  }

  try {
    const sessionId = req.headers["mcp-session-id"];

    // Existing session — reuse transport
    if (sessionId && sessions[sessionId]) {
      const session = sessions[sessionId];
      if (!(session.transport instanceof StreamableHTTPServerTransport)) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session uses a different transport protocol" },
          id: null,
        });
      }
      return await session.transport.handleRequest(req, res, req.body);
    }

    // New session — must be an initialise request
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = { transport, email: creds.email, token: creds.token };
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions[sid]) delete sessions[sid];
      };
      await createMcpServer(creds.email, creds.token).connect(transport);
      return await transport.handleRequest(req, res, req.body);
    }

    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad request: no valid session ID" },
      id: null,
    });

  } catch (err) {
    console.error("Error on /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy SSE transport  (MCP 2024-11-05)
// ─────────────────────────────────────────────────────────────────────────────

app.get("/sse", async (req, res) => {
  const creds = resolveCredentials(req);

  if (!creds) {
    return res.status(401).send("Unauthorised: no Makerble credentials. Visit /connect for your personal link.");
  }

  const transport = new SSEServerTransport("/messages", res);
  sessions[transport.sessionId] = { transport, email: creds.email, token: creds.token };
  res.on("close", () => { delete sessions[transport.sessionId]; });
  await createMcpServer(creds.email, creds.token).connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session   = sessions[sessionId];

  if (!session || !(session.transport instanceof SSEServerTransport)) {
    return res.status(400).json({ error: "No SSE session found for sessionId" });
  }
  await session.transport.handlePostMessage(req, res, req.body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`\nMakerble MCP Server running on port ${PORT}`);
    console.log(`  Connect page:     http://localhost:${PORT}/connect`);
    console.log(`  Streamable HTTP:  http://localhost:${PORT}/mcp`);
    console.log(`  Legacy SSE:       http://localhost:${PORT}/sse\n`);
  });
}

export default app;
