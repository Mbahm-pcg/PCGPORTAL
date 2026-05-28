const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const address = (event.queryStringParameters?.address || '').trim();
  if (!address) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'address parameter required' }) };
  }

  try {
    const sql = `SELECT permitnumber, permitdescription, status, typeofwork, applicantname, contractorname, mostrecentinsp, address, approveddate, issueddate, geocode_x, geocode_y FROM permits WHERE UPPER(address) LIKE '%${address.replace(/'/g, "''")}%' ORDER BY issueddate DESC LIMIT 20`;
    const url = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}&format=json`;
    const data = await fetchJSON(url);
    return { statusCode: 200, headers, body: JSON.stringify({ rows: data.rows || [], total: data.total_rows || 0 }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
