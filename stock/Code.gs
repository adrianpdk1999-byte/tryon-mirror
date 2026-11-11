/**
 * STOCK FINDER — shared branded-SKU stock across shops.
 * Google Apps Script backend, bound to one Google Sheet.
 *
 * Sheets (created by running setup() once):
 *   Stock    : SKU | Brand | Model | Colour | Size | UPC | Description | Photo | <one column per shop code>
 *   Shops    : Code | Name | PIN | Active
 *   Log      : Time | Shop | Type | SKU | Qty | Balance | Ref | Staff | Note
 *   Settings : Key | Value   (AdminPIN)
 *
 * Needs the Advanced Drive Service (Drive API v3) for reading scanned DOs.
 */

var SHEET_STOCK = 'Stock', SHEET_SHOPS = 'Shops', SHEET_LOG = 'Log', SHEET_SETTINGS = 'Settings';
var FIXED = ['SKU', 'Brand', 'Model', 'Colour', 'Size', 'UPC', 'Description', 'Photo'];
var C = { SKU: 0, BRAND: 1, MODEL: 2, COLOUR: 3, SIZE: 4, UPC: 5, DESC: 6, PHOTO: 7 };
var LOG_HEAD = ['Time', 'Shop', 'Type', 'SKU', 'Qty', 'Balance', 'Ref', 'Staff', 'Note'];
// Model prefix -> brand. Add more brands here later (e.g. OO: 'Oakley').
var BRAND_PREFIX = { RB: 'Ray-Ban', RX: 'Ray-Ban', RJ: 'Ray-Ban', RY: 'Ray-Ban' };
var SCAN_FOLDER = 'Stock Finder - DO scans', PHOTO_FOLDER = 'Stock Finder - photos';

/* ---------------- web app ---------------- */

function doGet(e) {
  // Test link: add ?test=1 to the web app URL to check the Sheet can be read.
  if (e && e.parameter && e.parameter.test) {
    var out;
    try { var d = api_getData(); out = { ok: true, shops: d.shops, items: d.items.length, at: d.at }; }
    catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
    return ContentService.createTextOutput(JSON.stringify(out, null, 1)).setMimeType(ContentService.MimeType.JSON);
  }
  // Plain file + text replace (no template engine, so the page's JavaScript is served untouched).
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent()
    .split('__API_URL__').join(ScriptApp.getService().getUrl());
  return HtmlService.createHtmlOutput(html)
    .setTitle('Stock Finder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Run once from the editor: creates the sheets with headers and sample shops. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  function ensure(name, head, rows) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
      if (rows && rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    }
    return sh;
  }
  ensure(SHEET_SHOPS, ['Code', 'Name', 'PIN', 'Active'], [
    ['S1', 'Shop 1', "'1111", 'Y'],
    ['S2', 'Shop 2', "'2222", 'Y']
  ]);
  ensure(SHEET_STOCK, FIXED.concat(['S1', 'S2']));
  ensure(SHEET_LOG, LOG_HEAD);
  ensure(SHEET_SETTINGS, ['Key', 'Value'], [['AdminPIN', "'9999"]]);
  ss.getSheetByName(SHEET_STOCK).getRange('E:F').setNumberFormat('@'); // keep size / UPC as text
  ss.getSheetByName(SHEET_SHOPS).getRange('C:C').setNumberFormat('@'); // PINs like 0123 stay as typed
  ss.getSheetByName(SHEET_SETTINGS).getRange('B:B').setNumberFormat('@');
}

/* ---------------- JSON API (used by the page) ----------------
 * The page calls this with fetch() instead of google.script.run, because
 * google.script.run hangs when the browser blocks third-party cookies
 * (iPhone Safari, Chrome Incognito). */

var API = {
  api_getData: function () { return api_getData(); },
  api_login: api_login, api_checkAdmin: api_checkAdmin, api_recordSales: api_recordSales,
  api_receive: api_receive, api_transfer: api_transfer, api_importShop: api_importShop,
  api_ocr: api_ocr, api_setPhoto: api_setPhoto, api_history: api_history
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API[req.fn];
    if (!fn) throw new Error('Unknown action ' + req.fn);
    out = { ok: true, result: fn.apply(null, req.args || []) };
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- normalising ---------------- */

function normModel(s) {
  s = String(s || '').toUpperCase().replace(/\s+/g, '');
  // Luxottica prints 0RB2140; some POS print ORB2140 (letter O), OR2140F or OB4105
  return s.replace(/^[0O](?=R[BXJY]?\d|R[BXJY]R?\d)/, '').replace(/^R(?=\d)/, 'RB');
}
function normColour(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }
function normSize(s) { var m = String(s || '').match(/\d{2,3}/); return m ? m[0] : ''; }
function normUpc(s) { return String(s || '').replace(/\D/g, ''); }
function skuKey(model, colour, size) {
  return [normModel(model), normColour(colour), normSize(size)].filter(String).join(' ');
}
function brandOf(model) { return BRAND_PREFIX[normModel(model).slice(0, 2)] || ''; }

/* ---------------- sheet helpers ---------------- */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() first.');
  return sh;
}

