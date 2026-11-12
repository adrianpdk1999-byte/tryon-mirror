/**
 * STOCK FINDER — shared branded-SKU stock across shops.
 * Google Apps Script backend, bound to one Google Sheet. The page (Index.html) calls doPost with JSON.
 *
 * Sheets:
 *   Stock     : SKU | Brand | Model | Colour | Size | UPC | Description | Photo | Link | Cost | <one column per shop code>
 *   Shops     : Code | Name | PIN (unused) | Active
 *   Users     : UserID | Name | Shop | Password | Role (Staff/Admin) | Active (Y/N)
 *   Logins    : Time | UserID | Name | Shop | Device
 *   Transfers : ID | Requested | From | To | SKU | Qty | Status | RequestedBy | Note | ApprovedBy | ApprovedAt | ReceivedBy | ReceivedAt
 *   Log       : Time | Shop | Type | SKU | Qty | Balance | Ref | Staff | Note
 *
 * Cost is never sent to the page. Staff see only the cost code: RODENSTICK = 1234567890,
 * and the derived RSP: cost x 4, rounded up to the next RM10.
 * Needs the Advanced Drive Service (Drive API v3) for reading scanned DOs.
 */

var SHEET_STOCK = 'Stock', SHEET_SHOPS = 'Shops', SHEET_LOG = 'Log', SHEET_USERS = 'Users',
    SHEET_LOGINS = 'Logins', SHEET_TRANSFERS = 'Transfers';
var FIXED = ['SKU', 'Brand', 'Model', 'Colour', 'Size', 'UPC', 'Description', 'Photo', 'Link', 'Cost'];
var C = { SKU: 0, BRAND: 1, MODEL: 2, COLOUR: 3, SIZE: 4, UPC: 5, DESC: 6, PHOTO: 7, LINK: 8, COST: 9 };
var LOG_HEAD = ['Time', 'Shop', 'Type', 'SKU', 'Qty', 'Balance', 'Ref', 'Staff', 'Note'];
var USER_HEAD = ['UserID', 'Name', 'Shop', 'Password', 'Role', 'Active'];
var LOGIN_HEAD = ['Time', 'UserID', 'Name', 'Shop', 'Device'];
var TR_HEAD = ['ID', 'Requested', 'From', 'To', 'SKU', 'Qty', 'Status', 'RequestedBy', 'Note', 'ApprovedBy', 'ApprovedAt', 'ReceivedBy', 'ReceivedAt'];
var T = { ID: 0, REQ: 1, FROM: 2, TO: 3, SKU: 4, QTY: 5, STATUS: 6, BY: 7, NOTE: 8, APPBY: 9, APPAT: 10, RCVBY: 11, RCVAT: 12 };
var COST_LETTERS = 'RODENSTICK'; // R=1 O=2 D=3 E=4 N=5 S=6 T=7 I=8 C=9 K=0
// Model prefix -> brand. Add more brands here later (e.g. OO: 'Oakley').
var BRAND_PREFIX = { RB: 'Ray-Ban', RX: 'Ray-Ban', RJ: 'Ray-Ban', RY: 'Ray-Ban' };
var SCAN_FOLDER = 'Stock Finder - DO scans', PHOTO_FOLDER = 'Stock Finder - photos';

/* ---------------- web app ---------------- */

