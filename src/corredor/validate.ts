// Field validation for extracted / edited invoices (PRD 8.1 P1).
// Checksums for CLABE, CNPJ, CVU and CUIT; formats for the rest.
// Extraction uses these to override the model, and PATCH uses them to warn.

import type { Invoice } from "../contracts";

const onlyDigits = (s: string) => s.replace(/[\s.\-/]/g, "");

/** Mexican CLABE: 18 digits, weights 3-7-1, last digit is the check. */
export function isValidClabe(value: string): boolean {
  const d = onlyDigits(value);
  if (!/^\d{18}$/.test(d)) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(d[i]) * w[i % 3]!) % 10;
  return (10 - (sum % 10)) % 10 === Number(d[17]);
}

/** Brazilian CNPJ: 14 digits with two mod-11 check digits. */
export function isValidCnpj(value: string): boolean {
  const d = onlyDigits(value);
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const check = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, wi, i) => s + wi * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === Number(d[12]) && check(13) === Number(d[13]);
}

/** Argentine CBU/CVU: 22 digits in two blocks (8 + 14), each with a check digit. */
export function isValidCvu(value: string): boolean {
  const d = onlyDigits(value);
  if (!/^\d{22}$/.test(d)) return false;
  const block = (digits: string, weights: number[]) => {
    const sum = weights.reduce((s, w, i) => s + w * Number(digits[i]), 0);
    return (10 - (sum % 10)) % 10;
  };
  const ok1 = block(d.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === Number(d[7]);
  const ok2 = block(d.slice(8, 21), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === Number(d[21]);
  return ok1 && ok2;
}

/** Argentine CUIT/CUIL: 11 digits, mod-11 check. */
export function isValidCuit(value: string): boolean {
  const d = onlyDigits(value);
  if (!/^\d{11}$/.test(d)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const r = 11 - (w.reduce((s, wi, i) => s + wi * Number(d[i]), 0) % 11);
  const check = r === 11 ? 0 : r === 10 ? 9 : r;
  return check === Number(d[10]);
}

/** Mexican RFC: 3-4 letters, YYMMDD, 3-char homoclave (format only). */
export const isValidRfc = (value: string) => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i.test(value.trim());

/** Venezuelan RIF: letter, 8 digits, check digit (format only). */
export const isValidRif = (value: string) => /^[VEJPG]-?\d{8}-?\d$/i.test(value.trim());

/** Pix key: CPF, CNPJ, email, +55 phone or random (EVP) key. */
export function isValidPixKey(value: string): boolean {
  const v = value.trim();
  return (
    (/^\d{11}$/.test(onlyDigits(v)) && !/[a-z@]/i.test(v)) || // CPF
    isValidCnpj(v) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ||
    /^\+55\d{10,11}$/.test(v.replace(/[\s()-]/g, "")) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

export const isValidBic = (value: string) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value.trim());

export interface FieldIssue {
  field: string;
  message: string;
}

/** Problems a human should fix before planning. Empty means the fields look valid. */
export function validateInvoice(inv: Invoice): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (inv.bankId) {
    const { type, value } = inv.bankId;
    const bad =
      (type === "spei" && !isValidClabe(value) && "CLABE must be 18 digits with a valid check digit") ||
      (type === "cvu" && !isValidCvu(value) && "CVU must be 22 digits with valid check digits") ||
      (type === "pix" && !isValidPixKey(value) && "Not a valid Pix key (CPF, CNPJ, email, +55 phone or random key)") ||
      (type === "swift" && !isValidBic(value) && "Not a valid SWIFT/BIC code");
    if (bad) issues.push({ field: "bankId", message: bad });
  }
  if (inv.payeeTaxId) {
    const t = inv.payeeTaxId;
    const bad =
      (inv.payeeCountry === "BR" && !isValidCnpj(t) && "CNPJ must be 14 digits with valid check digits") ||
      (inv.payeeCountry === "MX" && !isValidRfc(t) && "Not a valid RFC") ||
      (inv.payeeCountry === "AR" && !isValidCuit(t) && "CUIT must be 11 digits with a valid check digit") ||
      (inv.payeeCountry === "VE" && !isValidRif(t) && "Not a valid RIF");
    if (bad) issues.push({ field: "payeeTaxId", message: bad });
  }
  return issues;
}
