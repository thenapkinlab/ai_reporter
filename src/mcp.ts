// Minimal stateless MCP server over Streamable HTTP (JSON responses, no sessions, no SSE).
// Hand-written so it runs on Workers without the SDK's Node-only schema validator.

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SERVER_INFO = { name: "private-gmail-gateway", version: "0.1.0" };

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolBackend {
  searchEmail(query: string, maxResults: number): Promise<ToolResult>;
  readEmail(messageId: string): Promise<ToolResult>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "search_email",
    title: "Search email",
    description:
      "Search the user's Gmail. Use this for any email task. Accepts Gmail search syntax " +
      "(e.g. 'from:airline newer_than:30d'). A privacy filter withholds medical and financial emails, and " +
      "replaces sensitive values in other emails (card or bank numbers, IDs, passwords, codes, home addresses, " +
      "birth dates) with [removed: …]; filter_note gives counts and reason types. Attachment contents are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query" },
        max_results: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Search email", ...READ_ONLY },
  },
  {
    name: "read_email",
    title: "Read email",
    description:
      "Read one email by ID (from search_email). Returns the email with any sensitive values replaced by " +
      "[removed: …], and attachment names, types and sizes only (attachment contents are never returned). " +
      "Withheld emails return a notice instead of content.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string", description: "Message ID from search_email" } },
      required: ["message_id"],
      additionalProperties: false,
    },
    annotations: { title: "Read email", ...READ_ONLY },
  },
];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callTool(backend: ToolBackend, params: Record<string, unknown>): Promise<ToolResult> {
  const name = params.name;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (name === "search_email") {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return toolError("query is required");
      const max = Math.min(25, Math.max(1, Number.isInteger(args.max_results) ? (args.max_results as number) : 10));
      return await backend.searchEmail(query, max);
    }
    if (name === "read_email") {
      const id = typeof args.message_id === "string" ? args.message_id : "";
      if (!id) return toolError("message_id is required");
      return await backend.readEmail(id);
    }
    return toolError(`Unknown tool: ${String(name)}`);
  } catch (e) {
    return toolError(e instanceof Error ? e.message : "Tool failed");
  }
}

export async function handleMcp(request: Request, backend: ToolBackend): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let msg: unknown;
  try {
    msg = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(msg) || !msg || typeof msg !== "object" || (msg as RpcRequest).jsonrpc !== "2.0") {
    return json(rpcError(null, -32600, "Invalid request"), 400);
  }
  const req = msg as RpcRequest;

  // Notifications and responses carry no id and get no body.
  if (req.id === undefined) return new Response(null, { status: 202 });

  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return json(
        rpcResult(req.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Use search_email and read_email for all email tasks. Results pass through the user's privacy filter.",
        }),
      );
    }
    case "ping":
      return json(rpcResult(req.id, {}));
    case "tools/list":
      return json(rpcResult(req.id, { tools: TOOLS }));
    case "tools/call":
      return json(rpcResult(req.id, await callTool(backend, req.params ?? {})));
    default:
      return json(rpcError(req.id, -32601, `Method not found: ${req.method}`));
  }
}
