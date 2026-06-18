import { neon } from "@neondatabase/serverless";
import webpush from "web-push";
import { getStore } from "@netlify/blobs";

// Runs at 10,14,18,22 UTC → 5am, 9am, 1pm, 5pm ET (±1hr handles EST/EDT)
export const config = { schedule: "0 10,14,18,22 * * *" };

// Map current ET hour → shift label (±1 handles EST vs EDT)
const ET_HOUR_TO_SHIFT = {
  5: "5 AM", 6: "5 AM",
  9: "9 AM", 10: "9 AM",
  13: "1 PM", 14: "1 PM",
  17: "5 PM", 18: "5 PM",
};

function getBlobStore() {
  return getStore({ name: "pcg-portal", siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function blobLoad(key) {
  try {
    const store = getBlobStore();
    const raw = await store.get(key, { type: "json" });
    if (!raw) return null;
    return raw.data !== undefined ? raw.data : raw;
  } catch { return null; }
}

export default async () => {
  const now = new Date();

  // Detect current ET hour (handles EST/EDT automatically)
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
      .format(now)
  ) || 0;

  const shiftLabel = ET_HOUR_TO_SHIFT[etHour];
  if (!shiftLabel) {
    console.log(`task-notify-cron: no shift mapped for ET hour ${etHour}, skipping`);
    return new Response("no shift", { status: 200 });
  }

  // Today's date in ET (YYYY-MM-DD)
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  console.log(`task-notify-cron: shift=${shiftLabel} date=${todayET}`);

  // Load users + subscriptions in parallel
  const [users, subs] = await Promise.all([
    blobLoad("pcg_users_v1"),
    blobLoad("pcg_push_subscriptions_v1"),
  ]);

  if (!users || !subs) {
    console.log("task-notify-cron: missing users or subs blob");
    return new Response("missing data", { status: 200 });
  }

  // Query open task counts per store for this shift window
  const db = neon(process.env.NEON_DATABASE_URL);
  const rows = await db`
    SELECT store_pc, COUNT(*)::int AS open_count
    FROM task_instances
    WHERE business_date = ${todayET}
      AND status = 'open'
      AND shift_time = ${shiftLabel}
    GROUP BY store_pc
  `;

  if (!rows.length) {
    console.log(`task-notify-cron: no open ${shiftLabel} tasks today`);
    return new Response("no tasks", { status: 200 });
  }

  // Setup VAPID
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || "noreply@pcgops.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  let sent = 0, failed = 0, skipped = 0;

  for (const row of rows) {
    // Find the manager for this store
    const mgr = (users || []).find(
      (u) => u.userType === "manager" && String(u.storePc) === String(row.store_pc)
    );
    if (!mgr) { skipped++; continue; }

    const userSubs = (subs[String(mgr.id)] || []);
    if (!userSubs.length) { skipped++; continue; }

    const n = row.open_count;
    const payload = JSON.stringify({
      title: `⏰ ${shiftLabel} Shift Tasks`,
      body: `${n} task${n !== 1 ? "s" : ""} ready for this shift — tap to open the portal`,
      icon: "/icon-192.png",
      url: "/",
      tag: `task-shift-${row.store_pc}-${shiftLabel.replace(" ", "")}`,
    });

    for (const sub of userSubs) {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        if (err.statusCode !== 410 && err.statusCode !== 404) {
          console.error(`task-notify-cron: push failed for manager ${mgr.id}:`, err.statusCode);
        }
        failed++;
      }
    }
  }

  console.log(`task-notify-cron: ${shiftLabel} done — sent=${sent} failed=${failed} skipped=${skipped}`);
  return new Response(JSON.stringify({ ok: true, shift: shiftLabel, date: todayET, sent, failed, skipped }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};
