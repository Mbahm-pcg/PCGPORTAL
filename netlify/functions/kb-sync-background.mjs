// Background + scheduled entry for KB sync (Mon 6 AM ET / 10:00 UTC). The -background
// filename gives the 15-min timeout for large Drive folders. Schedule lives here
// because the foreground kb-sync has none.
import kbSync from './kb-sync.mjs';

export const config = { schedule: '0 10 * * 1' };

export default async (request, context) => {
  try {
    await kbSync(request, context);
  } catch (err) {
    console.error('[kb-sync-background] error:', err.message);
  }
};
