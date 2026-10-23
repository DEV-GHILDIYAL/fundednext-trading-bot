import axios, { AxiosError, AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { notifier } from '../services/notifier';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqTradeDecision {
  decision: 'BUY' | 'SELL' | 'SKIP';
  reasoning: string;
  confidence: number; // 0-1
  riskAssessment: string;
  /** Which key answered (1-based) */
  keyIndex?: number;
}

interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class GroqUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqUnavailableError';
  }
}

const SYSTEM_PROMPT = `You are a risk-focused XAUUSD (gold) trade reviewer for a London-session breakout strategy.
Evaluate the proposed trade against market context and strict risk rules.
Never recommend increasing risk. Prefer SKIP when the setup is unclear or contradictory.

Reply with JSON only, using this schema:
{"decision":"BUY|SELL|SKIP","reasoning":"short explanation","confidence":0.0,"riskAssessment":"short risk note"}`;

/** After switching away from the primary key, try it again after this long */
const PRIMARY_RETRY_MS = 15 * 60 * 1000;

function isPlaceholder(key: string): boolean {
  const k = key.trim();
  return k.length === 0 || k.includes('your_') || k === 'test_key_development';
}

/**
 * Groq client (OpenAI-compatible) with two API keys from different accounts.
 *
 * - Each call retries transient errors (timeouts, 5xx) on the active key.
 * - Rate limit (429) or auth errors (401/403) → switch to the next key + alert.
 * - All keys failing → GroqUnavailableError (the bot then skips the trade: fail-closed).
 */
export class GroqClient {
  private clients: AxiosInstance[];
  private readonly keys: string[];
  private active = 0;
  private switchedAt = 0;
  private lastError: string | null = null;
  private lastSuccessAt: Date | null = null;

  constructor(
    keys: string | string[] = config.groqApiKeys,
    private readonly model: string = config.groqModel,
    private readonly maxRetries: number = config.groqMaxRetries,
    private readonly retryDelayMs: number = 1000,
    baseUrl: string = config.groqBaseUrl
  ) {
    this.keys = (Array.isArray(keys) ? keys : [keys]).filter((k) => !isPlaceholder(k));
    this.clients = this.keys.map((key) =>
      axios.create({
        baseURL: baseUrl.replace(/\/+$/, ''),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: config.groqTimeoutMs,
      })
    );
  }

  get modelName(): string {
    return this.model;
  }

  get keyCount(): number {
    return this.keys.length;
  }

  isConfigured(): boolean {
    return this.keys.length > 0;
  }

  getStatus(): { configured: boolean; keys: number; activeKey: number; lastError: string | null; lastSuccessAt: string | null } {
    return {
      configured: this.isConfigured(),
      keys: this.keys.length,
      activeKey: this.active + 1,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
    };
  }

