// PCG Portal — Scheduled Cron Wrapper for Pulse Notifications
// Runs daily at 9 PM ET (2 AM UTC), calls pulse-notify handler directly

const { handler: pulseHandler } = require('./pulse-notify');

exports.handler = async (event) => {
  console.log('Pulse cron triggered at', new Date().toISOString());
  // Call the pulse-notify handler with a simulated scheduled event
  return pulseHandler({ ...event, httpMethod: null });
};
