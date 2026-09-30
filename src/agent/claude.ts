import { config } from '../config.js';

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export type ClaudeMessage = { role: 'user' | 'assistant'; content: string | ContentBlock[] };

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ClaudeResponse = {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string;
  usage?: { input_tokens: number; output_tokens: number };
};

/** Chamada direta à Messages API (sem SDK), com retry para sobrecarga e limite de taxa. */
export async function callClaude(
  system: string,
  messages: ClaudeMessage[],
  tools: ToolDefinition[],
  opts: { toolChoice?: 'auto' | 'any' } = {},
  apiUrl = 'https://api.anthropic.com/v1/messages',
): Promise<ClaudeResponse> {
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.CLAUDE_MODEL, max_tokens: 1024, system, messages, tools,
          tool_choice: { type: opts.toolChoice ?? 'auto' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return (await res.json()) as ClaudeResponse;
      const detail = await res.text();
      lastError = new Error(`Claude ${res.status}: ${detail}`);
      // 429 (limite) e 5xx/529 (sobrecarga) valem nova tentativa; o resto não
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
  }
  throw lastError;
}
