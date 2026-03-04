export class AppError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('TIMEOUT', message, options);
  }
}

export class RetryExhaustedError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('RETRY_EXHAUSTED', message, options);
  }
}

export class ScraperExtractionError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('SCRAPER_EXTRACTION_FAILED', message, options);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('EXTERNAL_SERVICE_ERROR', message, options);
  }
}

export class StateStoreError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('STATE_STORE_ERROR', message, options);
  }
}
