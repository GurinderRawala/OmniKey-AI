export type EnhanceCommand = 'grammar' | 'enhance' | 'task';

export class OmniKeyError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
