/**
 * Normalise a phone number to E.164 (+<country><number>).
 *
 * Handles the formats people actually type: spaces, dashes, brackets, a
 * leading 00 international prefix, and national numbers with a trunk "0"
 * (interpreted with `defaultCountryCode`, Zimbabwe +263 unless told otherwise).
 * Returns null when the result is not a plausible E.164 number.
 */
export function normalizePhone(input: string, defaultCountryCode = "263"): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let digits = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(digits)) return null;

  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = defaultCountryCode + digits.slice(1);
  } else if (!digits.startsWith(defaultCountryCode) && digits.length <= 10) {
    // A bare national number without trunk prefix, e.g. "772123456".
    digits = defaultCountryCode + digits;
  }

  const e164 = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}
