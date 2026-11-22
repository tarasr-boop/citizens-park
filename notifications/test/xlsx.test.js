// The small Excel writer behind the stats download.
import assert from "node:assert/strict";
import { test } from "node:test";

import { column, crc32, serial, workbookParts, xlsx } from "../src/xlsx.js";

test("columns are named the way spreadsheets name them", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(column), ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});

test("dates become Excel's day numbers, at the park's own clock", () => {
  assert.equal(serial("1899-12-31"), 1);
  assert.equal(serial("2026-11-22"), 46348);
  assert.equal(serial("2026-11-22 18:00"), 46348.75);
  assert.equal(serial("22/11/2026"), null);
});

test("the zip's checksums are the standard ones", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("a workbook holds its sheets, a bold heading row, real dates and safe text", () => {
  const parts = Object.fromEntries(workbookParts([{ name: "Days / all", rows: [["Date", "Note"], [{ date: "2026-11-22" }, "a < b & \u0001c"], [{ date: "2026-11-22 10:41" }, 3]], widths: [12, 30] }]));
  assert.match(parts["xl/workbook.xml"], /<sheet name="Days   all" sheetId="1" r:id="rId1"\/>/);
  const sheet = parts["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Date<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A2" s="2"><v>46348<\/v><\/c>/);
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">a &lt; b &amp; c<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A3" s="3"><v>46348\.44513888889<\/v><\/c><c r="B3"><v>3<\/v><\/c>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
});

test("the file is a zip that lists every part, with nothing compressed", () => {
  const bytes = xlsx([{ name: "One", rows: [["A"], [1]] }]);
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 6);
  // Each part's stored size matches its own bytes, and its checksum is right.
  let at = 0;
  for (let index = 0; index < 6; index += 1) {
    assert.equal(view.getUint32(at, true), 0x04034b50);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const data = bytes.slice(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(view.getUint32(at + 14, true), crc32(data));
    at += 30 + nameLength + size;
  }
  assert.equal(view.getUint32(end + 16, true), at);
});
