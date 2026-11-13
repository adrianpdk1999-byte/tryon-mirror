# Stock Finder: shared Ray-Ban stock across all shops

Staff can see straight away which shop has a frame. It does not depend on any POS: every shop uses the same phone page.

- **Find**: type `2140 901` (or scan a UPC) to see the quantity in every shop. Tap an item for its photo and its movements.
- **Sold today**: at closing, staff add the frames sold that day and press Save. The stock comes off their shop.
- **Receive**: photograph or upload the paper/scanned DO. Google reads it and fills in the list. Staff check each line against the paper and save.
- **Transfer**: send frames to another shop. They come off this shop and go onto the other one in one step.
- **More → Admin**: load each shop's stock from its POS export (Excel/CSV). This replaces that shop's counts.

**App link:** https://adrianpdk1999-byte.github.io/tryon-mirror/stock/Index.html

### Logins, cost codes, transfers
- **Users tab**: one row per person: `UserID | Name | Shop | Password | Role (Staff/Admin) | Active (Y/N)`. Set Active to `N` to block someone. Change a password by editing the cell; that person is logged out on their next refresh.
- **Logins tab**: every login, with time, user, shop and device.
- **Adjust column (Users tab, column G)**: who may adjust stock counts. `Y` = their own shop, `ALL` = any shop, blank = no. Admin can always adjust.
- **Report tab (app)**: Export (stock list to Excel, any shop/brand), Adjust (set counted quantity with a reason; logged as ADJUST), Activity (all movements by shop/type/date, to Excel), Import (Admin; replaces a shop's stock from a POS export). Tap any frame for its full activity, including the opening stock loaded from the POS reports.
- **Cost code**: type the cost in RM in the Stock tab's **Cost** column. Staff see only the letters (RODENSTICK = 1234567890, whole ringgit: 384.48 → 384 → DIE). The cost itself never reaches the app.
- **Transfers**: a shop requests → the Admin approves or rejects in the Transfer tab (stock leaves the sending shop on approval and shows "+n coming") → the receiving shop taps **Received** (stock is added). Every step is in the **Transfers** and **Log** tabs.
- **Admin** users can switch the shop they work as (More tab) and load POS stock exports.

All data lives in **one Google Sheet** that you own. You can open it any time to check or fix numbers.

---

## One-time setup (about 15 minutes, owner only)

1. **Create the Sheet.** In Google Drive: New → Google Sheets. Name it `Stock Finder`.
2. **Add the code.** In the Sheet: Extensions → Apps Script.
   - Replace everything in `Code.gs` with the contents of [`Code.gs`](Code.gs).
   - Click **+** next to Files → **HTML**, name it `Index` (exactly), and paste in [`Index.html`](Index.html).
3. **Turn on Drive (needed to read scanned DOs).** In the Apps Script editor's left bar, click **Services +** → choose **Drive API** → keep version **v3** → Add.
4. **Create the sheets.** At the top, pick the function `setup` → **Run**. Approve the permissions it asks for (it is your own script).
   Back in the Sheet you will now see the tabs **Stock, Shops, Log, Settings**.
5. **Enter your shops.** Tab **Shops**: one row per shop.
   | Code | Name | PIN | Active |
   |---|---|---|---|
   | KLCC | Suria KLCC | 4821 | Y |
   | MV | Mid Valley | 7305 | Y |
   - `Code` is short, with no spaces. It becomes a column in the **Stock** tab automatically.
   - Delete the two sample rows (S1/S2), and delete the `S1`/`S2` columns in **Stock**.
   - Set your own admin PIN in **Settings → AdminPIN** (it starts as 9999).
6. **Publish the page.** Deploy → New deployment → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (staff don't need Google accounts. Shop PINs protect every change.)
   - Copy the **Web app URL**.
7. **Put it on each shop's phone/iPad.** Open the URL → Share → **Add to Home Screen**. Log in once with that shop's PIN and staff name. The phone stays logged in.

> When you change the code later: Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The URL stays the same.

## First stock load (from each POS)

1. Export a stock-on-hand report from that shop's POS as Excel or CSV.
2. Open the page → **More** → enter the admin PIN → choose the shop → choose the file.
3. Match the columns. You can use either one **Full code** column (e.g. `0RB2140 901 50-22`) or separate Model / Colour / Size columns, plus **Quantity on hand**. UPC and Description are optional but useful.
   Keep **Ray-Ban only** ticked to skip other brands. The preview shows how many SKUs and frames will load.
4. Press **Replace … stock**. The column choices are remembered per shop for next time, so a stock-take re-import is quick.

## Daily routine for staff

- **Customer asks for a model** → Find → type the model. A green chip means that shop has it.
- **Closing** → Sold today → add each Ray-Ban sold (type the model or scan its barcode) → Save. The list stays on the phone until it is saved, so it can be built up during the day.
- **Delivery arrives** → Receive → photograph each DO page → Read DO → **check every line and quantity against the paper** → enter the DO number → Save. Anything not found can be added with **+ Item not in list yet**.
- **Sending a frame to another shop** → Transfer → choose the shop → add frames → Record.

## Good to know

- **SKU = Model + Colour + Size**, e.g. `RB2140 901 50`. The leading `0` Luxottica prints (`0RB2140`) and the bridge size (`-22`) are dropped so every source matches.
- **Photos**: tap an item → Add photo. Photos are saved in the Drive folder *Stock Finder - photos* (anyone with the link can view them). Original DO scans are kept in *Stock Finder - DO scans*.
- **Red chip / "only N here"**: the count went below zero or the shop doesn't have enough. Usually this means a sale or delivery was missed. Check the item's movements and correct it in the Sheet.
- **Correcting a number by hand**: edit the shop column in the **Stock** tab. Avoid doing this at the exact moment staff are saving, because the page writes the whole tab.
- **Log** tab: every sale, delivery, transfer and import, with time, shop, staff, quantity and the balance after.
- **Other brands later**: add a prefix in `BRAND_PREFIX` (top of both files), e.g. `OO: 'Oakley'`. Reading those brands' codes from DOs needs a small change to the code pattern.
- **Reading DOs depends on scan quality.** Flat, well-lit photos work best. Long DOs: upload each page as its own photo. Staff must always check the result before saving.
