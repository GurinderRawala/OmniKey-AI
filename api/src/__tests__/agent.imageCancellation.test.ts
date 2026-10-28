import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../ai-client', () => ({
  aiClient: { generateImage: mocks.generate, getProvider: () => 'openai' },
}));
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('fs/promises', () => ({
  default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile, rename: mocks.rename, rm: mocks.rm },
}));
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
  it('does not write if cancellation happens during directory creation', async () => {
    const controller = new AbortController();
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    mocks.mkdir.mockImplementation(async () => {
      controller.abort();
    });
    const result = await executeImageGenerationTool(
      { prompt: 'Test', file_path: '/tmp/existing.png' },
      mocks.log as any,
      controller.signal,
    );
    expect(result).toContain('cancelled');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
  });
  it('discards a staged image if cancellation happens during its write', async () => {
    const controller = new AbortController();
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    mocks.writeFile.mockImplementation(async () => {
      controller.abort();
    });
    const result = await executeImageGenerationTool(
      { prompt: 'Test', file_path: '/tmp/existing.png' },
      mocks.log as any,
      controller.signal,
    );
    expect(result).toContain('cancelled');
    const staged = mocks.writeFile.mock.calls[0][0];
    expect(staged).toMatch(/^\/tmp\/existing\.png\..+\.tmp$/);
    expect(mocks.writeFile.mock.calls[0][2]).toEqual({ signal: controller.signal, flag: 'wx' });
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(staged, { force: true });
  });
  it('atomically installs a completed image and cleans the staging path', async () => {
    const controller = new AbortController();
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    const result = await executeImageGenerationTool(
      { prompt: 'Test', file_path: '/tmp/existing.png' },
      mocks.log as any,
      controller.signal,
    );
    expect(result).toContain('Saved to: /tmp/existing.png');
    const staged = mocks.writeFile.mock.calls[0][0];
    expect(mocks.rename).toHaveBeenCalledWith(staged, '/tmp/existing.png');
    expect(mocks.rm).toHaveBeenCalledWith(staged, { force: true });
  });
});