function shops_() {
  var v = sheet_(SHEET_SHOPS).getDataRange().getValues().slice(1);
  return v.filter(function (r) { return r[0] && String(r[3] || 'Y').toUpperCase() !== 'N'; })
    .map(function (r) { return { code: String(r[0]).trim(), name: String(r[1] || r[0]).trim(), pin: String(r[2]).trim() }; });
}

function setting_(key) {
  var v = sheet_(SHEET_SETTINGS).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (v[i][0] === key) return String(v[i][1]).trim();
  return '';
}

function checkShop_(auth) {
  var s = shops_().filter(function (x) { return x.code === (auth && auth.shop); })[0];
  if (!s || s.pin !== String(auth.pin || '').trim()) throw new Error('Wrong shop PIN. Please log in again.');
  return s;
}
function checkAdmin_(pin) {
  var a = setting_('AdminPIN');
  if (!a || String(pin || '').trim() !== a) throw new Error('Wrong admin PIN.');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Loads Stock into memory, adding a column for any new shop in the Shops sheet. */
function loadStock_() {
  var sh = sheet_(SHEET_STOCK);
  var lastCol = Math.max(sh.getLastColumn(), FIXED.length);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  shops_().forEach(function (s) {
    if (head.indexOf(s.code) < 0) { head.push(s.code); sh.getRange(1, head.length).setValue(s.code).setFontWeight('bold'); }
  });
  var n = sh.getLastRow() - 1;
  var rows = n > 0 ? sh.getRange(2, 1, n, head.length).getValues() : [];
  var st = { sh: sh, head: head, rows: rows, col: {}, bySku: {}, byUpc: {} };
  head.forEach(function (h, i) { if (i >= FIXED.length && h) st.col[h] = i; });
  rows.forEach(function (r, i) {
    if (r[C.SKU]) st.bySku[String(r[C.SKU])] = i;
    var u = normUpc(r[C.UPC]); if (u) st.byUpc[u] = i;
  });
  return st;
}

function saveStock_(st) {
  if (!st.rows.length) return;
  st.rows.forEach(function (r) { while (r.length < st.head.length) r.push(''); });
  st.sh.getRange(2, 1, st.rows.length, st.head.length).setValues(st.rows);
}

/** Finds (or creates) the row for an item. Returns the row index, or -1. */
function resolve_(st, it) {
  var upc = normUpc(it.upc);
  var key = it.sku ? String(it.sku) : skuKey(it.model, it.colour, it.size);
  var i = (key && st.bySku[key] != null) ? st.bySku[key] : (upc && st.byUpc[upc] != null ? st.byUpc[upc] : -1);
  if (i < 0) {
    if (!key) return -1;
    var model = normModel(it.model || key.split(' ')[0]);
    var r = [key, it.brand || brandOf(model), model, normColour(it.colour), normSize(it.size), upc, it.desc || '', ''];
    while (r.length < st.head.length) r.push(0);
    st.rows.push(r);
    i = st.rows.length - 1;
    st.bySku[key] = i;
    if (upc) st.byUpc[upc] = i;
  } else {
    var row = st.rows[i]; // fill in details we learn later
    if (upc && !normUpc(row[C.UPC])) { row[C.UPC] = upc; st.byUpc[upc] = i; }
    if (it.desc && !row[C.DESC]) row[C.DESC] = it.desc;
  }
  return i;
}

function addQty_(st, i, shop, delta) {
  var c = st.col[shop];
  if (c == null) throw new Error('Unknown shop ' + shop);
  var v = (Number(st.rows[i][c]) || 0) + delta;
  st.rows[i][c] = v;
  return v;
}

function log_(entries) {
  if (!entries.length) return;
  var sh = sheet_(SHEET_LOG);
  sh.getRange(sh.getLastRow() + 1, 1, entries.length, LOG_HEAD.length).setValues(entries);
}

function cleanLines_(lines) {
  return (lines || []).map(function (l) {
    return { sku: l.sku || '', model: l.model, colour: l.colour, size: l.size, upc: l.upc, desc: l.desc, qty: Math.round(Number(l.qty) || 0) };
  }).filter(function (l) { return l.qty > 0 && (l.sku || l.model || l.upc); });
}

/* ---------------- API (called from the page) ---------------- */

/** Everything the page needs for instant search. No PIN needed to look. */
function api_getData() {
  var st = loadStock_();
  var shops = shops_().map(function (s) { return { code: s.code, name: s.name }; });
  var items = st.rows.filter(function (r) { return r[C.SKU]; }).map(function (r) {
    var q = {};
    shops.forEach(function (s) { q[s.code] = Number(r[st.col[s.code]]) || 0; });
    return { sku: String(r[C.SKU]), brand: String(r[C.BRAND]), model: String(r[C.MODEL]), colour: String(r[C.COLOUR]),
      size: String(r[C.SIZE]), upc: String(r[C.UPC]), desc: String(r[C.DESC]), photo: String(r[C.PHOTO]), qty: q };
  });
  return { shops: shops, items: items, at: new Date().toISOString() };
}

function api_login(shop, pin) {
  var s = checkShop_({ shop: shop, pin: pin });
  return { shop: s.code, name: s.name };
}

function api_checkAdmin(pin) { checkAdmin_(pin); return true; }

/** End-of-day sales for the logged-in shop. */
function api_recordSales(auth, lines, staff, note) {
  var shop = checkShop_(auth).code;
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, shop, 'SOLD', st.rows[i][C.SKU], -l.qty, addQty_(st, i, shop, -l.qty), '', staff || '', note || '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** New stock arriving at the logged-in shop (from a supplier DO). */
function api_receive(auth, lines, ref, staff) {
  var shop = checkShop_(auth).code;
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, shop, 'RECEIVE', st.rows[i][C.SKU], l.qty, addQty_(st, i, shop, l.qty), ref || '', staff || '', '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Move frames from the logged-in shop to another shop. */
function api_transfer(auth, toShop, lines, staff, note) {
  var from = checkShop_(auth).code;
  if (!toShop || toShop === from) throw new Error('Choose a different shop to send to.');
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [], ref = 'TR-' + Utilities.formatDate(t, Session.getScriptTimeZone(), 'yyMMdd-HHmm');
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      var sku = st.rows[i][C.SKU];
      out.push([t, from, 'TRANSFER OUT', sku, -l.qty, addQty_(st, i, from, -l.qty), ref, staff || '', 'to ' + toShop + (note ? ' · ' + note : '')]);
      out.push([t, toShop, 'TRANSFER IN', sku, l.qty, addQty_(st, i, toShop, l.qty), ref, staff || '', 'from ' + from + (note ? ' · ' + note : '')]);
    });
    saveStock_(st); log_(out);
    return { saved: out.length / 2, ref: ref };
  });
}

