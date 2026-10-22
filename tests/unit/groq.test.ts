import { GroqClient } from '../../src/api/groq';

describe('GroqClient', () => {
  it('treats missing and placeholder keys as unconfigured', () => {
    expect(new GroqClient('').isConfigured()).toBe(false);
    expect(new GroqClient('your_groq_api_key_here').isConfigured()).toBe(false);
    expect(new GroqClient('test_key_development').isConfigured()).toBe(false);
  });

  it('accepts a real-looking key and exposes the configured model', () => {
    const client = new GroqClient('gsk_test_123456789', 'openai/gpt-oss-120b');
    expect(client.isConfigured()).toBe(true);
    expect(client.modelName).toBe('openai/gpt-oss-120b');
  });
});
