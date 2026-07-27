import type { AgentClient } from "./types";

// One turn against the Delta engine seam. Sync request/reply: input +
// previous_response_id + metadata.user_id -> output_text. The engine threads
// the session and enforces ownership by user_id; the edge only supplies them.

export class DeltaAgent implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly controlToken?: string,
  ) {}

  async run(
    input: string,
    opts: { previousResponseId?: string; userId: string },
  ): Promise<{ responseId: string; outputText: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;

    const res = await fetch(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input,
        previous_response_id: opts.previousResponseId,
        metadata: { user_id: opts.userId },
      }),
      signal: AbortSignal.timeout(180000),
    });

    const data = (await res.json()) as {
      id?: string;
      status?: string;
      output_text?: string;
    };
    if (data.status !== "completed") {
      throw new Error(`agent turn ${data.status ?? res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { responseId: data.id ?? "", outputText: data.output_text ?? "" };
  }
}
