/**
 * ExportForSupabase.gs
 * Paste into ANY Apps Script project that can open the workbooks (e.g. Interview Incentive Portal),
 * run exportForSupabase(), approve the Drive scope once, then download the created Drive folder
 * and point the importer at it:
 *
 *   npx tsx scripts/import/import.ts --dir ./Supabase-Export-<timestamp> --out seed.sql
 *
 * Files are named "<Workbook title> - <Tab>.csv" (the importer relies on that).
 * Read-only on the source sheets.
 */
const EXPORT_SOURCES = [
  // [spreadsheetId, [tabs...]]   (titles are read from the files)
  ["1FD5pShmQaqszrcqi1UHXGlsJQBuKPnxJXKFvj7iwjus", ["Candidate Master", "Candidate Name Map", "Client Master", "Client Name Map"]],          // Interview Portal Control
  ["1Q5pRPoLsSjfxuRfEUZW2zZqrURYPzzbbPO6_8r9CLCk", ["V2 Team Master", "V2 Handler Master", "V2 User Access", "V2 User Roles", "Settings",
      "Incentive Tracker", "Call Outcome Requests", "Call Outcome Correction Requests", "Call Reassignment Requests", "Selection Requests",
      "Portal Action Log", "Client Alias", "Promotion Recovery", "Recovery Exceptions"]],                                                                                                 // Incentive Backend - Private
  ["1fl1mcQTmlYhTKgb2qmw-nWHSEFmMVxMLOUiXY2JsB0w", ["Incentive Tracker", "HYD Call Outcome Requests", "HYD Call Outcome Correction Requests",
      "HYD Call Reassignment Requests", "HYD Selection Requests", "HYD Portal Action Log", "Client Alias", "Candidate Alias",
      "Promotion Recovery", "Recovery Exceptions"]],              // HYD Incentive Backend - Private
  ["1UudfZfeBBkEwBQeWUwx77R4gl26wYZ1rKKZWCM_SHq4", ["Raw Data", "Team Data"]],                                                               // Incentive tracker
  ["1pDKLkZc4mCU7pcTWG-aYgovj7DJjF7C77292JyQ3zwU", ["HYD Raw Data", "HYD Team Data", "Portal Call Status"]],                                // HYD Incentive Tracker
  ["1BD_XIhQW6d4w4dnrcM17wYgv6hZqdx7mTsAIYgUOC7M", ["Portal Call Status", "Preference List"]]                                               // Call Tracker
];

function exportForSupabase() {
  const folder = DriveApp.createFolder("Supabase-Export-" + Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyyMMdd-HHmm"));
  const log = [];
  EXPORT_SOURCES.forEach(function (src) {
    const ss = SpreadsheetApp.openById(src[0]);
    const title = ss.getName();
    src[1].forEach(function (tab) {
      const sh = ss.getSheetByName(tab);
      if (!sh) { log.push("MISSING  " + title + " / " + tab); return; }
      const values = sh.getDataRange().getDisplayValues();
      const csv = values.map(function (row) {
        return row.map(function (v) {
          v = String(v == null ? "" : v);
          return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(",");
      }).join("\n");
      folder.createFile(title + " - " + tab + ".csv", csv, MimeType.CSV);
      log.push("OK       " + title + " / " + tab + "  (" + values.length + " rows)");
    });
  });
  Logger.log(log.join("\n") + "\n\nFolder: " + folder.getUrl());
  return folder.getUrl();
}
