import Anthropic from '@anthropic-ai/sdk';
import type { AiPrompt } from './ai';

export interface AiConfig { apiKey: string; model: string }

// Server-side refusal fallback is offered on these model families only.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

/**
 * Sends one prompt to the Claude API with the user's own key and streams the reply.
 * The key stays on this device; the request goes straight to the API from Obsidian.
 */
export async function runPrompt(config: AiConfig, prompt: AiPrompt, onText?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const fallback = FALLBACK_MODELS.test(config.model);
  try {
    const stream = client.beta.messages.stream({
      model: config.model,
      max_tokens: prompt.maxTokens,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      thinking: { type: 'adaptive' },
      output_config: { effort: prompt.effort, ...(prompt.schema ? { format: { type: 'json_schema' as const, schema: prompt.schema } } : {}) },
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    }, { signal });
    if (onText) stream.on('text', (_delta, snapshot) => onText(snapshot));
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('The assistant declined this request.');
    const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('').trim();
    if (message.stop_reason === 'max_tokens') throw new Error('The reply was cut off because it was too long. Try a shorter passage.');
    if (!text) throw new Error('The assistant returned an empty reply. Try again.');
    return text;
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError) throw new Error('Request stopped.');
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new Error('The API key was rejected. Check it in Tangrow settings.');
    if (error instanceof Anthropic.NotFoundError) throw new Error('The model was not found. Check the model name in Tangrow settings.');
    if (error instanceof Anthropic.RateLimitError) throw new Error('The API rate limit was reached. Wait a moment and try again.');
    if (error instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API. Check your connection and try again.');
    if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status ?? ''}: ${error.message}`.trim());
    throw error;
  }
}
