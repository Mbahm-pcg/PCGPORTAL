const { test } = require('node:test');
const assert = require('node:assert');
const { parseNdcpOrder, qpDecode, classifyType, num } = require('./ndcp-parse');

// Synthetic fixture shaped like a real natdcp.com order email: quoted-printable
// encoded (`=3D` for '=', a trailing '=' soft line break), 3-column BILL/SHIP table,
// summary + dates key/value pairs, two category subtotals, and two line-item
// categories. Values are made up — no production data.
const SAMPLE = [
  '<div class=3D"font12">',
  '<h4>Order Detail: Order #: 18128129 scheduled ship 06/03/2026 </h4>',
  '<table><thead><tr>',
  '<th class=3D"leftAlign">BILL TO</th><td></td><th class=3D"leftAlign">SHIP TO </th>',
  '</tr></thead><tbody>',
  '<tr><td>358933</td><td></td><td>358933</td></tr>',
  '<tr><td>PCG 2 LLC</td><td></td><td>PCG 2 LLC</td></tr>',
  '<tr><td>1402 Brace Rd</td><td></td><td>1402 Brace Rd</td></tr>',
  '<tr><td>Cherry Hill, NJ 08034</td><td></td><td>Cherry Hill, NJ 08034</td></tr>',
  '</tbody></table>',
  '<table><tbody>',
  '<tr><td>Order Type:</td><td class=3D"rightAlign">Std Order Shipment</td></tr>',
  '<tr><td>Shipped Via:</td><td class=3D"rightAlign">Scheduled DCP Truck</td></tr>',
  '<tr><td>13 - Food Cost-Retail </td><td class=3D"rightAlign">3,819.94 </td></tr>',
  '<tr><td>20 - Paper Goods </td><td class=3D"rightAlign">1,104.05 </td></tr>',
  '<tr><td>Item Subtotal:</td><td class=3D"rightAlign">6994.23</td></tr>',
  '<tr><td>Tax:</td><td class=3D"rightAlign">22.93</td></tr>',
  '<tr><td>NDCP Beverage Discount:</td><td class=3D"rightAlign">43.79</td></tr>',
  '<tr><td>Total Order:</td><td class=3D"rightAlign">6984.61</td></tr>',
  '<tr><td>Balance Due:</td><td class=3D"rightAlign">6984.61</td></tr>',
  '</tbody></table>',
  '<table><tbody>',
  '<tr><td>Created: </td><td class=3D"rightAlign">06/01/2026 9:14:38 AM EDT</td>',
  '<td></td><td>Created By: </td><td class=3D"rightAlign">Nitin Patel </td></tr>',
  '<tr><td>Ordered:</td><td class=3D"rightAlign">06/01/2026</td>',
  '<td></td><td>Warehouse:</td><td class=3D"rightAlign">Westampton</td></tr>',
  '<tr><td>Shipped:</td><td class=3D"rightAlign">06/03/2026 </td>',
  '<td></td><td>Terms:</td><td class=3D"rightAlign">ACH 10 DAYS</td></tr>',
  '</tbody></table>',
  '<!-- Part 2: Item Details -->',
  '<table><tbody>',
  '<tr><th class=3D"leftAlign">Qty Ordered</th><th>Qty Available</th><th>Item Number</th>',
  '<th>Item Desc.</th><th>UOM</th><th>Div</th><th>Tax</th><th>Price ($)</th><th>Ext ($)</th></tr>',
  '<tr><th colspan=3D"9">Coffee</th></tr>',
  '<tr><td>2</td><td>2</td><td>200000 </td><td>Coffee 6/5 Whole Be=',  // soft line break mid-value
  'an 30 pounds </td><td>CS</td><td>13</td><td>N</td><td>145.66</td><td>291.31</td></tr>',
  '<tr><th colspan=3D"9">Paper Goods</th></tr>',
  '<tr><td>5</td><td>5</td><td>500123 </td><td>10oz Hot Cup 1000ct </td>',
  '<td>CS</td><td>20</td><td>N</td><td>42.10</td><td>210.50</td></tr>',
  '</tbody></table></div>',
].join('\n');

