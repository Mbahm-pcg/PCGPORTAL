// HTTP-callable wrapper for leaderboard-cron (Netlify blocks direct HTTP to scheduled functions)
exports.handler = require('./leaderboard-cron').handler;
