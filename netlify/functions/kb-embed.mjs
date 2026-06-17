import { sql } from './_shared/db.js';
import { getStore } from '@netlify/blobs';

const CHUNK_SIZE = 500;

function chunkText(text) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { articleId } = await request.json().catch(() => ({}));
  if (!articleId) return new Response(JSON.stringify({ error: 'Missing articleId' }), { status: 400 });

  const blobStore = getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const raw = await blobStore.get(`pcg_kb_article_${articleId}`, { type: 'json' }).catch(() => null);
  const articleContent = raw?.data || raw || '';

  if (!articleContent) return new Response(JSON.stringify({ error: 'Article content not found' }), { status: 404 });

  const db = sql();
  const textContent = typeof articleContent === 'string' ? articleContent : JSON.stringify(articleContent);
  const chunks = chunkText(textContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

  await db`DELETE FROM kb_embeddings WHERE article_id = ${articleId}`;

  for (let i = 0; i < chunks.length; i++) {
    await db`
      INSERT INTO kb_embeddings (article_id, chunk_index, chunk_text)
      VALUES (${articleId}, ${i}, ${chunks[i]})
      ON CONFLICT (article_id, chunk_index) DO UPDATE SET chunk_text = ${chunks[i]}
    `;
  }

  return new Response(
    JSON.stringify({ ok: true, chunks: chunks.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
