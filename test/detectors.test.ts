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