function doGet(e) {
  // Test link: add ?test=1 to the web app URL to check the Sheet can be read.
  if (e && e.parameter && e.parameter.test) {
    var out;
    try { var d = getData_(); out = { ok: true, shops: d.shops, items: d.items.length, users: users_().length, at: d.at }; }
    catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
    return json_(out);
  }
  // Plain file + text replace (no template engine, so the page's JavaScript is served untouched).
  var html = HtmlService.createHtmlOutputFromFile('Index').getContent()
    .split('__API_URL__').join(ScriptApp.getService().getUrl());
  return HtmlService.createHtmlOutput(html)
    .setTitle('Stock Finder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

var API = {
  api_login: api_login, api_getData: api_getData, api_recordSales: api_recordSales, api_receive: api_receive,
  api_requestTransfer: api_requestTransfer, api_decideTransfer: api_decideTransfer,
  api_receiveTransfer: api_receiveTransfer, api_cancelTransfer: api_cancelTransfer,
  api_importShop: api_importShop, api_ocr: api_ocr, api_setPhoto: api_setPhoto, api_history: api_history
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API[req.fn];
    if (!fn) throw new Error('Unknown action ' + req.fn + '. The server code may be out of date.');
    out = { ok: true, result: fn.apply(null, req.args || []) };
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return json_(out);
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Run from the editor to create any missing tabs. Safe to run again. */
function setup() {
  sheetOrCreate_(SHEET_SHOPS, ['Code', 'Name', 'PIN', 'Active']);
  sheetOrCreate_(SHEET_STOCK, FIXED);
  sheetOrCreate_(SHEET_LOG, LOG_HEAD);
  sheetOrCreate_(SHEET_USERS, USER_HEAD).getRange('D:D').setNumberFormat('@');
  sheetOrCreate_(SHEET_LOGINS, LOGIN_HEAD);
  sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD);
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

/** Whole-ringgit cost to letters: 384.48 -> 384 -> DIE. */
function costCode(n) {
  n = Math.round(Number(n));
  if (!(n > 0)) return '';
  return String(n).split('').map(function (d) { return COST_LETTERS.charAt((Number(d) + 9) % 10); }).join('');
}

/** Derived RSP: cost x 4, rounded UP to the next RM10 (384.48 -> 1537.92 -> 1540). Works in sen to avoid float slips. */
function rsp(n) {
  n = Number(n);
  if (!(n > 0)) return 0;
  var sen = Math.round(n * 400);          // cost x 4, in sen
  return Math.ceil(sen / 1000) * 10;      // up to the next RM10
}

/* ---------------- sheet helpers ---------------- */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() in the Apps Script editor.');
  return sh;
}
function sheetOrCreate_(name, head) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(sh, width) {
  var n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, width).getValues() : [];
}

function shops_() {
  return rows_(sheet_(SHEET_SHOPS), 4)
    .filter(function (r) { return r[0] && String(r[3] || 'Y').toUpperCase() !== 'N'; })
    .map(function (r) { return { code: String(r[0]).trim(), name: String(r[1] || r[0]).trim() }; });
}

function users_() {
  return rows_(sheetOrCreate_(SHEET_USERS, USER_HEAD), USER_HEAD.length)
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return { id: String(r[0]).trim(), name: String(r[1] || r[0]).trim(), shop: String(r[2] || '').trim(),
        pass: String(r[3]).trim(), admin: /admin/i.test(r[4]), active: String(r[5] || 'Y').toUpperCase() !== 'N' };
    });
}

