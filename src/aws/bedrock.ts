// Amazon Bedrock for the classifier: labels emails and finds values to remove, through the
// Converse API, so swapping models is a config change. Attachments are never sent to a model.

import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
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
