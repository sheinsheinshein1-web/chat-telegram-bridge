process.on('uncaughtException', err => { console.error('[crash]', err); process.exit(1); });
process.on('unhandledRejection', err => { console.error('[rejection]', err); process.exit(1); });

require('dotenv').config();
const http = require('http');
const url = require('url');
const axios = require('axios');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

console.log('[boot] NODE_ENV:', process.env.NODE_ENV);
console.log('[boot] PORT env:', process.env.PORT);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// sessionId -> { messages: [], lastActivity: number, res: ServerResponse|null }
const sessions = new Map();
// Telegram message_id -> sessionId (for routing replies)
const msgToSession = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], lastActivity: Date.now(), res: null });
  }
  return sessions.get(sessionId);
}

function storeMessage(sessionId, msg) {
  const session = getSession(sessionId);
  session.messages.push(msg);
  session.lastActivity = Date.now();
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Purge sessions older than 7 days, keep msgToSession bounded
setInterval(() => {
  const cutoff = Date.now() - SEVEN_DAYS;
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      if (session.res) session.res.end();
      sessions.delete(id);
    }
  }
  if (msgToSession.size > 20000) {
    const keys = [...msgToSession.keys()];
    keys.slice(0, keys.length - 10000).forEach(k => msgToSession.delete(k));
  }
}, 60 * 60 * 1000);

async function forwardToTelegram(sessionId, text) {
  const res = await axios.post(`${TG_API}/sendMessage`, {
    chat_id: ADMIN_CHAT_ID,
    text: `📩 [${sessionId}]\n${text}`,
  }, { timeout: 10000 });
  return res.data.result.message_id;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('invalid json')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const { pathname, query: rawQuery } = url.parse(req.url, true);

  // GET /health
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  // GET /listen?session=ID — SSE stream
  if (pathname === '/listen' && req.method === 'GET') {
    const sessionId = rawQuery.session;
    if (!sessionId) {
      res.writeHead(400).end('session required');
      return;
    }

    const session = getSession(sessionId);

    // Close any previous SSE connection for this session
    if (session.res) {
      try { session.res.end(); } catch {}
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx buffering
    });

    session.res = res;
    session.lastActivity = Date.now();

    // Send message history on (re)connect
    if (session.messages.length > 0) {
      sendSSE(res, { type: 'history', messages: session.messages });
    }

    // Heartbeat every 25s to keep connection alive
    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const s = sessions.get(sessionId);
      if (s && s.res === res) s.res = null;
    });

    return;
  }

  // POST /send — client sends a message
  if (pathname === '/send' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { session: sessionId, text } = body;

      if (!sessionId || !text?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'session and text required' }));
        return;
      }

      const clientMsg = { from: 'client', text: text.trim(), timestamp: Date.now() };
      storeMessage(sessionId, clientMsg);

      const tgMsgId = await forwardToTelegram(sessionId, text.trim());
      msgToSession.set(tgMsgId, sessionId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[/send]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // POST /webhook — Telegram updates
  if (pathname === '/webhook' && req.method === 'POST') {
    try {
      const update = await readBody(req);
      const message = update.message;

      if (
        message?.text &&
        String(message.chat.id) === ADMIN_CHAT_ID &&
        message.reply_to_message
      ) {
        const sessionId = msgToSession.get(message.reply_to_message.message_id);
        if (sessionId) {
          const reply = { from: 'admin', text: message.text, timestamp: Date.now() };
          storeMessage(sessionId, reply);

          const session = sessions.get(sessionId);
          if (session?.res && !session.res.writableEnded) {
            sendSSE(session.res, reply);
          }
        }
      }

      res.writeHead(200).end('ok');
    } catch (err) {
      console.error('[/webhook]', err.message);
      res.writeHead(400).end('bad request');
    }
    return;
  }

  res.writeHead(404).end('not found');
});

server.on('error', err => { console.error('[server error]', err); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => console.log(`[ready] Server listening on 0.0.0.0:${PORT}`));
