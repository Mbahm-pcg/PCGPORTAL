import { sql } from './_shared/db.mjs';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { query, limit = 5 } = await request.json().catch(() => ({}));
  if (!query) return new Response(JSON.stringify({ error: 'Missing query' }), { status: 400 });

  const db = sql();

  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (keywords.length === 0) {
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  return new Response(
    JSON.stringify({ results }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
