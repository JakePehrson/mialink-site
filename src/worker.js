// Mialink Software LLC — site worker: static assets plus the contact endpoint.
// The owner's address is never in this file or in the published HTML; messages
// are stored in D1 and read through /api/messages with CONTACT_TOKEN.

const MAX_MESSAGE = 4000;

const TOPIC_LABELS = {
  general: 'General question',
  project: 'Project enquiry',
  'mia-beta': 'Mia Blend Studio beta access',
  'field-notes': 'Field Notes Companion',
  'medication-tracker': 'Medication Tracker',
  privacy: 'Privacy or data request'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let schema = null;
function ensureSchema(env) {
  if (!schema) {
    schema = env.DB.exec(
      'CREATE TABLE IF NOT EXISTS contact_messages (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'created_at TEXT NOT NULL, ' +
        'name TEXT NOT NULL, ' +
        'email TEXT NOT NULL, ' +
        'topic TEXT NOT NULL, ' +
        'message TEXT NOT NULL, ' +
        'ip_hash TEXT)'
    ).catch((error) => {
      schema = null;
      throw error;
    });
  }
  return schema;
}

// Email notification. Cloudflare Workers cannot open an SMTP connection, so this
// uses an HTTP email API. Two options, either one dormant until configured:
//   1. Cloudflare Email Service (free when the recipient is a verified
//      destination address on the account): CF_EMAIL_API_TOKEN,
//      CF_EMAIL_ACCOUNT_ID, CF_EMAIL_FROM, MAIL_TO
//   2. Resend: RESEND_API_KEY, MAIL_TO, optional MAIL_FROM
async function sendViaCloudflare(env, message, label, body) {
  const endpoint =
    'https://api.cloudflare.com/client/v4/accounts/' +
    env.CF_EMAIL_ACCOUNT_ID +
    '/email/sending/send';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.CF_EMAIL_API_TOKEN,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      to: env.MAIL_TO,
      from: env.CF_EMAIL_FROM,
      reply_to: message.email,
      subject: 'Contact form — ' + label,
      text: body
    })
  });

  if (!response.ok) return { ok: false, error: await readError(response) };
  const data = await response.json().catch(() => null);
  if (data && data.success === false) {
    const first = data.errors && data.errors[0];
    return { ok: false, error: (first && first.message) || 'Cloudflare rejected the send.' };
  }
  return { ok: true, error: null };
}

// Provider error text, kept short and free of anything secret, so a broken setup
// can be diagnosed from the response instead of guessing.
async function readError(response) {
  const text = await response.text().catch(() => '');
  if (!text) return 'HTTP ' + response.status;
  try {
    const data = JSON.parse(text);
    const first = data.errors && data.errors[0];
    if (first && first.message) return first.message;
    if (data.message) return data.message;
    if (data.error) return data.error;
  } catch {
    /* not JSON, fall through to the raw text */
  }
  return text.slice(0, 300);
}

async function notify(env, message) {
  if (!env.MAIL_TO) return { emailed: false, error: 'MAIL_TO is not set.' };

  const label = TOPIC_LABELS[message.topic] || message.topic;
  const body = [
    'New message from the contact form',
    '',
    'Name: ' + message.name,
    'Email: ' + message.email,
    'Topic: ' + label,
    'Received: ' + new Date().toISOString(),
    '',
    message.message
  ].join('\n');

  let lastError = null;

  try {
    if (env.CF_EMAIL_API_TOKEN && env.CF_EMAIL_ACCOUNT_ID && env.CF_EMAIL_FROM) {
      const cf = await sendViaCloudflare(env, message, label, body);
      if (cf.ok) return { emailed: true, error: null };
      lastError = cf.error;
    }

    if (!env.RESEND_API_KEY) {
      return { emailed: false, error: lastError || 'No email provider is configured.' };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Mialink website <onboarding@resend.dev>',
        to: [env.MAIL_TO],
        reply_to: message.email,
        subject: 'Contact form — ' + label,
        text: body
      })
    });

    if (response.ok) return { emailed: true, error: null };
    return { emailed: false, error: await readError(response) };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { emailed: false, error: lastError || 'Request failed: ' + detail };
  }
}

async function handleContact(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Forbidden.' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400);

  // Honeypot: filled in only by bots. Answer as if it worked.
  if (clean(body.website, 200)) return json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const topic = clean(body.topic, 40) || 'general';
  const message = clean(body.message, MAX_MESSAGE);

  if (!name || !email || !message) {
    return json({ error: 'Please fill in your name, email address and message.' }, 422);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: 'That email address does not look right.' }, 422);
  }
  if (!env.DB) return json({ error: 'The contact form is not available right now.' }, 503);

  try {
    await ensureSchema(env);

    const ip = request.headers.get('cf-connecting-ip') || '';
    const ipHash = ip ? await sha256(ip + ':' + (env.CONTACT_TOKEN || 'mialink')) : null;

    if (ipHash) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM contact_messages WHERE ip_hash = ? AND created_at > ?'
      )
        .bind(ipHash, hourAgo)
        .first();
      if (recent && recent.n >= 5) {
        return json({ error: 'That is a few messages in one hour. Please try again later.' }, 429);
      }
    }

    await env.DB.prepare(
      'INSERT INTO contact_messages (created_at, name, email, topic, message, ip_hash) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(new Date().toISOString(), name, email, topic, message, ipHash)
      .run();

    const mail = await notify(env, { name, email, topic, message });
    return json({ ok: true, emailed: mail.emailed, mail_error: mail.error || undefined });
  } catch {
    return json({ error: 'Your message could not be saved. Please try again.' }, 500);
  }
}

function tokenMatches(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleMessages(request, env) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!env.CONTACT_TOKEN) return json({ error: 'Not configured.' }, 503);

  const header = request.headers.get('x-contact-token') || '';
  if (!tokenMatches(header, env.CONTACT_TOKEN)) return json({ error: 'Unauthorized.' }, 401);
  if (!env.DB) return json({ error: 'No database bound.' }, 503);

  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    'SELECT id, created_at, name, email, topic, message FROM contact_messages ORDER BY id DESC LIMIT 100'
  ).all();

  return json({ messages: results || [] });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') return handleContact(request, env);
    if (url.pathname === '/api/messages') return handleMessages(request, env);

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      const notFound = await env.ASSETS.fetch(new URL('/404.html', url.origin));
      if (notFound.status === 200) {
        return new Response(notFound.body, { status: 404, headers: notFound.headers });
      }
    }
    return response;
  }
};
