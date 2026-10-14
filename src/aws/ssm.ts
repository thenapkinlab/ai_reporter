// Secrets live in SSM Parameter Store as SecureString parameters under one path,
// e.g. /agent-gateway/WORKOS_API_KEY. They are read once per Lambda cold start.

import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

export async function loadParameters(path: string, client = new SSMClient({})): Promise<Record<string, string>> {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const out: Record<string, string> = {};
  let next: string | undefined;
  do {
    const r = await client.send(
      new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, Recursive: false, NextToken: next }),
    );
    for (const p of r.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) out[p.Name.slice(prefix.length)] = p.Value;
    }
    next = r.NextToken;
  } while (next);
  return out;
}
