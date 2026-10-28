import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../ai-client', () => ({
  aiClient: { generateImage: mocks.generate, getProvider: () => 'openai' },
}));
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('fs/promises', () => ({ default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile } }));
import { executeImageGenerationTool } from '../agent/imageTool';

beforeEach(() => vi.resetAllMocks());
describe('image tool cancellation', () => {
  it('does not start a cancelled image request', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await executeImageGenerationTool({ prompt: 'Test' }, mocks.log as any, controller.signal),
    ).toContain('cancelled');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('does not save image bytes returned after cancellation', async () => {
    const controller = new AbortController();
    mocks.generate.mockImplementation(async () => {
      controller.abort();
      return { imageBase64: 'aW1hZ2U=', mimeType: 'image/png', provider: 'openai' };
    });
    expect(
      await executeImageGenerationTool({ prompt: 'Test' }, mocks.log as any, controller.signal),
    ).toContain('cancelled');
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it('returns a paired tool error when the provider aborts', async () => {
    const controller = new AbortController();
    mocks.generate.mockImplementation(async () => {
      controller.abort();
      throw new Error('Request aborted');
    });
    expect(
      await executeImageGenerationTool({ prompt: 'Test' }, mocks.log as any, controller.signal),
    ).toBe('Error generating image: Request aborted');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
