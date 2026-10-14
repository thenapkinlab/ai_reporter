// Amazon Bedrock for the two model jobs: labelling an email (a small text model) and
// reading text out of PDF and image attachments (a multimodal model). Both use the
// Converse API, so swapping models is a config change.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type DocumentFormat,
  type ImageFormat,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CLASSIFIER_PROMPT,
  batchMessage,
  batchPrompt,
  parseBatchLabels,
  parseModelLabel,
  type ClassifyInput,
  type Classifier,
  type Label,
} from "../filter/classifier";
import { randomId } from "../crypto";
import type { Attachment } from "../mail";

// Bedrock's Converse limits for inline attachments.
const MAX_DOCUMENT_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

function text(blocks: ContentBlock[] | undefined): string {
  return (blocks ?? []).map((b) => ("text" in b && b.text) || "").join("");
}

/** Per-call usage, reported to an optional observer (used by the evaluation script). */
export interface CallInfo {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class BedrockClassifier implements Classifier {
  constructor(
    private modelId: string,
    private client = new BedrockRuntimeClient({}),
    private onCall?: (info: CallInfo) => void,
  ) {}

  async classify(input: ClassifyInput): Promise<Label> {
    const r = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: CLASSIFIER_PROMPT }],
        messages: [
          { role: "user", content: [{ text: `From: ${input.from}\nSubject: ${input.subject}\n\n${input.text.slice(0, 6000)}` }] },
        ],
        inferenceConfig: { maxTokens: 400, temperature: 0 },
      }),
    );
    this.onCall?.({
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      latencyMs: r.metrics?.latencyMs ?? 0,
    });
    const label = parseModelLabel(text(r.output?.message?.content));
    if (!label) throw new Error("unparseable model output");
    return label;
  }

  /** One request for several emails: Bedrock's per-minute request limits, not tokens, are the bottleneck. */
  async classifyBatch(inputs: ClassifyInput[]): Promise<(Label | null)[]> {
    if (!inputs.length) return [];
    const marker = randomId().replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
    const r = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: batchPrompt(marker) }],
        messages: [{ role: "user", content: [{ text: batchMessage(marker, inputs, BATCH_CHARS_PER_EMAIL) }] }],
        inferenceConfig: { maxTokens: 120 + 200 * inputs.length, temperature: 0 },
      }),
    );
    this.onCall?.({
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      latencyMs: r.metrics?.latencyMs ?? 0,
    });
    return parseBatchLabels(text(r.output?.message?.content), inputs.length);
  }
}

/** Per-email text budget inside a batch (about 1,000 tokens each). */
export const BATCH_CHARS_PER_EMAIL = 4000;

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Returns an extractor for the filter engine: PDF or image bytes in, plain text out (or null). */
export function bedrockExtractor(modelId: string, client = new BedrockRuntimeClient({})) {
  return async (att: Attachment, bytes: Uint8Array): Promise<string | null> => {
    let block: ContentBlock;
    if (att.mimeType === "application/pdf") {
      if (bytes.length > MAX_DOCUMENT_BYTES) return null;
      // Document names allow only letters, digits, spaces, hyphens, parentheses and brackets.
      block = { document: { format: "pdf" as DocumentFormat, name: "attachment", source: { bytes } } };
    } else if (IMAGE_FORMATS[att.mimeType]) {
      if (bytes.length > MAX_IMAGE_BYTES) return null;
      block = { image: { format: IMAGE_FORMATS[att.mimeType]!, source: { bytes } } };
    } else {
      return null;
    }
    const r = await client.send(
      new ConverseCommand({
        modelId,
        messages: [
          {
            role: "user",
            content: [
              block,
              { text: "Transcribe all text in this file as plain text. Output only the text, no commentary." },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 4000, temperature: 0 },
      }),
    );
    const out = text(r.output?.message?.content).trim();
    return out || null;
  };
}