/** Admin: replace one shop's whole stock with a POS export (stock count). */
function api_importShop(adminPin, shop, lines, fileName) {
  checkAdmin_(adminPin);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    var c = st.col[shop];
    if (c == null) throw new Error('Unknown shop ' + shop);
    st.rows.forEach(function (r) { r[c] = 0; });
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, shop, 'IMPORT', st.rows[i][C.SKU], l.qty, addQty_(st, i, shop, l.qty), fileName || '', 'admin', 'stock replaced from POS export']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Reads a scanned / photographed DO with Google Drive OCR. Returns plain text. */
function api_ocr(auth, files) {
  var shop = checkShop_(auth).code;
  var folder = folder_(SCAN_FOLDER), text = [];
  (files || []).forEach(function (f) {
    var blob = Utilities.newBlob(Utilities.base64Decode(f.b64), f.mime, shop + ' ' + f.name);
    folder.createFile(blob); // keep the original scan for checking later
    var doc = Drive.Files.create({ name: 'OCR tmp ' + f.name, mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'en', fields: 'id' });
    try { text.push(DocumentApp.openById(doc.id).getBody().getText()); }
    finally { DriveApp.getFileById(doc.id).setTrashed(true); }
  });
  return { text: text.join('\n') };
}

/** Saves a product photo to Drive and links it to the SKU. */
function api_setPhoto(auth, sku, b64, mime) {
  checkShop_(auth);
  var f = folder_(PHOTO_FOLDER).createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, sku + '.jpg'));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800';
  return withLock_(function () {
    var st = loadStock_(), i = st.bySku[sku];
    if (i == null) throw new Error('SKU not found: ' + sku);
    st.sh.getRange(i + 2, C.PHOTO + 1).setValue(url);
    return { photo: url };
  });
}

/** Last movements for one SKU (newest first). */
function api_history(sku) {
  var sh = sheet_(SHEET_LOG), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var start = Math.max(2, n + 2 - 3000); // look at the last 3000 log rows
  var v = sh.getRange(start, 1, n + 2 - start, LOG_HEAD.length).getValues(), out = [];
  for (var i = v.length - 1; i >= 0 && out.length < 25; i--) {
    if (String(v[i][3]) === sku) {
      out.push({ time: Utilities.formatDate(new Date(v[i][0]), Session.getScriptTimeZone(), 'd MMM yyyy HH:mm'),
        shop: v[i][1], type: v[i][2], qty: v[i][4], bal: v[i][5], ref: v[i][6], staff: v[i][7], note: v[i][8] });
    }
  }
  return out;
}

function folder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
