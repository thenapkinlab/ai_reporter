import { describe, expect, it } from "vitest";
import { detect, ibanValid, luhn, redact, verhoeff } from "../src/filter/detectors";

const types = (text: string) => detect(text).map((h) => h.type);

describe("checksums", () => {
  it("validates Luhn", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
  it("validates IBAN mod-97", () => {
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
  });
  it("validates Verhoeff", () => {
    expect(verhoeff("2363")).toBe(true);
    expect(verhoeff("2364")).toBe(false);
  });
});

describe("detect", () => {
  it("finds a card number but not a random 16-digit number", () => {
    expect(types("Paid with card 4111 1111 1111 1111.")).toEqual(["card_number"]);
    expect(types("Order 1234 5678 9012 3456 shipped")).toEqual([]);
  });
  it("finds IBANs and account numbers", () => {
    expect(types("IBAN GB82 WEST 1234 5698 7654 32")).toContain("iban");
    expect(types("Account number: 50100234567890")).toContain("account_number");
  });
  it("finds SSNs, API keys, passwords and one-time codes", () => {
    expect(types("SSN 123-45-6789")).toEqual(["us_ssn"]);
    expect(types("aws key AKIAIOSFODNN7EXAMPLE")).toEqual(["api_key"]);
    expect(types("password: hunter2")).toEqual(["password"]);
    expect(types("Your verification code is 482913.")).toEqual(["otp"]);
  });
  it("finds passport machine-readable lines", () => {
    const mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10";
    expect(types(mrz)).toContain("passport_mrz");
  });
  it("ignores ordinary text", () => {
    expect(types("Your flight EA 42 on Oct 20 is confirmed. Seat 14C.")).toEqual([]);
    expect(types("Order 112-3344556-7788990 shipped")).toEqual([]);
    expect(types("Paid with card ending 4242. Your account ending in 1234.")).toEqual([]);
    expect(types("Your password is required. Password: ********")).toEqual([]);
    expect(types("Meeting on 2024-05-01. Born to run tour 2025. The passport office opens at 9.")).toEqual([]);
  });
  it("finds labelled values in several languages", () => {
    expect(types("Kontonummer: 1234 5678 90")).toEqual(["account_number"]);
    expect(types("BBAN: JRHS99005839151790")).toEqual(["account_number"]);
    expect(types("Passwort: geheim123")).toEqual(["password"]);
    expect(types("mot de passe : Azerty!9")).toEqual(["password"]);
    expect(types("Account PIN: 709988")).toEqual(["password"]);
    expect(types("Bestätigungscode: 482913")).toEqual(["otp"]);
  });
  it("finds routing numbers, card security codes and dates of birth", () => {
    expect(types("Bank Routing Number: 468457392")).toEqual(["routing_number"]);
    expect(types("Sort code 20-00-00")).toEqual(["routing_number"]);
    expect(types("Creditcard veiligheidscode: 799")).toEqual(["card_security_code"]);
    expect(types("Geburtsdatum: 01.01.1980")).toEqual(["date_of_birth"]);
    expect(types("Date of Birth: October 15, 1960")).toEqual(["date_of_birth"]);
  });
  it("finds ID numbers and secrets", () => {
    expect(types("Número de Pasaporte: Q78845443")).toEqual(["id_number"]);
    expect(types("Driver License Number: Q449-2248-561-3")).toEqual(["id_number"]);
    expect(types("personnummer 811228-9874")).toEqual(["se_personnummer"]);
    expect(types("PAN ABCPE1234F")).toEqual(["in_pan"]);
    expect(types("token: eyJhbGciOiJIUzI1NiJ9abcDEF123")).toEqual(["secret"]);
  });
});

describe("redact", () => {
  it("replaces values with labelled placeholders and keeps the rest", () => {
    const text = "Paid with card 4111 1111 1111 1111. Code is 482913";
    expect(redact(text, detect(text))).toBe("Paid with card [REDACTED: card number]. Code is [REDACTED: one-time code]");
  });
  it("masks values for storage", () => {
    expect(detect("card 4111 1111 1111 1111")[0]?.masked).toBe("••••1111");
  });
});
