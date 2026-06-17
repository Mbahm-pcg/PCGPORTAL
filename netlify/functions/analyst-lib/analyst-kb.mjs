// analyst-kb.js — Knowledge Base loader for Orion
// Sources:
//   1. Google Drive files synced via kb-sync
//   2. Portal KB articles (from blobs, live)
//   3. Archive: Announcements, Notes, Chat (from blobs)

import { cacheLoad } from './analyst-cache.mjs';
import { sql } from '../_shared/db.mjs';

async function loadKBIndex() {
  try { return await cacheLoad('analyst/kb/index'); } catch { return null; }
}

// opts: { district, userId, userRole } — district/userId used to scope archive for DMs
async function loadKBContent(opts = {}) {
  const { district, userId, userRole } = opts;
  const isDM = userRole === 'dm' && district;
  const files = [];

  // ── Source 1: Google Drive synced files ────────────────────────────────
  try {
    const index = await loadKBIndex();
    if (index?.files) {
      const synced = index.files.filter(f => f.status === 'synced');
      const contents = await Promise.all(
        synced.map(f => cacheLoad(`analyst/kb/files/${f.fileId}`).catch(() => null))
      );
      contents.filter(Boolean).forEach(f => files.push(f));
    }
  } catch {}

  // ── Source 2: Portal KB articles (only approved/locked/legacy) ──────────
  try {
    const articles = await cacheLoad('pcg_kb_articles');
    if (Array.isArray(articles)) {
      const publishedArticles = articles.filter(a =>
        a.status === 'approved' || a.status === 'locked' || !a.status
      );
      const articleFiles = await Promise.all(
        publishedArticles.map(async (a) => {
          try {
            const content = await cacheLoad(`pcg_kb_article_${a.id}`);
            if (!content) return null;
            const text = typeof content === 'string' ? content : JSON.stringify(content);
            return {
              fileId: `portal_${a.id}`,
              name: a.title,
              text: `Category: ${a.category || 'General'}\nAuthor: ${a.author || 'Unknown'}\n\n${text}`,
              charCount: text.length,
              source: 'portal',
            };
          } catch { return null; }
        })
      );
      articleFiles.filter(Boolean).forEach(f => files.push(f));
    }
  } catch {}

  // ── Source 3: Announcements archive ────────────────────────────────────
  try {
    const announcements = await cacheLoad('pcg_announcements_v1');
    if (Array.isArray(announcements) && announcements.length > 0) {
      const active = announcements.filter(a => {
        if (a.active === false) return false;
        if (!isDM) return true;
        // DMs see: no-target announcements OR ones targeting their district/role
        if (!a.targets) return true;
        const districtMatch = a.targets.districts?.includes(String(district)) || a.targets.districts?.includes(Number(district));
        const roleMatch = a.targets.roles?.includes('dm');
        const hasTargets = (a.targets.districts?.length > 0) || (a.targets.roles?.length > 0);
        return !hasTargets || districtMatch || roleMatch;
      });
      const lines = active.map(a => {
        const date = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '';
        const target = a.targets ? ` [To: ${[...(a.targets.roles || []), ...(a.targets.districts?.map(d => `District ${d}`) || [])].join(', ')}]` : '';
        return `[${date}]${target} ${a.createdBy || 'Unknown'}: ${a.title || ''}${a.message ? ' — ' + a.message : ''}`;
      }).join('\n');
      files.push({
        fileId: 'archive_announcements',
        name: 'Announcements Archive',
        text: lines,
        charCount: lines.length,
        source: 'archive',
      });
    }
  } catch {}

  // ── Source 4: Notes archive ─────────────────────────────────────────────
  try {
    // Notes are stored as { userId: [notes] } — DMs only see their own notes
    const notesObj = await cacheLoad('pcg_notes_v1');
    const allNotes = notesObj && typeof notesObj === 'object' && !Array.isArray(notesObj)
      ? (isDM && userId ? (notesObj[userId] || []) : Object.values(notesObj).flat())
      : [];
    if (allNotes.length > 0) {
      const lines = allNotes.map(n =>
        `[${n.created || ''}] ${n.author || 'Unknown'}: ${n.title || ''}${n.body ? '\n' + n.body : ''}`
      ).join('\n\n');
      files.push({
        fileId: 'archive_notes',
        name: 'Notes Archive',
        text: lines,
        charCount: lines.length,
        source: 'archive',
      });
    }
  } catch {}

  // ── Source 5: Chat archive ──────────────────────────────────────────────
  try {
    const [channels, messages] = await Promise.all([
      cacheLoad('pcg_chat_channels_v1').catch(() => null),
      cacheLoad('pcg_chat_messages_v1').catch(() => null),
    ]);
    if (Array.isArray(messages) && messages.length > 0) {
      const channelMap = {};
      if (Array.isArray(channels)) channels.forEach(c => { channelMap[c.id] = c.name || c.id; });

      // For DMs: only channels they are a member of
      const allowedChannelIds = isDM && Array.isArray(channels)
        ? new Set(channels.filter(c => !c.members || c.members.includes(userId) || c.members.includes(String(userId))).map(c => c.id))
        : null;

      // Keep last 200 non-deleted, non-Orion messages (scoped for DMs)
      const recent = messages
        .filter(m => !m.deleted && m.senderId !== 'orion' && (!allowedChannelIds || allowedChannelIds.has(m.channelId)))
        .slice(-200);

      const byChannel = {};
      recent.forEach(m => {
        const ch = channelMap[m.channelId] || m.channelId || 'general';
        if (!byChannel[ch]) byChannel[ch] = [];
        byChannel[ch].push(m);
      });

      const lines = Object.entries(byChannel).map(([ch, msgs]) => {
        const msgLines = msgs.map(m => {
          const date = m.timestamp ? new Date(m.timestamp).toLocaleDateString() : '';
          return `  [${date}] ${m.senderName || 'Unknown'}: ${m.text || ''}`;
        }).join('\n');
        return `#${ch}:\n${msgLines}`;
      }).join('\n\n');

      files.push({
        fileId: 'archive_chat',
        name: 'Chat Archive',
        text: lines,
        charCount: lines.length,
        source: 'archive',
      });
    }
  } catch {}

  return files;
}

function buildKBContext(kbFiles) {
  if (!kbFiles || kbFiles.length === 0) return '';
  const MAX_CHARS_PER_FILE = 3000;
  const sections = kbFiles.map(f => {
    const label = f.source === 'portal' ? `${f.name} · Portal KB`
      : f.source === 'archive' ? `${f.name} · Archive`
      : f.name;
    return `[${label}]\n${f.text.slice(0, MAX_CHARS_PER_FILE)}${f.text.length > MAX_CHARS_PER_FILE ? '\n...(truncated)' : ''}`;
  }).join('\n\n');
  return `\n\nCompany Knowledge Base (SOPs, standards, guides, archive — use when relevant to the question):\n${sections}`;
}

async function searchKB(query) {
  try {
    const db = sql();
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return null;
    const searchPattern = keywords.map(k => `%${k}%`);
    const results = await db`
      SELECT e.article_id, e.chunk_text, a.title, a.category
      FROM kb_embeddings e
      JOIN kb_articles a ON a.id = e.article_id
      WHERE a.status IN ('approved', 'locked')
        AND EXISTS (SELECT 1 FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw)
      ORDER BY (SELECT count(*) FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw) DESC
      LIMIT 5
    `;
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

export { loadKBIndex, loadKBContent, buildKBContext, searchKB };
