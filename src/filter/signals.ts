// Layer 2: cheap hints from the sender's domain and keywords. They settle obvious cases
// without the model and decide which emails are worth sending to the model at all.

import type { Hit } from "./detectors";

export interface Signals {
  financial: number;
  medical: number;
  financialDomain: boolean;
  medicalDomain: boolean;
  reasons: string[];
}

// Matched as a suffix, so "alerts.chase.com" counts as "chase.com".
const FINANCIAL_DOMAINS = [
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "capitalone.com",
  "americanexpress.com", "aexp.com", "discover.com", "usbank.com", "pnc.com", "ally.com", "sofi.com",
  "hsbc.com", "hsbc.co.uk", "barclays.co.uk", "lloydsbank.co.uk", "natwest.com", "santander.co.uk",
  "hdfcbank.com", "hdfcbank.net", "icicibank.com", "sbi.co.in", "axisbank.com", "kotak.com",
  "irs.gov", "hmrc.gov.uk", "incometax.gov.in", "turbotax.intuit.com",
  "fidelity.com", "vanguard.com", "schwab.com", "robinhood.com", "etrade.com", "zerodha.com",
  "adp.com", "gusto.com", "paychex.com",
];
const MEDICAL_DOMAINS = [
  "mychart.org", "mychart.com", "labcorp.com", "questdiagnostics.com", "kp.org", "mayoclinic.org",
  "clevelandclinic.org", "onemedical.com", "zocdoc.com", "teladoc.com", "cvs.com", "cvshealth.com",
  "walgreens.com", "goodrx.com", "practo.com", "1mg.com", "apollohospitals.com", "pharmeasy.in",
  "nhs.uk", "nhs.net", "bcbs.com", "aetna.com", "cigna.com", "uhc.com", "anthem.com",
];

const FINANCIAL_WORDS = [
  "account statement", "bank statement", "statement is ready", "available balance", "account balance",
  "account number", "routing number", "sort code", "ifsc", "iban", "wire transfer", "direct deposit",
  "payslip", "pay stub", "salary slip", "tax return", "form w-2", "form 1099", "form 16", "loan",
  "mortgage", "credit limit", "minimum payment", "payment due", "portfolio", "brokerage", "dividend",
];
const MEDICAL_WORDS = [
  "lab results", "test results", "blood test", "lab report", "diagnosis", "prescription", "refill",
  "dosage", "mg/dl", "hemoglobin", "glucose", "cholesterol", "biopsy", "radiology", "mri", "x-ray",
  "patient", "physician", "appointment with dr", "clinic", "explanation of benefits", "claim for services",
  "medical record", "vaccination", "pharmacy",
];

function matchesDomain(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith("." + d));
}

function countWords(text: string, words: string[], reasons: string[], label: string): number {
  let n = 0;
  for (const w of words) {
    if (text.includes(w)) {
      n++;
      if (reasons.length < 6) reasons.push(`${label} keyword "${w}"`);
    }
  }
  return n;
}

export function computeSignals(domain: string, text: string, hits: Hit[]): Signals {
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const financialDomain = matchesDomain(domain, FINANCIAL_DOMAINS);
  const medicalDomain = matchesDomain(domain, MEDICAL_DOMAINS);
  if (financialDomain) reasons.push(`financial sender ${domain}`);
  if (medicalDomain) reasons.push(`medical sender ${domain}`);
  let financial = countWords(lower, FINANCIAL_WORDS, reasons, "financial");
  const medical = countWords(lower, MEDICAL_WORDS, reasons, "medical");
  const bankValues = hits.filter((h) => h.type === "iban" || h.type === "account_number").length;
  if (bankValues) {
    financial += 2;
    reasons.push("contains bank account details");
  }
  return { financial, medical, financialDomain, medicalDomain, reasons };
}

/** True when an email has any hint worth asking the model about. */
export function isCandidate(s: Signals, hasAttachments: boolean): boolean {
  return s.financialDomain || s.medicalDomain || s.financial > 0 || s.medical > 0 || hasAttachments;
}
