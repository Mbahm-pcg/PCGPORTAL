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

async function resolveAddress(address) {
  try {
    const aisUrl = `https://api.phila.gov/ais/v1/search/${encodeURIComponent(address)}`;
    const data = await fetchJSON(aisUrl);
    if (data.features && data.features.length > 0) {
      const props = data.features[0].properties;
      return {
        opaAddress: props.opa_address || null,
        streetAddress: props.street_address || null,
        opaOwner: props.opa_owners ? props.opa_owners.join(', ') : null,
      };
    }
  } catch (e) { /* fall through to direct query */ }
  return null;
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
  return `address LIKE '${num}%' AND address LIKE '%${mainStreet}%'`;
}

function buildExactQuery(opaAddress) {
  const clean = opaAddress.replace(/'/g, "''");
  return `address = '${clean}'`;
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
    const resolved = await resolveAddress(address);
    const opaAddr = resolved?.opaAddress;

    let where;
    if (opaAddr) {
      where = buildExactQuery(opaAddr);
    } else {
      where = buildAddressQuery(address);
    }

    const sql = `SELECT permitnumber, permitdescription, permittype, status, typeofwork, contractorname, contractoraddress1, address, permitissuedate, approvedscopeofwork, commercialorresidential, systemofrecord, opa_owner, posse_jobid FROM permits WHERE ${where} ORDER BY permitissuedate DESC LIMIT 25`;
    const url = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}&format=json`;
    const data = await fetchJSON(url);

    if (data.rows?.length === 0 && opaAddr) {
      const fallbackWhere = buildAddressQuery(opaAddr);
      const fallbackSql = `SELECT permitnumber, permitdescription, permittype, status, typeofwork, contractorname, contractoraddress1, address, permitissuedate, approvedscopeofwork, commercialorresidential, systemofrecord, opa_owner, posse_jobid FROM permits WHERE ${fallbackWhere} ORDER BY permitissuedate DESC LIMIT 25`;
      const fallbackUrl = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(fallbackSql)}&format=json`;
      const fallbackData = await fetchJSON(fallbackUrl);
      return { statusCode: 200, headers, body: JSON.stringify({ rows: fallbackData.rows || [], total: fallbackData.total_rows || 0, query: fallbackWhere, resolvedAddress: opaAddr }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ rows: data.rows || [], total: data.total_rows || 0, query: where, resolvedAddress: opaAddr || null }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
