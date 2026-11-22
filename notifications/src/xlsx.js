// A small Excel (.xlsx) writer: a few sheets of plain rows, a bold first row
// that stays in place while scrolling, and real dates. An .xlsx file is a zip
// of XML files; this one is zipped without compression, which every
// spreadsheet program reads.
//
// A cell is a number, a string, null (empty), or `{ date: "2026-11-22" }` /
// `{ date: "2026-11-22 10:41" }` for a date or a date with a time.

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

// Styles: 0 plain, 1 bold, 2 a date, 3 a date with a time.
const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="${MAIN}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function esc(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "A" for 0, "B" for 1, ... "AA" for 26. */
export function column(index) {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

/** Excel's number for a date ("2026-11-22") or a date and time ("2026-11-22 10:41"), or null. */
export function serial(text) {
  const found = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(text || ""));
  if (!found) return null;
  const [, year, month, day, hour = "0", minute = "0"] = found;
  // Whole days since Excel's day 0, then the time as a share of a day.
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86400000 + 25569 + (Number(hour) * 60 + Number(minute)) / 1440;
}

function cell(value, ref, header) {
  if (value === null || value === undefined || value === "") return "";
  if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : "";
  if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "object" && "date" in value) {
    const number = serial(value.date);
    if (number === null) return "";
    return `<c r="${ref}" s="${String(value.date).length > 10 ? 3 : 2}"><v>${number}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(value).slice(0, 32000))}</t></is></c>`;
}

function sheetXml({ rows, widths = [] }) {
  const cols = widths.length ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>` : "";
  const body = rows
    .map((row, index) => `<row r="${index + 1}">${row.map((value, at) => cell(value, `${column(at)}${index + 1}`, index === 0)).join("")}</row>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${MAIN}" xmlns:r="${RELS}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData></worksheet>`
  );
}

/**
 * The parts of the workbook, as [path, text] pairs. `sheets` is a list of
 * `{ name, rows, widths }`; the first row of each sheet is its heading.
 */
export function workbookParts(sheets) {
  const names = sheets.map((sheet) => sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  return [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><sheets>` +
        names.map((name, index) => `<sheet name="${esc(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
        `</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PACKAGE_RELS}">` +
        sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="${RELS}/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ],
    ["xl/styles.xml", STYLES],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)]),
  ];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of [path, text] pairs, stored without compression. */
export function zip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(([path, text]) => ({ name: encoder.encode(path), data: encoder.encode(text) }));
  for (const entry of entries) entry.crc = crc32(entry.data);
  const size = entries.reduce((sum, one) => sum + 30 + one.name.length + one.data.length + 46 + one.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  // 1 January 1980, midnight: the earliest time a zip can hold.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    entry.offset = at;
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true); // names are UTF-8
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, time, true);
    view.setUint16(at + 12, date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(entry.name, at + 30);
    out.set(entry.data, at + 30 + entry.name.length);
    at += 30 + entry.name.length + entry.data.length;
  }
  const directory = at;
  for (const entry of entries) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.data.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, entry.offset, true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

/** The .xlsx file for `sheets` (see workbookParts), as bytes. */
export function xlsx(sheets) {
  return zip(workbookParts(sheets));
}
