// email-sync-cron.mjs — Hourly: poll shared Gmail inbox via service account
// NOTE: intentionally unscheduled (dormant). No export const config = { schedule }.
// Manual-invoke only via POST /.netlify/functions/email-sync-cron.
import { google } from 'googleapis';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';

const CATEGORY_KEYWORDS = {
  vendor: ['invoice', 'delivery', 'order', 'shipment', 'supply', 'dcp', 'sysco'],
  corporate: ['dunkin', 'inspire brands', 'corporate', 'compliance', 'audit'],
  complaint: ['complaint', 'issue', 'unhappy', 'refund', 'health department', 'inspection'],
};

function categorize(subject, from) {
  const text = `${subject} ${from}`.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => text.includes(k))) return cat;
  }
  return 'general';
}

function decodeBase64(str) {
  if (!str) return '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload) {
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64(textPart.body.data);
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return decodeBase64(htmlPart.body.data);
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

export default async (request, context) => {
  const body = await request.json().catch(() => ({}));
  const scheduled = request.headers.get('x-pcg-invocation') === 'scheduled' || !!body?.next_run;
  const isManual = request.method === 'POST' && !scheduled;
  console.log('[email-sync] Starting', isManual ? '(manual)' : '(scheduled)');

  const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const SHARED_MAILBOX = process.env.GOOGLE_SHARED_MAILBOX;

  if (!SERVICE_ACCOUNT_KEY || !SHARED_MAILBOX) {
    console.warn('[email-sync] Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SHARED_MAILBOX');
    return isManual ? new Response(JSON.stringify({ ok: false, error: 'Not configured' }), { status: 200 }) : undefined;
  }

  let credentials;
  try { credentials = JSON.parse(SERVICE_ACCOUNT_KEY); } catch {
    console.error('[email-sync] Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON');
    return isManual ? new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 500 }) : undefined;
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: SHARED_MAILBOX,
  });

  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const listRes = await gmail.users.messages.list({
      userId: SHARED_MAILBOX,
      q: 'newer_than:1d',
      maxResults: 50,
    });

    const messageIds = (listRes.data.messages || []).map(m => m.id);
    console.log(`[email-sync] Found ${messageIds.length} messages from last 24h`);

    const emails = [];
    for (const msgId of messageIds) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: SHARED_MAILBOX,
          id: msgId,
          format: 'full',
        });

        const msg = msgRes.data;
        const headers = msg.payload?.headers || [];
        const from = getHeader(headers, 'From');
        const fromName = from.replace(/<.*>/, '').trim() || from;
        const to = getHeader(headers, 'To');
        const subject = getHeader(headers, 'Subject');
        const date = getHeader(headers, 'Date');
        const hasAttachment = (msg.payload?.parts || []).some(p => p.filename && p.filename.length > 0);

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from: from.match(/<(.+)>/)?.[1] || from,
          fromName,
          to,
          subject,
          snippet: msg.snippet || '',
          date: new Date(date).toISOString(),
          category: categorize(subject, from),
          isRead: !(msg.labelIds || []).includes('UNREAD'),
          hasAttachment,
          bodyPreview: extractBody(msg.payload).slice(0, 500),
        });
      } catch (e) {
        console.warn(`[email-sync] Failed to fetch message ${msgId}: ${e.message}`);
      }
    }

    // Merge with existing (rolling 7-day window)
    const existing = await cacheLoad('pcg_emails_inbox') || { emails: [] };
    const existingIds = new Set(emails.map(e => e.id));
    const older = (existing.emails || []).filter(e => {
      if (existingIds.has(e.id)) return false;
      const age = Date.now() - new Date(e.date).getTime();
      return age < 7 * 24 * 60 * 60 * 1000;
    });

    const allEmails = [...emails, ...older]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 200);

    await cacheSave('pcg_emails_inbox', { emails: allEmails, lastSyncAt: new Date().toISOString() });

    console.log(`[email-sync] Complete: ${emails.length} new, ${allEmails.length} total`);

    return isManual
      ? new Response(JSON.stringify({ ok: true, new: emails.length, total: allEmails.length }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : undefined;

  } catch (e) {
    console.error('[email-sync] Gmail API error:', e.message);
    return isManual
      ? new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      : undefined;
  }
};
