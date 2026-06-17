import https from 'node:https';

const ZONING_CODES = {
  'RSA-1':'Residential Single-Family Attached (Larger Lots)','RSA-2':'Residential Single-Family Attached (Small Lots)',
  'RSA-3':'Residential Single-Family Attached (Typical Row)','RSA-4':'Residential Single-Family Attached (Compact)',
  'RSA-5':'Residential Single-Family Attached (Very Compact)','RSD-1':'Residential Single-Family Detached (Large Lots)',
  'RSD-2':'Residential Single-Family Detached (Medium Lots)','RSD-3':'Residential Single-Family Detached (Small Lots)',
  'RM-1':'Residential Multi-Family (Low Density)','RM-2':'Residential Multi-Family (Medium Density)',
  'RM-3':'Residential Multi-Family (Medium-High Density)','RM-4':'Residential Multi-Family (High Density)',
  'RTA-1':'Residential Two-Family Attached',
  'CMX-1':'Neighborhood Commercial Mixed-Use (Smallest Scale)','CMX-2':'Neighborhood Commercial Mixed-Use',
  'CMX-2.5':'Neighborhood Center Commercial Mixed-Use','CMX-3':'Community Commercial Mixed-Use',
  'CMX-4':'Center City Commercial Mixed-Use','CMX-5':'Center City Core Commercial Mixed-Use',
  'CA-1':'Auto-Oriented Commercial (Low Intensity)','CA-2':'Auto-Oriented Commercial (High Intensity)',
  'I-1':'Light Industrial','I-2':'Medium Industrial','I-3':'Heavy Industrial',
  'ICMX':'Industrial Commercial Mixed-Use','IRMX':'Industrial Residential Mixed-Use',
  'SP-INS':'Special Purpose — Institutional','SP-STA':'Special Purpose — Stadium',
  'SP-AIR':'Special Purpose — Airport','SP-ENT':'Special Purpose — Entertainment',
  'SP-PO-A':'Special Purpose — Parks & Open Space (Active)','SP-PO-P':'Special Purpose — Parks & Open Space (Passive)',
};

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

async function getAISData(address) {
  const aisUrl = `https://api.phila.gov/ais/v1/search/${encodeURIComponent(address)}`;
  const data = await fetchJSON(aisUrl);
  if (data.features && data.features.length > 0) {
    return data.features[0].properties;
  }
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

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers });

  const searchParams = new URL(request.url).searchParams;
  const address = (searchParams.get('address') || '').trim();
  const type = (searchParams.get('type') || 'permits').toLowerCase();

  if (!address) {
    return new Response(JSON.stringify({ error: 'address parameter required' }), { status: 400, headers });
  }

  try {
    const ais = await getAISData(address);

    if (type === 'zoning') {
      if (!ais) {
        return new Response(JSON.stringify({ error: 'Address not found in Philadelphia AIS', zoning: null }), { status: 200, headers });
      }
      const code = ais.zoning || '';
      return new Response(JSON.stringify({
        zoning: {
          code,
          description: ZONING_CODES[code] || code,
          owner: ais.opa_owners ? ais.opa_owners.join(', ') : '',
          opaAddress: ais.opa_address || '',
          opaAccountNum: ais.opa_account_num || '',
          liDistrict: ais.li_district || '',
          planningDistrict: ais.planning_district || '',
          councilDistrict: ais.council_district_2024 || '',
          historicDistrict: ais.historic_district || '',
          zipCode: ais.zip_code || '',
          rco: ais.zoning_rco || '',
        }
      }), { status: 200, headers });
    }

    const opaAddr = ais?.opa_address || null;
    let where = opaAddr ? `address = '${opaAddr.replace(/'/g, "''")}'` : buildAddressQuery(address);

    const sql = `SELECT permitnumber, permitdescription, permittype, status, typeofwork, contractorname, contractoraddress1, address, permitissuedate, approvedscopeofwork, commercialorresidential, systemofrecord, opa_owner, posse_jobid FROM permits WHERE ${where} ORDER BY permitissuedate DESC LIMIT 25`;
    const url = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}&format=json`;
    const data = await fetchJSON(url);

    if (data.rows?.length === 0 && opaAddr) {
      const fallbackWhere = buildAddressQuery(opaAddr);
      const fallbackSql = `SELECT permitnumber, permitdescription, permittype, status, typeofwork, contractorname, contractoraddress1, address, permitissuedate, approvedscopeofwork, commercialorresidential, systemofrecord, opa_owner, posse_jobid FROM permits WHERE ${fallbackWhere} ORDER BY permitissuedate DESC LIMIT 25`;
      const fallbackUrl = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(fallbackSql)}&format=json`;
      const fallbackData = await fetchJSON(fallbackUrl);
      return new Response(JSON.stringify({ rows: fallbackData.rows || [], total: fallbackData.total_rows || 0, query: fallbackWhere, resolvedAddress: opaAddr }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ rows: data.rows || [], total: data.total_rows || 0, query: where, resolvedAddress: opaAddr || null }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
