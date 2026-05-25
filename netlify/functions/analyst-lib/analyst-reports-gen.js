// analyst-reports-gen.js — Report artifact storage layer
const { cacheLoad, cacheSave } = require('./analyst-cache');

function generateReportId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `rpt_${ts}_${rand}`;
}

async function saveReport(artifact) {
  if (!artifact.id) artifact.id = generateReportId();
  if (!artifact.createdAt) artifact.createdAt = new Date().toISOString();
  await cacheSave(`analyst/reports/${artifact.id}`, artifact);
  const index = (await cacheLoad('analyst/reports-index')) || [];
  index.unshift({
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    scope: artifact.scope,
    createdAt: artifact.createdAt,
    trigger: artifact.trigger,
    createdBy: artifact.createdBy,
  });
  if (index.length > 200) index.length = 200;
  await cacheSave('analyst/reports-index', index);
  return artifact.id;
}

async function loadReport(id) {
  return cacheLoad(`analyst/reports/${id}`);
}

async function getReportsIndex() {
  return (await cacheLoad('analyst/reports-index')) || [];
}

async function markReportRead(userId, reportId) {
  const key = `analyst/reports-read/${userId}`;
  const read = (await cacheLoad(key)) || [];
  if (!read.includes(reportId)) {
    read.push(reportId);
    if (read.length > 500) read.splice(0, read.length - 500);
    await cacheSave(key, read);
  }
}

async function getReadReportIds(userId) {
  return (await cacheLoad(`analyst/reports-read/${userId}`)) || [];
}

module.exports = { generateReportId, saveReport, loadReport, getReportsIndex, markReportRead, getReadReportIds };
