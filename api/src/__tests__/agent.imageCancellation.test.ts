import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  chmod: vi.fn(),
  close: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../ai-client', () => ({
  aiClient: { generateImage: mocks.generate, getProvider: () => 'openai' },
}));
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('fs/promises', () => ({
  default: {
    mkdir: mocks.mkdir,
    stat: mocks.stat,
    open: mocks.open,
    rename: mocks.rename,
    unlink: mocks.unlink,
  },
}));
import { executeImageGenerationTool } from '../agent/imageTool';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.unlink.mockResolvedValue(undefined);
  mocks.stat.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  mocks.open.mockResolvedValue({
    writeFile: mocks.writeFile,
    chmod: mocks.chmod,
    close: mocks.close,
  });
});
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
    const staged = mocks.open.mock.calls[0][0];
    expect(staged).toMatch(/^\/tmp\/existing\.png\..+\.tmp$/);
    expect(mocks.open).toHaveBeenCalledWith(staged, 'wx', 0o600);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(staged);
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
    const staged = mocks.open.mock.calls[0][0];
    expect(mocks.rename).toHaveBeenCalledWith(staged, '/tmp/existing.png');
    expect(mocks.unlink).toHaveBeenCalledWith(staged);
  });
  it('preserves restricted destination permissions when installing an image', async () => {
    mocks.stat.mockResolvedValue({ mode: 0o100600 });
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    const result = await executeImageGenerationTool(
      { prompt: 'Test', file_path: '/tmp/private.png' },
      mocks.log as any,
    );
    expect(result).toContain('Saved to: /tmp/private.png');
    expect(mocks.open).toHaveBeenCalledWith(expect.any(String), 'wx', 0o600);
    expect(mocks.chmod).toHaveBeenCalledWith(0o600);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.chmod.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rename.mock.invocationCallOrder[0],
    );
  });
  it('ignores an already absent staging file after a successful rename', async () => {
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    mocks.unlink.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    expect(
      await executeImageGenerationTool(
        { prompt: 'Test', file_path: '/tmp/new.png' },
        mocks.log as any,
      ),
    ).toContain('Saved to: /tmp/new.png');
    expect(mocks.open).toHaveBeenCalledWith(expect.any(String), 'wx', 0o600);
    expect(mocks.chmod).not.toHaveBeenCalled();
  });
  it('never removes a colliding staging file owned by another operation', async () => {
    mocks.generate.mockResolvedValue({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      provider: 'openai',
    });
    mocks.open.mockRejectedValue(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
    expect(
      await executeImageGenerationTool(
        { prompt: 'Test', file_path: '/tmp/new.png' },
        mocks.log as any,
      ),
    ).toContain('already exists');
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