/** Checks the user ID + password sent with every request. */
function checkUser_(auth) {
  var id = String(auth && auth.user || '').trim().toLowerCase();
  var u = users_().filter(function (x) { return x.id.toLowerCase() === id; })[0];
  if (!u || !u.active || !u.pass || u.pass !== String(auth.pass || '').trim()) {
    throw new Error('Wrong user ID or password. Please log in again.');
  }
  return u;
}
function checkAdmin_(auth) {
  var u = checkUser_(auth);
  if (!u.admin) throw new Error('Only the owner (Admin) can do this.');
  return u;
}
/** The shop a request acts for: staff always act for their own shop; Admin can choose. */
function shopFor_(u, shop) {
  var code = (u.admin && shop) ? shop : u.shop;
  if (!shops_().some(function (s) { return s.code === code; })) throw new Error('Unknown shop "' + code + '". Check the Users tab.');
  return code;
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
  FIXED.forEach(function (h, i) {
    if (head[i] !== h) throw new Error('Stock tab column ' + (i + 1) + ' should be "' + h + '" but is "' + head[i] + '".');
  });
  shops_().forEach(function (s) {
    if (head.indexOf(s.code) < 0) { head.push(s.code); sh.getRange(1, head.length).setValue(s.code).setFontWeight('bold'); }
  });
  var rows = rows_(sh, head.length);
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
function resolve_(st, it, create) {
  var upc = normUpc(it.upc);
  var key = it.sku ? String(it.sku) : skuKey(it.model, it.colour, it.size);
  var i = (key && st.bySku[key] != null) ? st.bySku[key] : (upc && st.byUpc[upc] != null ? st.byUpc[upc] : -1);
  if (i < 0) {
    if (!key || create === false) return -1;
    var model = normModel(it.model || key.split(' ')[0]);
    var r = [key, it.brand || brandOf(model), model, normColour(it.colour), normSize(it.size), upc, it.desc || '', '', '', ''];
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

function fmt_(d) {
  return d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM yyyy HH:mm') : String(d || '');
}

/* ---------------- read ---------------- */

function getData_() {
  var st = loadStock_();
  var shops = shops_();
  var transit = {}, trs = transfers_();
  trs.forEach(function (t) {
    if (t.status !== 'IN TRANSIT') return;
    var m = transit[t.sku] || (transit[t.sku] = {});
    m[t.to] = (m[t.to] || 0) + t.qty;
  });
  var items = st.rows.filter(function (r) { return r[C.SKU]; }).map(function (r) {
    var q = {};
    shops.forEach(function (s) { q[s.code] = Number(r[st.col[s.code]]) || 0; });
    var sku = String(r[C.SKU]);
    return { sku: sku, brand: String(r[C.BRAND]), model: String(r[C.MODEL]), colour: String(r[C.COLOUR]),
      size: String(r[C.SIZE]), upc: String(r[C.UPC]), desc: String(r[C.DESC]), photo: String(r[C.PHOTO]),
      link: String(r[C.LINK] || ''), cost: costCode(r[C.COST]), rsp: rsp(r[C.COST]), qty: q, transit: transit[sku] || {} };
  });
  // open transfers + the most recent closed ones
  var open = trs.filter(function (t) { return t.status === 'PENDING' || t.status === 'IN TRANSIT'; });
  var closed = trs.filter(function (t) { return t.status !== 'PENDING' && t.status !== 'IN TRANSIT'; }).slice(-60);
  return { shops: shops, items: items, transfers: open.concat(closed), at: new Date().toISOString() };
}

function transfers_() {
  return rows_(sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD), TR_HEAD.length)
    .filter(function (r) { return r[T.ID]; })
    .map(function (r) {
      return { id: String(r[T.ID]), requested: fmt_(r[T.REQ]), from: String(r[T.FROM]), to: String(r[T.TO]),
        sku: String(r[T.SKU]), qty: Number(r[T.QTY]) || 0, status: String(r[T.STATUS]), by: String(r[T.BY]),
        note: String(r[T.NOTE] || ''), approvedBy: String(r[T.APPBY] || ''), approvedAt: fmt_(r[T.APPAT]),
        receivedBy: String(r[T.RCVBY] || ''), receivedAt: fmt_(r[T.RCVAT]) };
    });
}

/* ---------------- API (called from the page) ---------------- */

function api_login(id, pass, device) {
  var u = checkUser_({ user: id, pass: pass });
  sheetOrCreate_(SHEET_LOGINS, LOGIN_HEAD).appendRow([new Date(), u.id, u.name, u.shop, String(device || '').slice(0, 200)]);
  return { id: u.id, name: u.name, shop: u.shop, role: u.admin ? 'Admin' : 'Staff' };
}

function api_getData(auth) {
  var u = checkUser_(auth);
  var d = getData_();
  d.user = { id: u.id, name: u.name, shop: u.shop, role: u.admin ? 'Admin' : 'Staff' };
  return d;
}

/** End-of-day sales for one shop. */
function api_recordSales(auth, lines, note, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, code, 'SOLD', st.rows[i][C.SKU], -l.qty, addQty_(st, i, code, -l.qty), '', u.name, note || '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** New stock arriving at a shop (from a supplier DO). */
function api_receive(auth, lines, ref, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, code, 'RECEIVE', st.rows[i][C.SKU], l.qty, addQty_(st, i, code, l.qty), ref || '', u.name, '']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Step 1: a shop asks to send frames to another shop. Stock does not move yet. */
function api_requestTransfer(auth, toShop, lines, note, shop) {
  var u = checkUser_(auth), from = shopFor_(u, shop);
  if (!toShop || toShop === from) throw new Error('Choose a different shop to send to.');
  shopFor_({ admin: true }, toShop);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date();
    var id = 'TR-' + Utilities.formatDate(t, Session.getScriptTimeZone(), 'yyMMdd-HHmmss');
    var rows = [];
    lines.forEach(function (l) {
      var i = resolve_(st, l, false);
      if (i < 0) throw new Error('Not in the stock list: ' + (l.sku || l.model));
      rows.push([id, t, from, toShop, st.rows[i][C.SKU], l.qty, 'PENDING', u.name, note || '', '', '', '', '']);
    });
    if (!rows.length) throw new Error('Add at least one frame.');
    var sh = sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, TR_HEAD.length).setValues(rows);
    return { id: id, lines: rows.length };
  });
}

/** Runs fn on every row of one transfer that has the expected status, then writes the rows back. */
function editTransfer_(id, status, fn) {
  var sh = sheetOrCreate_(SHEET_TRANSFERS, TR_HEAD), v = rows_(sh, TR_HEAD.length), hit = [];
  v.forEach(function (r, i) { if (String(r[T.ID]) === id && String(r[T.STATUS]) === status) hit.push(i); });
  if (!hit.length) throw new Error('Transfer ' + id + ' is no longer ' + status.toLowerCase() + '. Refresh and try again.');
  hit.forEach(function (i) { fn(v[i]); sh.getRange(i + 2, 1, 1, TR_HEAD.length).setValues([v[i]]); });
  return hit.map(function (i) { return v[i]; });
}

