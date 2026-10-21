import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeTradeDecision {
  decision: 'BUY' | 'SELL' | 'SKIP';
  reasoning: string;
  confidence: number; // 0-1
  riskAssessment: string;
}

export class ClaudeClient {
  private client: AxiosInstance;
  private apiKey: string;
  private model = config.claudeModel;
  private baseURL = 'https://api.anthropic.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.client.interceptors.request.use((cfg) => {
      logger.debug(`Claude API Request: ${cfg.method?.toUpperCase()} ${cfg.url}`);
      return cfg;
    });

    this.client.interceptors.response.use(
      (res) => {
        logger.debug(`Claude API Response: ${res.status}`);
        return res;
      },
      (err) => {
        logger.error('Claude API Error:', {
          status: err.response?.status,
          message: err.response?.data?.error?.message || err.message,
        });
        return Promise.reject(err);
      }
    );
  }

  async analyzeTradeOpportunity(prompt: string): Promise<ClaudeTradeDecision> {
    try {
      const systemPrompt = `You are an expert Forex trading AI assistant. Analyze trading opportunities based on:
- Market conditions
- Risk management rules
- Trading strategy (London Breakout + S/R)
- Account limits

Respond in JSON format with: decision (BUY/SELL/SKIP), reasoning, confidence (0-1), riskAssessment`;

      const response = await this.client.post('/messages', {
        model: this.model,
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.data.content[0].text;
      logger.debug('Claude response received');

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid Claude response format');
      }

      const decision = JSON.parse(jsonMatch[0]) as ClaudeTradeDecision;
      logger.info(`Claude Decision: ${decision.decision} (confidence: ${decision.confidence})`);

      return decision;
    } catch (error) {
      logger.error('Failed to analyze trade opportunity:', error);
      throw error;
    }
  }

  async chat(messages: ClaudeMessage[]): Promise<string> {
    try {
      const response = await this.client.post('/messages', {
        model: this.model,
        max_tokens: 1024,
        messages: messages,
      });

      const reply = response.data.content[0].text;
      logger.debug('Chat response received');

      return reply;
    } catch (error) {
      logger.error('Failed to send chat message:', error);
      throw error;
    }
  }

  isConfigured(): boolean {
    return !!this.apiKey && !this.apiKey.includes('your_');
  }

  async validateConnection(): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn('⚠️ CLAUDE_API_KEY not set — AI review disabled (bot still trades on strategy rules)');
      return false;
    }
    try {
      const response = await this.client.post('/messages', {
        model: this.model,
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Hello, acknowledge with just "ok"',
          },
        ],
      });

      if (response.status === 200) {
        logger.info('✅ Claude API connection validated');
        return true;
      }

      return false;
    } catch (error) {
      logger.error('❌ Claude API connection failed');
      return false;
    }
  }
}

// Create singleton instance
export const claudeClient = new ClaudeClient(config.claudeApiKey);
