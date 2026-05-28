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

function buildAddressQuery(address) {
  const clean = address.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  const parts = clean.split(/\s+/);
  const num = parts[0];
  const streetWords = parts.slice(1)
    .filter(w => !['OLD', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'THE'].includes(w));
  if (!num || !/^\d+$/.test(num)) {
    return `address LIKE '%${clean.replace(/'/g, "''")}%'`;
  }
  if (streetWords.length === 0) {
    return `address LIKE '${num}%'`;
  }
  const mainStreet = streetWords[0].replace(/'/g, "''");
  return `address LIKE '${num} %' AND address LIKE '%${mainStreet}%'`;
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
    const where = buildAddressQuery(address);
    const sql = `SELECT permitnumber, permitdescription, permittype, status, typeofwork, contractorname, address, permitissuedate, approvedscopeofwork, commercialorresidential FROM permits WHERE ${where} ORDER BY permitissuedate DESC LIMIT 25`;
    const url = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}&format=json`;
    const data = await fetchJSON(url);
    return { statusCode: 200, headers, body: JSON.stringify({ rows: data.rows || [], total: data.total_rows || 0, query: where }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
