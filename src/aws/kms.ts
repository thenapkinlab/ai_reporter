// Gmail refresh tokens are encrypted with a KMS key. The key never leaves KMS; the Lambda
// role can only ask KMS to encrypt or decrypt. The encryption context binds each ciphertext
// to its user, and appears in CloudTrail for every decrypt.

import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { TokenCipher } from "../crypto";

export class KmsCipher implements TokenCipher {
  constructor(
    private keyId: string,
    private client = new KMSClient({}),
  ) {}

  private context(userId: string) {
    return { purpose: "gmail-refresh-token", userId };
  }

  async encrypt(plain: string, userId: string): Promise<string> {
    const r = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: new TextEncoder().encode(plain),
        EncryptionContext: this.context(userId),
      }),
    );
    if (!r.CiphertextBlob) throw new Error("KMS returned no ciphertext");
    return Buffer.from(r.CiphertextBlob).toString("base64");
  }

  async decrypt(packed: string, userId: string): Promise<string> {
    const r = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(packed, "base64"),
        EncryptionContext: this.context(userId),
      }),
    );
    if (!r.Plaintext) throw new Error("KMS returned no plaintext");
    return new TextDecoder().decode(r.Plaintext);
  }
}
