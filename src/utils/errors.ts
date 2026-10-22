export class APIError extends Error {
  constructor(
    public code: string,
    public status: number,
    public message: string,
    public originalError?: any
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export class FundedNextError extends APIError {
  constructor(status: number, message: string, originalError?: any) {
    super('FUNDEDNEXT_ERROR', status, message, originalError);
    this.name = 'FundedNextError';
  }
}

export class GroqAPIError extends APIError {
  constructor(status: number, message: string, originalError?: any) {
    super('GROQ_API_ERROR', status, message, originalError);
    this.name = 'GroqAPIError';
  }
}

export class MarketDataError extends APIError {
  constructor(status: number, message: string, originalError?: any) {
    super('MARKET_DATA_ERROR', status, message, originalError);
    this.name = 'MarketDataError';
  }
}

export class ValidationError extends Error {
  constructor(public message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class TradeError extends Error {
  constructor(
    public code: string,
    public message: string,
    public trade?: any
  ) {
    super(message);
    this.name = 'TradeError';
  }
}
