const { sql } = require("./db");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const db = sql();

  await db`CREATE EXTENSION IF NOT EXISTS vector`;

  await db`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      author TEXT,
      status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      locked_by TEXT,
      locked_at TIMESTAMPTZ
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      id SERIAL PRIMARY KEY,
      article_id TEXT REFERENCES kb_articles(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(article_id, chunk_index)
    )
  `;

  await db`
    CREATE INDEX IF NOT EXISTS kb_embeddings_vector_idx
    ON kb_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10)
  `;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, message: "Migration complete" }),
  };
};
