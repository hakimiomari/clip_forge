import { env } from "../env";

/**
 * Thin LLM client over plain fetch — no SDK dependency. Supports the
 * Anthropic Messages API and OpenAI-compatible chat completions.
 */

export function llmConfigured(): boolean {
  return (
    (env.AI_PROVIDER === "anthropic" || env.AI_PROVIDER === "openai") &&
    Boolean(env.AI_API_KEY)
  );
}

export async function completeText(prompt: string): Promise<string> {
  if (!llmConfigured()) {
    throw new Error("No LLM provider configured (set AI_PROVIDER + AI_API_KEY)");
  }
  if (env.AI_PROVIDER === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.AI_API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Anthropic API returned no text content");
    return text;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned no content");
  return text;
}

/** Extracts the first JSON object from a model response. */
export function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response contained no JSON object");
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}
