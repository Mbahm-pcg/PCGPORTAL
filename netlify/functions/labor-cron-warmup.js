// labor-cron-warmup.js — Saturday 11:45 PM ET (03:45 UTC Sun)
// Runs labor aggregation 13 minutes before leaderboard-cron so WTD data is current.
exports.handler = require('./labor-cron').handler;
