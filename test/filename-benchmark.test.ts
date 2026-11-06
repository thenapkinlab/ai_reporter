// Small labelled set of made-up attachment names, for the keyword check in src/filter/signals.ts.

import { describe, expect, it } from "vitest";
import { sensitiveDocumentName } from "../src/filter/signals";

const SENSITIVE = [
  "Passport_scan.pdf", "my passport.jpg", "passport-renewal.pdf", "Driving_Licence_front.png", "driving license.pdf", "national-id.jpeg",
  "Aadhaar.pdf", "NARIC_statement.pdf", "UK ENIC certificate.pdf", "ECCTIS-letter.pdf", "Birth Certificate.pdf", "marriage_certificate.pdf",
  "Degree-Certificate.pdf", "P45.pdf", "P60_2025.pdf", "W-2 2025.pdf", "W2.pdf", "Payslip_March.pdf", "pay slip.pdf", "salary_slip_jan.pdf",
  "Tax_Return_2025.pdf", "bank statement.pdf", "Medical_Report.pdf", "lab-report.pdf", "Prescription.pdf", "discharge summary.pdf",
];
const ORDINARY = [
  "menu.pdf", "invite.ics", "Xmas_lunch.pdf", "boarding-pass.pdf", "itinerary.pdf", "receipt_4471.pdf", "photo.jpg", "IMG_2045.HEIC", "slides.pptx",
  "meeting_notes.docx", "newsletter.html", "invoice.pdf", "compassport.pdf", "scenic.jpg", "generic_template.docx", "ap60.csv", "laboratory-tour.pdf",
  "bank_holiday_rota.xlsx", "tax_guide_for_founders.pdf", "report.pdf", "certificate_of_attendance.pdf", "statement_of_work.pdf", "w2c_notes.txt", "medical_conference.pdf",
];

describe("sensitive document names", () => {
  it("finds every sensitive name in the set", () => {
    expect(SENSITIVE.filter((n) => !sensitiveDocumentName(n))).toEqual([]);
  });
  it("leaves every ordinary name alone", () => {
    expect(ORDINARY.filter(sensitiveDocumentName)).toEqual([]);
  });
});
