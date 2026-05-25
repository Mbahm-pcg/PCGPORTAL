// kb-manage.js — KB article workflow actions (submit, approve, reject, lock, unlock)
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  try {
    const { action, articleId, userId, userName, userRole, reason } = JSON.parse(event.body || "{}");
    if (!action || !articleId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing action or articleId" }) };

    const store = getStore({ name: "pcg-portal", siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

    const loadArticles = async () => {
      const raw = await store.get("pcg_kb_articles", { type: "json" }).catch(() => null);
      return raw?.data || raw || [];
    };
    const saveArticles = async (articles) => {
      await store.setJSON("pcg_kb_articles", { savedAt: new Date().toISOString(), data: articles });
    };

    const isAdmin = userRole === "executive" || userRole === "it";
    const now = new Date().toISOString();

    const articles = await loadArticles();
    const idx = articles.findIndex(a => a.id === articleId);
    if (idx === -1) return { statusCode: 404, headers, body: JSON.stringify({ error: "Article not found" }) };

    const article = articles[idx];

    switch (action) {
      case "submit-for-review": {
        if (article.status !== "draft") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Only draft articles can be submitted for review" }) };
        }
        article.status = "pending_review";
        article.submittedBy = userName || userId;
        article.submittedAt = now;
        article.reviewNote = null;
        break;
      }
      case "approve": {
        if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "Only admins can approve articles" }) };
        if (article.status !== "pending_review") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Only pending_review articles can be approved" }) };
        }
        article.status = "approved";
        article.reviewedBy = userName || userId;
        article.reviewedAt = now;
        article.reviewNote = null;
        break;
      }
      case "reject": {
        if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "Only admins can reject articles" }) };
        if (article.status !== "pending_review") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Only pending_review articles can be rejected" }) };
        }
        article.status = "draft";
        article.reviewedBy = userName || userId;
        article.reviewedAt = now;
        article.reviewNote = reason || "Rejected by admin";
        break;
      }
      case "lock": {
        if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "Only admins can lock articles" }) };
        if (article.status !== "approved") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Only approved articles can be locked" }) };
        }
        article.status = "locked";
        article.lockedBy = userName || userId;
        article.lockedAt = now;
        break;
      }
      case "unlock": {
        if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "Only admins can unlock articles" }) };
        if (article.status !== "locked") {
          return { statusCode: 400, headers, body: JSON.stringify({ error: "Only locked articles can be unlocked" }) };
        }
        article.status = "approved";
        article.lockedBy = null;
        article.lockedAt = null;
        break;
      }
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };
    }

    articles[idx] = article;
    await saveArticles(articles);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: article.status, article }) };
  } catch (err) {
    console.error("kb-manage error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
