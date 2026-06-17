// kb-manage.mjs — KB article workflow actions (submit, approve, reject, lock, unlock)
import { getStore } from '@netlify/blobs';

export default async (request) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  try {
    const { action, articleId, userId, userName, userRole, reason } = await request.json().catch(() => ({}));
    if (!action || !articleId) return new Response(JSON.stringify({ error: 'Missing action or articleId' }), { status: 400, headers });

    const store = getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

    const loadArticles = async () => {
      const raw = await store.get('pcg_kb_articles', { type: 'json' }).catch(() => null);
      return raw?.data || raw || [];
    };
    const saveArticles = async (articles) => {
      await store.setJSON('pcg_kb_articles', { savedAt: new Date().toISOString(), data: articles });
    };

    const isAdmin = userRole === 'executive' || userRole === 'it';
    const now = new Date().toISOString();

    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return new Response(JSON.stringify({ error: 'Article not found' }), { status: 404, headers });

    const article = articles[idx];

    switch (action) {
      case 'submit-for-review': {
        if (article.status !== 'draft') {
          return new Response(JSON.stringify({ error: 'Only draft articles can be submitted for review' }), { status: 400, headers });
        }
        article.status = 'pending_review';
        article.submittedBy = userName || userId;
        article.submittedAt = now;
        article.reviewNote = null;
        break;
      }
      case 'approve': {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Only admins can approve articles' }), { status: 403, headers });
        if (article.status !== 'pending_review') {
          return new Response(JSON.stringify({ error: 'Only pending_review articles can be approved' }), { status: 400, headers });
        }
        article.status = 'approved';
        article.reviewedBy = userName || userId;
        article.reviewedAt = now;
        article.reviewNote = null;
        break;
      }
      case 'reject': {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Only admins can reject articles' }), { status: 403, headers });
        if (article.status !== 'pending_review') {
          return new Response(JSON.stringify({ error: 'Only pending_review articles can be rejected' }), { status: 400, headers });
        }
        article.status = 'draft';
        article.reviewedBy = userName || userId;
        article.reviewedAt = now;
        article.reviewNote = reason || 'Rejected by admin';
        break;
      }
      case 'lock': {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Only admins can lock articles' }), { status: 403, headers });
        if (article.status !== 'approved') {
          return new Response(JSON.stringify({ error: 'Only approved articles can be locked' }), { status: 400, headers });
        }
        article.status = 'locked';
        article.lockedBy = userName || userId;
        article.lockedAt = now;
        break;
      }
      case 'unlock': {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Only admins can unlock articles' }), { status: 403, headers });
        if (article.status !== 'locked') {
          return new Response(JSON.stringify({ error: 'Only locked articles can be unlocked' }), { status: 400, headers });
        }
        article.status = 'approved';
        article.lockedBy = null;
        article.lockedAt = null;
        break;
      }
      default:
        return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), { status: 400, headers });
    }

    articles[idx] = article;
    await saveArticles(articles);

    return new Response(JSON.stringify({ ok: true, status: article.status, article }), { status: 200, headers });
  } catch (err) {
    console.error('kb-manage error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
