/**
 * Minimal RFC 4180 CSV reader. Handles quoted fields with embedded commas,
 * doubled quotes and line breaks, CRLF or LF row endings and a leading BOM.
 * nflverse writes missing values as `NA` or an empty cell; `cell()` turns both
 * into null.
 */

/** Yields one array of raw field strings per record, header included. */
export function* iterateCsvRecords(text: string): Generator<string[]> {
  const length = text.length;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (index >= length) return;

  let record: string[] = [];
  while (index <= length) {
    let value = "";
    if (text.charCodeAt(index) === 34 /* " */) {
      index += 1;
      let start = index;
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote === -1) {
          throw new Error(`CSV: unterminated quoted field starting near offset ${start - 1}`);
        }
        if (text.charCodeAt(quote + 1) === 34) {
          value += text.slice(start, quote + 1);
          index = quote + 2;
          start = index;
          continue;
        }
        value += text.slice(start, quote);
        index = quote + 1;
        break;
      }
    } else {
      let end = index;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code === 44 /* , */ || code === 10 /* \n */ || code === 13 /* \r */) break;
        end += 1;
      }
      value = text.slice(index, end);
      index = end;
    }
    record.push(value);

    const code = index < length ? text.charCodeAt(index) : -1;
    if (code === 44) {
      index += 1;
      continue;
    }
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 2;
    else if (code === 13 || code === 10) index += 1;
    else if (code !== -1) {
      throw new Error(`CSV: unexpected character after quoted field at offset ${index}`);
    } else index = length + 1;

    yield record;
    record = [];
    // A trailing line break ends the file; it does not start an empty record.
    if (index >= length) return;
  }
}

/** Every record as an array of raw strings. Convenient for small inputs and tests. */
export function parseCsv(text: string): string[][] {
  return [...iterateCsvRecords(text)];
}

/** `NA` and empty cells mean "missing" in nflverse files. */
export function cell(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "NA" ? null : trimmed;
}

export type CsvRecord<K extends string> = Record<K, string | null>;

/**
 * Reads only the named columns. Other columns are skipped by index and never
 * copied into the result, so unwanted source fields cannot leak downstream.
 * Missing columns throw so a renamed source column fails loudly.
 */
export function* iterateSelectedColumns<K extends string>(
  text: string,
  columns: readonly K[],
): Generator<CsvRecord<K>> {
  const records = iterateCsvRecords(text);
  const first = records.next();
  if (first.done) return;
  const header = first.value.map((name) => name.trim());
  const indexes = columns.map((column) => {
    const position = header.indexOf(column);
    if (position === -1) throw new Error(`CSV: missing column "${column}"`);
    return position;
  });

  for (const fields of records) {
    if (fields.length === 1 && fields[0] === "") continue;
    const row = {} as CsvRecord<K>;
    for (let i = 0; i < columns.length; i += 1) row[columns[i]] = cell(fields[indexes[i]]);
    yield row;
  }
}
