import type { HttpRequest, HttpResponse } from "../lib/http.js";

export default async function handler(
  req: HttpRequest,
  res: HttpResponse
): Promise<void> {
  const baseUrl = process.env.BASE_URL || (req.headers.host ? `https://${req.headers.host}` : "");

  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Japanese Conversation Bot — Emi</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #e4e4e7;
        }
        .container {
          max-width: 600px;
          padding: 2rem;
          text-align: center;
        }
        h1 {
          font-size: 2.5rem;
          margin-bottom: 0.5rem;
          background: linear-gradient(90deg, #60a5fa, #a78bfa);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .subtitle {
          color: #a1a1aa;
          margin-bottom: 2rem;
        }
        .status {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 1.5rem;
          margin-bottom: 2rem;
        }
        .status-item {
          display: flex;
          justify-content: space-between;
          padding: 0.5rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .status-item:last-child { border-bottom: none; }
        .status-ok { color: #4ade80; }
        .features {
          text-align: left;
          background: rgba(255,255,255,0.05);
          border-radius: 12px;
          padding: 1.5rem;
          margin-bottom: 2rem;
        }
        .features h3 {
          margin-bottom: 1rem;
          color: #a78bfa;
        }
        .features ul {
          list-style: none;
        }
        .features li {
          padding: 0.5rem 0;
          padding-left: 1.5rem;
          position: relative;
        }
        .features li::before {
          content: "✓";
          position: absolute;
          left: 0;
          color: #4ade80;
        }
        .endpoints {
          text-align: left;
          font-size: 0.875rem;
          color: #71717a;
        }
        .endpoints code {
          background: rgba(255,255,255,0.1);
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🌸 Japanese Conversation Bot — Emi</h1>
        <p class="subtitle">Private Telegram sandbox for focused Japanese conversation practice</p>
        
        <div class="status">
          <div class="status-item">
            <span>Status</span>
            <span class="status-ok">● Online</span>
          </div>
          <div class="status-item">
            <span>Webhook</span>
            <span><code>${baseUrl ? `${baseUrl}/api/telegram` : "/api/telegram"}</code></span>
          </div>
        </div>

        <div class="features">
          <h3>Features</h3>
          <ul>
            <li>Japanese conversation with furigana</li>
            <li>Voice message transcription</li>
            <li>Long-term memory</li>
            <li>English translation helper via /eng</li>
            <li>Grammar explanation helper via /exp</li>
            <li>Optional proactive check-ins</li>
          </ul>
        </div>

        <div class="endpoints">
          <p><strong>Endpoints:</strong></p>
          <p><code>POST /api/telegram</code> - Telegram webhook</p>
          <p><code>POST /api/notify</code> - QStash callbacks</p>
          <p><code>GET /api/setup</code> - Set webhook URL</p>
        </div>
      </div>
    </body>
    </html>
  `);
}
