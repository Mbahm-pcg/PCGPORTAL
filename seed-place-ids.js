// One-time script: look up Google Place IDs for all Dunkin' stores and seed the blob
const https = require('https');

const API_KEY = 'AIzaSyCZDw2hK8kZnsYELxIhq7ikdbb34axx9NI';

const STORES = [
  { pc:"339616", name:"Wadsworth", address:"1630 W Wadsworth Ave", city:"Philadelphia", state:"PA" },
  { pc:"340794", name:"Front", address:"6190 North Front Street", city:"Philadelphia", state:"PA" },
  { pc:"351099", name:"Sonic", address:"15 Bustleton Pike", city:"Feasterville", state:"PA" },
  { pc:"351259", name:"Rosemore", address:"1069 W County Line Rd", city:"Warminster", state:"PA" },
  { pc:"302642", name:"County Line", address:"2112 County Line Rd", city:"Huntingdon Valley", state:"PA" },
  { pc:"352894", name:"Street Rd", address:"110 E Street Rd", city:"Feasterville", state:"PA" },
  { pc:"341350", name:"Yardley", address:"1050 Stony Hill Rd", city:"Yardley", state:"PA" },
  { pc:"337839", name:"Warrington", address:"334 Easton Rd", city:"Warrington", state:"PA" },
  { pc:"330338", name:"Drexel Hill", address:"5060 Township Line Rd", city:"Drexel Hill", state:"PA" },
  { pc:"337063", name:"Sharon Hill", address:"1100 Chester Pike", city:"Sharon Hill", state:"PA" },
  { pc:"343832", name:"Lansdowne", address:"23 E. Baltimore Avenue", city:"Lansdowne", state:"PA" },
  { pc:"304669", name:"Collingdale", address:"5 Macdade Boulevard", city:"Collingdale", state:"PA" },
  { pc:"355146", name:"Gallery", address:"901 Market Street", city:"Philadelphia", state:"PA" },
  { pc:"300496", name:"Cobbs Creek", address:"7000 Chester Ave", city:"Philadelphia", state:"PA" },
  { pc:"304863", name:"18th St", address:"2654 S. 18th St", city:"Philadelphia", state:"PA" },
  { pc:"354561", name:"Carlisle", address:"2640 S. Carlisle St", city:"Philadelphia", state:"PA" },
  { pc:"332393", name:"Lindbergh", address:"7601 Lindbergh Blvd", city:"Philadelphia", state:"PA" },
  { pc:"341167", name:"5th Street", address:"4017 N 5th St", city:"Philadelphia", state:"PA" },
  { pc:"340870", name:"Hunting Park", address:"221 W Hunting Park Ave", city:"Philadelphia", state:"PA" },
  { pc:"335981", name:"Lehigh", address:"532 W Lehigh Ave", city:"Philadelphia", state:"PA" },
  { pc:"353150", name:"Bakers Square", address:"2749 W Hunting Park Ave", city:"Philadelphia", state:"PA" },
  { pc:"351050", name:"Allegheny", address:"2145 W Allegheny Ave", city:"Philadelphia", state:"PA" },
  { pc:"345985", name:"Wissahickon", address:"5051 Wissahickon Ave", city:"Philadelphia", state:"PA" },
  { pc:"356374", name:"Montgomeryville", address:"738 Bethlehem Pike", city:"Montgomeryville", state:"PA" },
  { pc:"353843", name:"Tollgate", address:"1110 West End Blvd", city:"Quakertown", state:"PA" },
  { pc:"353047", name:"Silverdale", address:"103 South Baringer Ave", city:"Silverdale", state:"PA" },
  { pc:"340538", name:"Easton", address:"4460 Easton Ave", city:"Bethlehem", state:"PA" },
  { pc:"343079", name:"Downingtown", address:"376 W. Uwchlan Ave", city:"Downingtown", state:"PA" },
  { pc:"342144", name:"Westchester", address:"750 Miles Rd", city:"West Chester", state:"PA" },
  { pc:"364295", name:"Lionville", address:"80 E Uwchlan Ave", city:"Exton", state:"PA" },
  { pc:"365361", name:"Little Welsh", address:"2301 Welsh Rd", city:"Philadelphia", state:"PA" },
  { pc:"310382", name:"Grant", address:"1619 Grant Ave", city:"Philadelphia", state:"PA" },
  { pc:"332941", name:"Bustleton", address:"9834 Bustleton Ave", city:"Philadelphia", state:"PA" },
  { pc:"343497", name:"Red Lion", address:"842 Red Lion Rd", city:"Philadelphia", state:"PA" },
  { pc:"302446", name:"Little Red Lion", address:"10050 Roosevelt Blvd", city:"Philadelphia", state:"PA" },
  { pc:"337079", name:"Holme Circle", address:"8401 Frankford Ave", city:"Philadelphia", state:"PA" },
  { pc:"345986", name:"Willits", address:"3170 Willits Rd", city:"Philadelphia", state:"PA" },
  { pc:"364412", name:"8200", address:"8200 Bustleton Ave", city:"Philadelphia", state:"PA" },
  { pc:"345489", name:"Oxford", address:"5801 Oxford Ave", city:"Philadelphia", state:"PA" },
  { pc:"336372", name:"Elkins Park", address:"2 Township Line Rd", city:"Elkins Park", state:"PA" },
  { pc:"358933", name:"Brace Rd", address:"2260 N 5th Street Hwy", city:"Reading", state:"PA" },
  { pc:"354865", name:"Quakertown", address:"1478 W Broad St", city:"Quakertown", state:"PA" },
  { pc:"353689", name:"Fort Washington", address:"515 Pennsylvania Ave", city:"Fort Washington", state:"PA" },
  { pc:"342184", name:"Lansdale", address:"1551 N Broad St", city:"Lansdale", state:"PA" },
  { pc:"356316", name:"BJ's", address:"311 Commerce Blvd", city:"Fairless Hills", state:"PA" },
];

function searchPlace(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ textQuery: query });
    const req = https.request({
      hostname: 'places.googleapis.com',
      port: 443,
      path: '/v1/places:searchText',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const placeIds = {};
  let found = 0, missed = 0;

  for (const store of STORES) {
    const query = `Dunkin' ${store.address}, ${store.city}, ${store.state}`;
    try {
      const result = await searchPlace(query);
      if (result.places && result.places.length > 0) {
        const place = result.places[0];
        placeIds[store.pc] = place.id;
        found++;
        console.log(`✓ ${store.name} (${store.pc}) → ${place.id} — ${place.formattedAddress}`);
      } else {
        missed++;
        console.log(`✗ ${store.name} (${store.pc}) — no results for: ${query}`);
      }
    } catch (e) {
      missed++;
      console.log(`✗ ${store.name} (${store.pc}) — error: ${e.message}`);
    }
    await sleep(200); // rate limit
  }

  console.log(`\nFound: ${found}/${STORES.length}, Missed: ${missed}`);

  // Save to blob via storage function
  console.log('\nSeeding pcg_store_place_ids blob...');
  const saveBody = JSON.stringify({ action: 'save', key: 'pcg_store_place_ids', data: placeIds });
  const saveReq = https.request({
    hostname: 'pcg-ops.netlify.app', port: 443,
    path: '/.netlify/functions/storage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(saveBody) },
  }, res => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      console.log('Save result:', raw);
      console.log('\nPlace IDs map:', JSON.stringify(placeIds, null, 2));
    });
  });
  saveReq.write(saveBody);
  saveReq.end();
}

main().catch(console.error);