/** Step 2 (owner): approve -> frames leave the sending shop and are in transit; or reject. */
function api_decideTransfer(auth, id, approve) {
  var u = checkAdmin_(auth);
  return withLock_(function () {
    var t = new Date();
    if (!approve) {
      editTransfer_(id, 'PENDING', function (r) { r[T.STATUS] = 'REJECTED'; r[T.APPBY] = u.name; r[T.APPAT] = t; });
      return { id: id, status: 'REJECTED' };
    }
    var st = loadStock_(), out = [];
    editTransfer_(id, 'PENDING', function (r) {
      var i = st.bySku[String(r[T.SKU])];
      if (i == null) throw new Error('SKU not found: ' + r[T.SKU]);
      var q = Number(r[T.QTY]) || 0;
      out.push([t, r[T.FROM], 'TRANSFER OUT', r[T.SKU], -q, addQty_(st, i, String(r[T.FROM]), -q), id, u.name, 'to ' + r[T.TO] + ' (approved)']);
      r[T.STATUS] = 'IN TRANSIT'; r[T.APPBY] = u.name; r[T.APPAT] = t;
    });
    saveStock_(st); log_(out);
    return { id: id, status: 'IN TRANSIT' };
  });
}

/** Step 3 (receiving shop): frames arrived -> added to the receiving shop. */
function api_receiveTransfer(auth, id) {
  var u = checkUser_(auth);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    editTransfer_(id, 'IN TRANSIT', function (r) {
      if (!u.admin && String(r[T.TO]) !== u.shop) throw new Error('Only the receiving shop can confirm this transfer.');
      var i = st.bySku[String(r[T.SKU])];
      if (i == null) throw new Error('SKU not found: ' + r[T.SKU]);
      var q = Number(r[T.QTY]) || 0;
      out.push([t, r[T.TO], 'TRANSFER IN', r[T.SKU], q, addQty_(st, i, String(r[T.TO]), q), id, u.name, 'from ' + r[T.FROM]]);
      r[T.STATUS] = 'RECEIVED'; r[T.RCVBY] = u.name; r[T.RCVAT] = t;
    });
    saveStock_(st); log_(out);
    return { id: id, status: 'RECEIVED' };
  });
}

/** The sending shop withdraws a request before it is approved. */
function api_cancelTransfer(auth, id) {
  var u = checkUser_(auth);
  return withLock_(function () {
    editTransfer_(id, 'PENDING', function (r) {
      if (!u.admin && String(r[T.FROM]) !== u.shop) throw new Error('Only the sending shop can cancel this request.');
      r[T.STATUS] = 'CANCELLED'; r[T.APPBY] = u.name; r[T.APPAT] = new Date();
    });
    return { id: id, status: 'CANCELLED' };
  });
}

/** Admin: replace one shop's whole stock with a POS export (stock count). */
function api_importShop(auth, shop, lines, fileName) {
  var u = checkAdmin_(auth);
  lines = cleanLines_(lines);
  return withLock_(function () {
    var st = loadStock_(), t = new Date(), out = [];
    var c = st.col[shop];
    if (c == null) throw new Error('Unknown shop ' + shop);
    st.rows.forEach(function (r) { r[c] = 0; });
    lines.forEach(function (l) {
      var i = resolve_(st, l); if (i < 0) return;
      out.push([t, shop, 'IMPORT', st.rows[i][C.SKU], l.qty, addQty_(st, i, shop, l.qty), fileName || '', u.name, 'stock replaced from POS export']);
    });
    saveStock_(st); log_(out);
    return { saved: out.length };
  });
}

/** Reads a scanned / photographed DO with Google Drive OCR. Returns plain text. */
function api_ocr(auth, files, shop) {
  var u = checkUser_(auth), code = shopFor_(u, shop);
  var folder = folder_(SCAN_FOLDER), text = [];
  (files || []).forEach(function (f) {
    var blob = Utilities.newBlob(Utilities.base64Decode(f.b64), f.mime, code + ' ' + f.name);
    folder.createFile(blob); // keep the original scan for checking later
    var doc = Drive.Files.create({ name: 'OCR tmp ' + f.name, mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'en', fields: 'id' });
    try { text.push(DocumentApp.openById(doc.id).getBody().getText()); }
    finally { DriveApp.getFileById(doc.id).setTrashed(true); }
  });
  return { text: text.join('\n') };
}

/** Saves a product photo to Drive and links it to the SKU. */
function api_setPhoto(auth, sku, b64, mime) {
  checkUser_(auth);
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
function api_history(auth, sku) {
  checkUser_(auth);
  var sh = sheet_(SHEET_LOG), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var start = Math.max(2, n + 2 - 3000); // look at the last 3000 log rows
  var v = sh.getRange(start, 1, n + 2 - start, LOG_HEAD.length).getValues(), out = [];
  for (var i = v.length - 1; i >= 0 && out.length < 25; i--) {
    if (String(v[i][3]) === sku) {
      out.push({ time: fmt_(new Date(v[i][0])), shop: v[i][1], type: v[i][2], qty: v[i][4], bal: v[i][5], ref: v[i][6], staff: v[i][7], note: v[i][8] });
    }
  }
  return out;
}

function folder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
