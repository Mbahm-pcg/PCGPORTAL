// kb-sync.js — Syncs Google Drive "PCG-KB" folder → Netlify Blobs (for Orion)
// Portal KB articles are read directly from blobs by analyst-kb.js (no Drive push needed)
// Supports: Google Docs, Sheets, Slides, PDFs, plain text, HTML

const { google } = require('googleapis');
const { getStore } = require('@netlify/blobs');

const FOLDER_ID = '1T9YE1DkWZ4OVkKoF5j94aKFqc1SmUNIF';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function getBlobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function blobSave(key, data) {
  const store = getBlobStore();
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

async function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function extractText(drive, file) {
  const { id, mimeType, name } = file;
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId: id, mimeType: 'text/plain' }, { responseType: 'text' });
      return String(res.data || '');
    }
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId: id, mimeType: 'text/csv' }, { responseType: 'text' });
      return String(res.data || '');
    }
    if (mimeType === 'application/vnd.google-apps.presentation') {
      const res = await drive.files.export({ fileId: id, mimeType: 'text/plain' }, { responseType: 'text' });
      return String(res.data || '');
    }
    if (mimeType === 'application/pdf') {
      const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' });
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(Buffer.from(res.data));
      return parsed.text || '';
    }
    if (mimeType === 'text/plain') {
      const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
      return String(res.data || '');
    }
    if (mimeType === 'text/html') {
      const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
      return stripHtml(res.data || '');
    }
    return '';
  } catch (err) {
    console.error(`[kb-sync] Failed to extract "${name}":`, err.message);
    return '';
  }
}

exports.handler = async () => {
  try {
    const drive = await getDriveClient();

    const listRes = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      pageSize: 100,
      orderBy: 'name',
    });

    const files = listRes.data.files || [];
    console.log(`[kb-sync] Found ${files.length} file(s) in Drive folder`);

    if (files.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, synced: 0, total: 0, message: 'No files found — verify service account has Viewer access to the PCG-KB folder' }) };
    }

    const results = [];
    for (const file of files) {
      console.log(`[kb-sync] Processing: "${file.name}" (${file.mimeType})`);
      const text = await extractText(drive, file);
      const trimmed = text.trim();

      if (!trimmed) {
        console.log(`[kb-sync] Skipped "${file.name}" — unsupported type: ${file.mimeType}`);
        results.push({ fileId: file.id, name: file.name, mimeType: file.mimeType, status: 'skipped', reason: `unsupported type: ${file.mimeType}` });
        continue;
      }

      await blobSave(`analyst/kb/files/${file.id}`, {
        fileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        text: trimmed,
        charCount: trimmed.length,
        syncedAt: new Date().toISOString(),
      });

      results.push({ fileId: file.id, name: file.name, status: 'synced', charCount: trimmed.length });
    }

    await blobSave('analyst/kb/index', {
      folderId: FOLDER_ID,
      syncedAt: new Date().toISOString(),
      fileCount: results.filter(r => r.status === 'synced').length,
      files: results,
    });

    const synced = results.filter(r => r.status === 'synced').length;
    console.log(`[kb-sync] Synced ${synced}/${files.length} files`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, synced, total: files.length, results }) };

  } catch (err) {
    console.error('[kb-sync] error:', err);
    return { statusCode: 500, body: err.message };
  }
};
