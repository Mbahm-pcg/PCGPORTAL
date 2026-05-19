// HTTP-callable wrapper for leaderboard-announce-cron (Netlify blocks direct HTTP to scheduled functions)
exports.handler = require('./leaderboard-announce-cron').handler;
