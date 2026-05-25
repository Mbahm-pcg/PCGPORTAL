const { sql } = require("./db");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const { query, limit = 5 } = JSON.parse(event.body || "{}");
  if (!query) return { statusCode: 400, body: JSON.stringify({ error: "Missing query" }) };

  const db = sql();

  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ results: [] }) };
  }

  const searchPattern = keywords.map(k => `%${k}%`);

  const results = await db`
    SELECT e.article_id, e.chunk_index, e.chunk_text, a.title, a.category, a.status,
           (SELECT count(*) FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw) AS relevance
    FROM kb_embeddings e
    JOIN kb_articles a ON a.id = e.article_id
    WHERE a.status IN ('approved', 'locked')
      AND EXISTS (
        SELECT 1 FROM unnest(${searchPattern}::text[]) AS kw WHERE lower(e.chunk_text) LIKE kw
      )
    ORDER BY relevance DESC
    LIMIT ${limit}
  `;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  };
};
