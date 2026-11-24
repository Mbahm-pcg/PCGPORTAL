// Emailed Daily Report PDFs — key/limit helpers shared by netlify/functions/report-pdf.mjs
// and the browser uploader (src/report-photo-upload.mjs). Pure.
//
// A PDF is uploaded as base64 text in chunks (each request must stay under Netlify's ~6 MB
// body cap) and stored one blob per chunk. CHUNK_CHARS is a multiple of 4 so every chunk is
// valid base64 on its own and can be decoded and streamed back independently.
export const CHUNK_CHARS = 3 * 1024 * 1024;
export const MAX_CHUNKS = 8; // 24 MB of base64 ≈ 18 MB PDF — under the 20 MB streamed-response cap

export const isValidToken = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
export const chunkKey = (token, i) => `pcg_report_pdf_${token}_c${i}`;
export const metaKey = (token) => `pcg_report_pdf_${token}_meta`;

export function safeFileName(name) {
  const base = String(name || '').replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 100);
  return `${base || 'Daily_Report'}.pdf`;
}

export function splitBase64(b64) {
  const out = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) out.push(b64.slice(i, i + CHUNK_CHARS));
  return out.length ? out : [''];
}

export const PDF_MAGIC_B64 = 'JVBERi0'; // base64 of "%PDF-"
export const REPORT_PDF_PREFIX = 'pcg_report_pdf_';

// Validate one upload request. → null when fine, else an error string.
export function chunkProblem({ index, total, chunk }) {
  if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) return `total must be 1-${MAX_CHUNKS}`;
  if (!Number.isInteger(index) || index < 0 || index >= total) return 'index out of range';
  if (typeof chunk !== 'string' || chunk.length === 0 || chunk.length > CHUNK_CHARS) return 'chunk empty or too large';
  if (chunk.length % 4 !== 0 && index !== total - 1) return 'chunk not base64-aligned';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.slice(-8)) || !/^[A-Za-z0-9+/]+$/.test(chunk.slice(0, 64).replace(/=+$/, ''))) return 'chunk is not base64';
  // The link is served as application/pdf to anyone who has it — only take real PDFs ("%PDF-").
  if (index === 0 && !chunk.startsWith(PDF_MAGIC_B64)) return 'file is not a PDF';
  return null;
}
