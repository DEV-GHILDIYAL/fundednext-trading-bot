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
      timeout: 20000,
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
    const content = await this.complete([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], 500);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid Groq response format: expected JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<GroqTradeDecision>;
    if (parsed.decision !== 'BUY' && parsed.decision !== 'SELL' && parsed.decision !== 'SKIP') {
      throw new Error(`Invalid Groq decision: ${String(parsed.decision)}`);
    }

    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) {
      throw new Error('Invalid Groq confidence value');
    }

    const decision: GroqTradeDecision = {
      decision: parsed.decision,
      reasoning: String(parsed.reasoning ?? '').slice(0, 1000),
      confidence: Math.min(1, Math.max(0, confidence)),
      riskAssessment: String(parsed.riskAssessment ?? '').slice(0, 1000),
    };

    logger.info(`Groq Decision: ${decision.decision} (confidence: ${decision.confidence})`);
    return decision;
  }

  async chat(messages: GroqMessage[]): Promise<string> {
    return this.complete(messages, 1024);
  }

  private async complete(messages: GroqMessage[], maxTokens: number): Promise<string> {
    try {
      const response = await this.client.post<GroqChatResponse>('/chat/completions', {
        model: this.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('Groq returned an empty response');
      }
      return content;
    } catch (error) {
      logger.error('Groq request failed:', error);
      throw error;
    }
  }

  async validateConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn('⚠️ GROQ_API_KEY not set — AI review disabled (bot still trades on strategy rules)');
      return false;
    }

    try {
      await this.client.post<GroqChatResponse>('/chat/completions', {
        model: this.model,
        max_tokens: 5,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      });
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
