process.on('uncaughtException', err => { console.error('[crash]', err); process.exit(1); });
process.on('unhandledRejection', err => { console.error('[rejection]', err); process.exit(1); });

require('dotenv').config();
const http = require('http');
const https = require('https');
const axios = require('axios');
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

console.log('[boot] NODE_ENV:', process.env.NODE_ENV);
console.log('[boot] PORT env:', process.env.PORT);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const PORT = process.env.PORT || 3000;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 10000);

const telegramAgent = new https.Agent({
  family: 4,
  lookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, family: 4, all: false }, callback);
  },
});

const telegramClient = axios.create({
  baseURL: TG_API,
  timeout: TELEGRAM_TIMEOUT_MS,
  httpsAgent: telegramAgent,
});

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
  const body = { chat_id: ADMIN_CHAT_ID, text: `📩 [${sessionId}]\n${text}` };
  const delays = [0, 2000, 5000]; // 3 попытки: сразу, через 2с, через 5с
  let lastErr;
  for (const delay of delays) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const res = await telegramClient.post('/sendMessage', body);
      return res.data.result.message_id;
    } catch (err) {
      lastErr = err;
      console.error(`[telegram] попытка не удалась, задержка ${delay}ms:`, err.message);
    }
  }
  throw lastErr;
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

function forwardToTelegramInBackground(sessionId, text) {
  forwardToTelegram(sessionId, text)
    .then(tgMsgId => {
      msgToSession.set(tgMsgId, sessionId);
    })
    .catch(err => {
      console.error('[/send async]', err.message);
    });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // GET /health
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  // GET /ping-telegram — тест сетевой связности с Telegram изнутри контейнера
  if (pathname === '/ping-telegram' && req.method === 'GET') {
    try {
      const result = await telegramClient.get('/getMe');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bot: result.data.result }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message, code: err.code }));
    }
    return;
  }

  // GET /listen?session=ID — SSE stream
  if (pathname === '/listen' && req.method === 'GET') {
    const sessionId = parsedUrl.searchParams.get('session');
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

      forwardToTelegramInBackground(sessionId, text.trim());

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: true }));
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
