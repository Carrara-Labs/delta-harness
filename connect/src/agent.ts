import type { AgentClient, DownloadedFile } from "./types";

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
      throw new Error(
        `agent turn ${data.status ?? res.status}: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { responseId: data.id ?? "", outputText: data.output_text ?? "" };
  }

  /** Hand files to the daemon workspace (POST /v1/files, multipart). The bytes
   *  land in the workspace inbox and never enter a prompt; the agent reads them
   *  by path with read_file. Returns the saved paths. */
  async uploadFiles(files: DownloadedFile[]): Promise<Array<{ path: string; mime: string }>> {
    const form = new FormData();
    for (const f of files) {
      form.append("file", new Blob([f.bytes], { type: f.mime }), f.name);
    }
    // No content-type header: fetch sets the multipart boundary for FormData.
    const headers: Record<string, string> = {};
    if (this.controlToken) headers.authorization = `Bearer ${this.controlToken}`;

    const res = await fetch(`${this.baseUrl}/v1/files`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      files?: Array<{ path?: string; mime?: string }>;
    };
    if (res.status !== 201 || !Array.isArray(data.files)) {
      throw new Error(`file upload ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.files.map((f) => ({ path: f.path ?? "", mime: f.mime ?? "" }));
  }
}