  async analyzeTradeOpportunity(prompt: string): Promise<GroqTradeDecision> {
    const { content, keyIndex } = await this.complete(
      [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nTrade details:\n${prompt}` }],
      4096,
      true
    );
    const decision = { ...this.parseDecision(content), keyIndex };
    logger.info(`Groq Decision (key #${keyIndex}): ${decision.decision} (confidence: ${decision.confidence})`);
    return decision;
  }

  async chat(messages: GroqMessage[]): Promise<string> {
    return (await this.complete(messages, 1024, false)).content;
  }

  parseDecision(content: string): GroqTradeDecision {
    let parsed: Partial<GroqTradeDecision>;
    try {
      parsed = JSON.parse(content.trim()) as Partial<GroqTradeDecision>;
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Invalid Groq response format: expected JSON');
      parsed = JSON.parse(jsonMatch[0]) as Partial<GroqTradeDecision>;
    }

    const decisionValue = String(parsed.decision ?? '').toUpperCase();
    if (decisionValue !== 'BUY' && decisionValue !== 'SELL' && decisionValue !== 'SKIP') {
      throw new Error(`Invalid Groq decision: ${String(parsed.decision)}`);
    }

    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) throw new Error('Invalid Groq confidence value');
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;

    return {
      decision: decisionValue,
      reasoning: String(parsed.reasoning ?? '').slice(0, 1000),
      confidence: Math.min(1, Math.max(0, confidence)),
      riskAssessment: String(parsed.riskAssessment ?? '').slice(0, 1000),
    };
  }

  private buildBody(messages: GroqMessage[], maxTokens: number, jsonMode: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0, // same setup → same answer
      max_completion_tokens: maxTokens,
    };
    if (this.model.startsWith('openai/gpt-oss')) {
      body.reasoning_effort = 'low';
      body.include_reasoning = false;
    }
    if (jsonMode) body.response_format = { type: 'json_object' };
    return body;
  }

  /** Tries every key (starting with the active one); retries transient errors per key. */
  private async complete(
    messages: GroqMessage[],
    maxTokens: number,
    jsonMode: boolean
  ): Promise<{ content: string; keyIndex: number }> {
    if (!this.isConfigured()) throw new GroqUnavailableError('No Groq API key configured');

    // Go back to the primary key after a cool-down
    if (this.active !== 0 && Date.now() - this.switchedAt > PRIMARY_RETRY_MS) {
      logger.info('Groq: retrying primary key #1 after cool-down');
      this.active = 0;
    }

    const failures: string[] = [];
    for (let tried = 0; tried < this.keys.length; tried++) {
      const index = this.active;
      try {
        const content = await this.requestWithRetry(index, messages, maxTokens, jsonMode);
        this.lastSuccessAt = new Date();
        this.lastError = null;
        return { content, keyIndex: index + 1 };
      } catch (error) {
        const reason = this.describe(error);
        failures.push(`key #${index + 1}: ${reason}`);
        if (this.keys.length > 1 && tried < this.keys.length - 1) {
          const next = (index + 1) % this.keys.length;
          this.active = next;
          this.switchedAt = Date.now();
          logger.warn(`Groq key #${index + 1} failed (${reason}) — switching to key #${next + 1}`);
          void notifier.notify('warn', `Groq key #${index + 1} failed (${reason}).\nSwitched to key #${next + 1}.`, `groq-switch-${index}`);
        }
      }
    }

    this.lastError = failures.join(' | ');
    throw new GroqUnavailableError(`All Groq keys failed — ${this.lastError}`);
  }

  private async requestWithRetry(
    index: number,
    messages: GroqMessage[],
    maxTokens: number,
    jsonMode: boolean
  ): Promise<string> {
    let useJson = jsonMode;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(index, messages, maxTokens, useJson);
      } catch (error) {
        if (useJson && this.isJsonModeError(error)) {
          logger.warn('Groq rejected JSON mode — retrying without response_format');
          useJson = false;
          continue;
        }
        const status = (error as AxiosError).response?.status;
        // 429 / 401 / 403 → this key is unusable right now; move to the next key immediately
        const keyProblem = status === 429 || status === 401 || status === 403;
        if (keyProblem || attempt >= this.maxRetries) throw error;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }
  }

  private async request(index: number, messages: GroqMessage[], maxTokens: number, jsonMode: boolean): Promise<string> {
    const response = await this.clients[index].post<GroqChatResponse>(
      '/chat/completions',
      this.buildBody(messages, maxTokens, jsonMode)
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Error('Groq returned an empty response');
    return content;
  }

  private describe(error: unknown): string {
    const err = error as AxiosError<{ error?: { message?: string } }>;
    const status = err.response?.status;
    if (status === 429) return 'rate limited (429)';
    if (status === 401 || status === 403) return `auth error (${status})`;
    if (status) return `HTTP ${status}: ${err.response?.data?.error?.message ?? err.message}`;
    return (err as Error).message ?? String(error);
  }

  private isJsonModeError(error: unknown): boolean {
    const err = error as { response?: { status?: number; data?: { error?: { message?: string } } } };
    if (err.response?.status !== 400) return false;
    return /response_format|json_object|json mode/i.test(String(err.response?.data?.error?.message ?? ''));
  }

  async validateConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.error('❌ No Groq API key set (GROQ_API_KEY / GROQ_API_KEY_2) — AI review cannot run');
      return false;
    }
    try {
      const { keyIndex } = await this.complete([{ role: 'user', content: 'Reply with the single word: ok' }], 512, false);
      logger.info(`✅ Groq connected (${this.model}) — ${this.keys.length} key(s), using #${keyIndex}`);
      return true;
    } catch (error) {
      logger.error('❌ Groq API connection failed', error);
      return false;
    }
  }
}

export const groqClient = new GroqClient();