const META = {
  subject: 'New Order',
  from: 'do_not_reply@natdcp.com',
  date: '2026-06-01T13:15:09.000Z',
  messageId: 'msg-abc-123',
};

test('qpDecode reverses =3D and soft line breaks', () => {
  assert.equal(qpDecode('width=3D"100%"'), 'width="100%"');
  assert.equal(qpDecode('Whole Be=\nan'), 'Whole Bean');
});

test('classifyType maps subjects to email types', () => {
  assert.equal(classifyType('New Order'), 'new');
  assert.equal(classifyType('Order Change'), 'revision');
  assert.equal(classifyType('Revised Order'), 'revision');
  assert.equal(classifyType('Order Cancellation'), 'cancel');
  assert.equal(classifyType('Random'), 'unknown');
});

test('num strips commas and dollar signs', () => {
  assert.equal(num('6,994.23'), 6994.23);
  assert.equal(num(' $42.10 '), 42.10);
  assert.equal(num(''), null);
});

test('parseNdcpOrder extracts the order header and store', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  assert.equal(o.orderNumber, '18128129');
  assert.equal(o.headerShipDate, '06/03/2026');
  assert.equal(o.emailType, 'new');
  assert.equal(o.account, '358933');
  assert.equal(o.storeName, 'PCG 2 LLC');
  assert.equal(o.messageId, 'msg-abc-123');
});

test('parseNdcpOrder extracts shipping/order metadata', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  assert.equal(o.orderType, 'Std Order Shipment');
  assert.equal(o.shipVia, 'Scheduled DCP Truck');
  assert.equal(o.warehouse, 'Westampton');
  assert.equal(o.terms, 'ACH 10 DAYS');
  assert.equal(o.createdBy, 'Nitin Patel');
  assert.equal(o.dates.ordered, '06/01/2026');
  assert.equal(o.dates.shipped, '06/03/2026');
});

test('parseNdcpOrder extracts totals', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  assert.equal(o.totals.itemSubtotal, 6994.23);
  assert.equal(o.totals.tax, 22.93);
  assert.equal(o.totals.beverageDiscount, 43.79);
  assert.equal(o.totals.totalOrder, 6984.61);
  assert.equal(o.totals.balanceDue, 6984.61);
});

test('parseNdcpOrder extracts category subtotals', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  const retail = o.categorySubtotals.find((c) => c.code === '13');
  assert.ok(retail, 'should find category 13');
  assert.equal(retail.label, 'Food Cost-Retail');
  assert.equal(retail.amount, 3819.94);
  const paper = o.categorySubtotals.find((c) => c.code === '20');
  assert.equal(paper.amount, 1104.05);
});

test('parseNdcpOrder extracts line items with categories and prices', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  assert.equal(o.itemCount, 2);
  const coffee = o.lineItems[0];
  assert.equal(coffee.category, 'Coffee');
  assert.equal(coffee.qtyOrdered, 2);
  assert.equal(coffee.itemNumber, '200000');
  assert.equal(coffee.desc, 'Coffee 6/5 Whole Bean 30 pounds'); // soft break rejoined
  assert.equal(coffee.uom, 'CS');
  assert.equal(coffee.div, '13');
  assert.equal(coffee.price, 145.66);
  assert.equal(coffee.ext, 291.31);
  const cup = o.lineItems[1];
  assert.equal(cup.category, 'Paper Goods');
  assert.equal(cup.itemNumber, '500123');
  assert.equal(cup.ext, 210.50);
});

test('parseNdcpOrder does not pull item rows into the key/value map', () => {
  const o = parseNdcpOrder(SAMPLE, META);
  // The item table's tax/price cells must not leak into category subtotals.
  assert.ok(o.categorySubtotals.every((c) => /Food Cost|Paper/.test(c.label)));
});
