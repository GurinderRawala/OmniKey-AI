import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  auth: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../agent/agentServer/turnRunner', () => ({ runAgentTurn: mocks.run }));
vi.mock('../agent/agentAuth', () => ({
  createLazyAuthContext: () => ({
    ensureAuthenticated: mocks.auth,
    getSubscription: () => ({ id: 'sub' }),
  }),
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');
  return {
    default: class {
      static OPEN = 1;
    },
    WebSocketServer: class extends EventEmitter {},
  };
});
import { attachAgentWebSocketServer } from '../agent/agentServer/websocket';
import {
  activeSessions,
  pendingShellScripts,
  sessionOwners,
  sessionQueues,
  sessionSteeringMessages,
} from '../agent/agentServer/runtimeState';

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  message(content: string, extra = {}) {
    this.emit(
      'message',
      JSON.stringify({ session_id: 'session', sender: 'client', content, ...extra }),
    );
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function connect(server: ReturnType<typeof attachAgentWebSocketServer>) {
  const socket = new Socket();
  server.emit('connection', socket, { headers: {} });
  return socket;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  mocks.auth.mockResolvedValue(true);
  activeSessions.clear();
  sessionOwners.clear();
  sessionQueues.clear();
  pendingShellScripts.clear();
  sessionSteeringMessages.clear();
});

describe('WebSocket turn ownership', () => {
  it('queues a reconnect until the disconnected owner finishes saving', async () => {
    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise).mockResolvedValue(undefined);
    const server = attachAgentWebSocketServer({} as any);
    const old = connect(server);
    old.message('first');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const signal = mocks.run.mock.calls[0][5].signal as AbortSignal;
    old.close();
    expect(signal.aborted).toBe(true);
    expect(activeSessions.has('session')).toBe(true);
    const next = connect(server);
    next.message('resume');
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(1));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    checkpoint.resolve();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1][2].content).toBe('resume');
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    next.close();
  });

  it("does not let a stale socket resolve or cancel another connection's shell", async () => {
    const checkpoint = deferred();
    mocks.run
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => checkpoint.promise);
    const server = attachAgentWebSocketServer({} as any);
    const stale = connect(server);
    stale.message('old task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const owner = connect(server);
    owner.message('new task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    const signal = mocks.run.mock.calls[1][5].signal as AbortSignal;
    const resolve = vi.fn();
    pendingShellScripts.set('session', { resolve, filterKeywords: [] });
    stale.message('late output', { is_terminal_output: true });
    await vi.waitFor(() =>
      expect(mocks.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('does not own'),
        expect.anything(),
      ),
    );
    stale.close();
    expect(signal.aborted).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    owner.message('real output', { is_terminal_output: true });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(mocks.run).toHaveBeenCalledTimes(2);
    checkpoint.resolve();
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    owner.close();
  });

  it.each([false, true, undefined])(
    'passes shell completion status separately from output: %s',
    async (isError) => {
      const checkpoint = deferred();
      mocks.run.mockImplementationOnce(async () => checkpoint.promise);
      const server = attachAgentWebSocketServer({} as any);
      const owner = connect(server);
      owner.message('new task');
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
      const resolve = vi.fn();
      pendingShellScripts.set('session', { resolve, filterKeywords: [] });
      owner.message('COMMAND ERROR: old failure in source text', {
        is_terminal_output: true,
        ...(isError === undefined ? {} : { is_error: isError }),
      });
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.any(String), isError));
      checkpoint.resolve();
      await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
      owner.close();
    },
  );

  it('drops disconnected queued messages and late authentication', async () => {
    const auth = deferred();
    mocks.auth.mockImplementationOnce(async () => {
      await auth.promise;
      return true;
    });
    const server = attachAgentWebSocketServer({} as any);
    const late = connect(server);
    late.message('never start');
    late.close();
    auth.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.run).not.toHaveBeenCalled();

    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise);
    const owner = connect(server);
    owner.message('first');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const queued = connect(server);
    queued.message('abandoned');
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(1));
    queued.close();
    expect(sessionQueues.has('session')).toBe(false);
    checkpoint.resolve();
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    owner.close();
  });
});
