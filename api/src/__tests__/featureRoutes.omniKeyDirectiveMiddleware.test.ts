import { describe, expect, it, vi } from 'vitest';
import { omniKeyDirectiveMiddleware } from '../featureRoutes';

function run(text: unknown) {
  const req = { body: { text } } as any;
  const res = { locals: {} } as any;
  const next = vi.fn();

  omniKeyDirectiveMiddleware(req, res, next);

  return { directive: res.locals.omniKeyDirective, next };
}

describe('omniKeyDirectiveMiddleware', () => {
  it('extracts a case-insensitive directive and keeps preceding text as context', () => {
    const { directive, next } = run('Source text\n@OmniKeyAI: summarize it in one sentence');

    expect(directive).toEqual({
      instructions: 'summarize it in one sentence',
      context: 'Source text',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('supports a directive at the start without a colon', () => {
    expect(run('@omnikeyai explain quantum computing').directive).toEqual({
      instructions: 'explain quantum computing',
      context: '',
    });
  });

  it('does not enable directive mode for empty or embedded mentions', () => {
    expect(run('email support@omnikeyai.com').directive).toBeUndefined();
    expect(run('@omnikeyai:   ').directive).toBeUndefined();
  });
});
