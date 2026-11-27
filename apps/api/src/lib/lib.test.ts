import { describe, expect, it } from "vitest";
import { csvToRecords, parseCsv } from "./csv.js";
import { normalizeEmail, normalizePhone } from "./phone.js";

describe("normalizePhone", () => {
  it.each([
    ["+263 77 212 3456", "+263772123456"],
    ["0772 123 456", "+263772123456"],
    ["0772-123-456", "+263772123456"],
    ["(077) 212 3456", "+263772123456"],
    ["00263772123456", "+263772123456"],
    ["772123456", "+263772123456"],
    ["263772123456", "+263772123456"],
    ["+27 82 123 4567", "+27821234567"],
  ])("normalises %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("uses another default country when asked", () => {
    expect(normalizePhone("082 123 4567", "27")).toBe("+27821234567");
  });

  it.each(["", "abc", "+0123", "12", "+1234567890123456"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims valid addresses", () => {
    expect(normalizeEmail("  Tendai@Example.COM ")).toBe("tendai@example.com");
  });
  it("rejects invalid addresses", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("handles quotes, commas, newlines and CRLF", () => {
    const rows = parseCsv('name,notes\r\n"Moyo, T","He said ""hi""\nthen left"\r\n\r\nRudo,ok');
    expect(rows).toEqual([
      ["name", "notes"],
      ["Moyo, T", 'He said "hi"\nthen left'],
      ["Rudo", "ok"],
    ]);
  });

  it("maps headers to normalised keys and strips a BOM", () => {
    const { headers, records } = csvToRecords(
      "\uFEFFFull Name,Phone Number\nTendai,0772 123 456\n",
    );
    expect(headers).toEqual(["full_name", "phone_number"]);
    expect(records).toEqual([{ full_name: "Tendai", phone_number: "0772 123 456" }]);
  });
});
