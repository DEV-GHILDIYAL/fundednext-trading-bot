import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqTradeDecision {
  decision: 'BUY' | 'SELL' | 'SKIP';
  reasoning: string;
  confidence: number; // 0-1
  riskAssessment: string;
}

interface GroqChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning?: string;
    };
  }>;
}

const SYSTEM_PROMPT = `You are a risk-focused Forex trade reviewer for a London Breakout + support/resistance strategy.
Evaluate the proposed trade against market context and strict risk rules.
Never recommend increasing risk. Prefer SKIP when the setup is unclear or contradictory.

Reply with JSON only, using this schema:
{"decision":"BUY|SELL|SKIP","reasoning":"short explanation","confidence":0.0,"riskAssessment":"short risk note"}`;

/**
 * Groq API client (OpenAI-compatible chat completions).
 * Docs: https://console.groq.com/docs/openai
 *
 * The client is optional: if GROQ_API_KEY is not set, the bot logs a warning
 * and keeps trading on the deterministic strategy rules.
 */
export class GroqClient {
  private client: AxiosInstance;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = config.groqModel) {
    this.apiKey = apiKey;
    this.model = model;

    this.client = axios.create({
      baseURL: config.groqBaseUrl.replace(/\/+$/, ''),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.client.interceptors.request.use((cfg) => {
      logger.debug(`Groq API Request: ${cfg.method?.toUpperCase()} ${cfg.url}`);
      return cfg;
    });

    this.client.interceptors.response.use(
      (res) => {
        logger.debug(`Groq API Response: ${res.status}`);
        return res;
      },
      (err) => {
        logger.error('Groq API Error:', {
          status: err.response?.status,
          message: err.response?.data?.error?.message || err.message,
        });
        return Promise.reject(err);
      }
    );
  }

  get modelName(): string {
    return this.model;
  }

  isConfigured(): boolean {
    const key = this.apiKey.trim();
    return key.length > 0 && !key.includes('your_') && key !== 'test_key_development';
  }

  async analyzeTradeOpportunity(prompt: string): Promise<GroqTradeDecision> {
    // GPT-OSS reasoning models work best with all instructions in the user
    // message. JSON mode forces the final answer to be valid JSON.
    const content = await this.complete(
      [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nTrade details:\n${prompt}` }],
      4096,
      true
    );

    const decision = this.parseDecision(content);
    logger.info(`Groq Decision: ${decision.decision} (confidence: ${decision.confidence})`);
    return decision;
  }

  async chat(messages: GroqMessage[]): Promise<string> {
    return this.complete(messages, 1024, false);
  }

  private parseDecision(content: string): GroqTradeDecision {
    let parsed: Partial<GroqTradeDecision>;
    try {
      parsed = JSON.parse(content.trim()) as Partial<GroqTradeDecision>;
    } catch {
      // Fallback: models occasionally wrap JSON in prose/code fences.
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid Groq response format: expected JSON');
      }
      parsed = JSON.parse(jsonMatch[0]) as Partial<GroqTradeDecision>;
    }

    const decisionValue = String(parsed.decision ?? '').toUpperCase();
    if (decisionValue !== 'BUY' && decisionValue !== 'SELL' && decisionValue !== 'SKIP') {
      throw new Error(`Invalid Groq decision: ${String(parsed.decision)}`);
    }

    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) {
      throw new Error('Invalid Groq confidence value');
    }
    // Accept either 0-1 or 0-100 confidence scales.
    if (confidence > 1 && confidence <= 100) {
      confidence = confidence / 100;
    }

    return {
      decision: decisionValue,
      reasoning: String(parsed.reasoning ?? '').slice(0, 1000),
      confidence: Math.min(1, Math.max(0, confidence)),
      riskAssessment: String(parsed.riskAssessment ?? '').slice(0, 1000),
    };
  }

  private usesGptOssControls(): boolean {
    return this.model.startsWith('openai/gpt-oss');
  }

  private buildBody(messages: GroqMessage[], maxTokens: number, jsonMode: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.6,
      max_completion_tokens: maxTokens,
    };

    if (this.usesGptOssControls()) {
      // Keep reasoning short and don't return the reasoning field.
      body.reasoning_effort = 'low';
      body.include_reasoning = false;
    }

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    return body;
  }

  private async complete(messages: GroqMessage[], maxTokens: number, jsonMode: boolean): Promise<string> {
    try {
      return await this.request(messages, maxTokens, jsonMode);
    } catch (error) {
      if (jsonMode && this.isJsonModeError(error)) {
        logger.warn('Groq rejected JSON mode — retrying without response_format');
        return this.request(messages, maxTokens, false);
      }
      throw error;
    }
  }

  private async request(messages: GroqMessage[], maxTokens: number, jsonMode: boolean): Promise<string> {
    const response = await this.client.post<GroqChatResponse>(
      '/chat/completions',
      this.buildBody(messages, maxTokens, jsonMode)
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Groq returned an empty response');
    }
    return content;
  }

  private isJsonModeError(error: unknown): boolean {
    const err = error as { response?: { status?: number; data?: { error?: { message?: string } } } };
    if (err.response?.status !== 400) return false;
    const message = String(err.response?.data?.error?.message ?? '');
    return /response_format|json_object|json mode/i.test(message);
  }

  async validateConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn('⚠️ GROQ_API_KEY not set — AI review disabled (bot still trades on strategy rules)');
      return false;
    }

    try {
      await this.complete([{ role: 'user', content: 'Reply with the single word: ok' }], 512, false);
      logger.info(`✅ Groq API connection validated (${this.model})`);
      return true;
    } catch (error) {
      logger.error('❌ Groq API connection failed');
      return false;
    }
  }
}

// Create singleton instance
export const groqClient = new GroqClient(config.groqApiKey);
