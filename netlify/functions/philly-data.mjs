import https from 'node:https';

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

function cartoQuery(sql) {
  const url = `https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}&format=json`;
  return fetchJSON(url).then(d => d.rows || []).catch(() => []);
}

function esc(s) { return (s || '').replace(/'/g, "''"); }

async function getAISData(address) {
  const url = `https://api.phila.gov/ais/v1/search/${encodeURIComponent(address)}`;
  const data = await fetchJSON(url);
  if (data.features && data.features.length > 0) {
    const props = data.features[0].properties;
    const coords = data.features[0].geometry?.coordinates;
    return { props, lng: coords?.[0], lat: coords?.[1] };
  }
  return null;
}

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers });

  const address = (new URL(request.url).searchParams.get('address') || '').trim();
  if (!address) {
    return new Response(JSON.stringify({ error: 'address parameter required' }), { status: 400, headers });
  }

  try {
    const ais = await getAISData(address).catch(() => null);
    const opaAddr = ais?.props?.opa_address || address.toUpperCase();
    const lng = ais?.lng;
    const lat = ais?.lat;
    const addrEsc = esc(opaAddr);
    const radius = 0.004;

    const [property, licenses, violations, complaints311, crime, appeals] = await Promise.all([
      cartoQuery(`SELECT market_value, sale_price, sale_date, year_built, building_code_description, total_area, total_livable_area, number_stories, zoning, category_code_description, owner_1, owner_2, exterior_condition, interior_condition, taxable_building, taxable_land, parcel_number, location FROM opa_properties_public WHERE location LIKE '${addrEsc}%' LIMIT 1`),

      cartoQuery(`SELECT licensetype, licensestatus, legalname, business_name, initialissuedate, mostrecentissuedate, expirationdate, address FROM business_licenses WHERE address LIKE '${addrEsc}%' ORDER BY mostrecentissuedate DESC LIMIT 20`),

      cartoQuery(`SELECT violationcode, violationcodetitle, violationstatus, violationdate, violationresolutiondate, casestatus, casenumber, address FROM violations WHERE address LIKE '${addrEsc}%' ORDER BY violationdate DESC LIMIT 20`),

      (lng && lat)
        ? cartoQuery(`SELECT service_name, status, requested_datetime, closed_datetime, address FROM public_cases_fc WHERE lat BETWEEN ${lat - radius} AND ${lat + radius} AND lon BETWEEN ${lng - radius} AND ${lng + radius} AND requested_datetime >= (NOW() - INTERVAL '6 months') ORDER BY requested_datetime DESC LIMIT 30`)
        : Promise.resolve([]),

      (lng && lat)
        ? cartoQuery(`SELECT text_general_code, dispatch_date, dispatch_time, location_block FROM incidents_part1_part2 WHERE point_y BETWEEN ${lat - radius} AND ${lat + radius} AND point_x BETWEEN ${lng - radius} AND ${lng + radius} AND dispatch_date >= (NOW() - INTERVAL '90 days') ORDER BY dispatch_date DESC LIMIT 50`)
        : Promise.resolve([]),

      cartoQuery(`SELECT appealno, processeddate, descriptionofproject, applicstatus, appealgrounds, decision, decisiondate, address FROM li_appeals WHERE address LIKE '${addrEsc}%' ORDER BY processeddate DESC LIMIT 10`),
    ]);

    const crimeSummary = {};
    crime.forEach(c => {
      const t = c.text_general_code || 'Other';
      crimeSummary[t] = (crimeSummary[t] || 0) + 1;
    });

    const sr311Summary = {};
    complaints311.forEach(c => {
      const t = c.service_name || 'Other';
      sr311Summary[t] = (sr311Summary[t] || 0) + 1;
    });

    return new Response(JSON.stringify({
      resolvedAddress: opaAddr,
      property: property[0] || null,
      licenses,
      violations,
      complaints311: { total: complaints311.length, byType: sr311Summary, recent: complaints311.slice(0, 10) },
      crime: { total: crime.length, byType: crimeSummary, recent: crime.slice(0, 10) },
      appeals,
      zoning: ais?.props ? {
        code: ais.props.zoning || '',
        councilDistrict: ais.props.council_district_2024 || '',
        planningDistrict: ais.props.planning_district || '',
        liDistrict: ais.props.li_district || '',
        policeDistrict: ais.props.police_district || '',
        zipCode: ais.props.zip_code || '',
      } : null,
    }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
