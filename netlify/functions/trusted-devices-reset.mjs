// trusted-devices-reset.mjs
// Scheduled every Saturday at 11:59 PM ET (Sunday 03:59 UTC).
// Wipes all trusted 2FA device tokens so every user must re-verify
// on their first login of the new week.

import { getStore } from '@netlify/blobs';

export const config = { schedule: '59 3 * * 0' };

const BLOB_KEY = 'pcg_trusted_devices_v1';

export default async () => {
  try {
    const store = getStore({
      name: 'pcg-portal',
      consistency: 'strong',
      siteID: process.env.PCG_SITE_ID,
      token: process.env.PCG_AUTH_TOKEN,
    });

    await store.setJSON(BLOB_KEY, {
      savedAt: new Date().toISOString(),
      data: {},
    });

    console.log('[trusted-devices-reset] All trusted devices cleared for weekly 2FA reset.');
    return new Response(JSON.stringify({ ok: true, clearedAt: new Date().toISOString() }), { status: 200 });
  } catch (err) {
    console.error('[trusted-devices-reset] Failed:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
