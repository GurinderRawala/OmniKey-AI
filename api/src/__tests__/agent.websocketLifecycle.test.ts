import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  auth: vi.fn(),
  // Pre-queue ownership check: (sessionId, subscriptionId) => available.
  available: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
  unavailable: 'This message could not be processed. Start a new session and try again.',
}));
const UNAVAILABLE = mocks.unavailable;
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../agent/agentServer/turnRunner', () => ({ runAgentTurn: mocks.run }));
vi.mock('../agent/agentServer/sessionStore', () => ({
  SESSION_UNAVAILABLE_MESSAGE: mocks.unavailable,
  isSessionIdAvailableTo: mocks.available,
}));
vi.mock('../agent/agentAuth', () => ({
  // The connection's authorization header selects the authenticated identity.
  createLazyAuthContext: (authHeader?: string) => ({
    ensureAuthenticated: mocks.auth,
    getSubscription: () => ({ id: authHeader ?? 'sub' }),
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
  sessionActiveSubscriptions,
  sessionOwners,
  sessionQueues,
  sessionSteeringIds,
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
function connect(server: ReturnType<typeof attachAgentWebSocketServer>, identity?: string) {
  const socket = new Socket();
  server.emit('connection', socket, { headers: identity ? { authorization: identity } : {} });
  return socket;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  mocks.auth.mockResolvedValue(true);
  mocks.available.mockResolvedValue(true);
  activeSessions.clear();
  sessionOwners.clear();
  sessionActiveSubscriptions.clear();
  sessionSteeringIds.clear();
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

describe('WebSocket run subscription ownership', () => {
  const frames = (socket: Socket) =>
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>);

  it('rejects steering, feedback and queued input from another subscription', async () => {
    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise);
    // The stored session row belongs to sub-a.
    mocks.available.mockImplementation(async (_id: string, sub: string) => sub === 'sub-a');
    const server = attachAgentWebSocketServer({} as never);
    const owner = connect(server, 'sub-a');
    owner.message('task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(sessionActiveSubscriptions.get('session')).toEqual({ subscriptionId: 'sub-a' });
    const resolve = vi.fn();
    pendingShellScripts.set('session', { resolve, filterKeywords: [] });

    const foreign = connect(server, 'sub-b');
    foreign.message('take over', { is_steering: true, steering_id: 'foreign-1' });
    foreign.message('fake output', { is_terminal_output: true });
    foreign.message('queued foreign task');
    await vi.waitFor(() => expect(foreign.send).toHaveBeenCalledTimes(2));

    const [steerFrame, inputFrame] = frames(foreign);
    expect(steerFrame).toMatchObject({
      session_id: 'session',
      is_steering: true,
      steering_id: 'foreign-1',
      steering_status: 'rejected',
      steering_pending_count: 0,
      is_error: true,
    });
    expect(steerFrame.content).toBe(
      'The current task finished before this update could be queued. Send it again as a follow-up.',
    );
    expect(inputFrame).toMatchObject({
      session_id: 'session',
      is_error: true,
      content: UNAVAILABLE,
    });
    // Fixed frames only: no owner identity, skill refs or status leak out.
    for (const frame of frames(foreign)) {
      expect(JSON.stringify(frame)).not.toContain('sub-a');
      expect(frame).not.toHaveProperty('skill_status');
    }
    expect(sessionSteeringMessages.has('session')).toBe(false);
    expect(sessionSteeringIds.get('session')?.has('foreign-1')).toBe(false);
    expect(sessionQueues.has('session')).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();

    checkpoint.resolve();
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(sessionActiveSubscriptions.has('session')).toBe(false);
    owner.close();
    foreign.close();
  });

  it('accepts steering and queued input from another connection of the same subscription', async () => {
    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise).mockResolvedValue(undefined);
    const server = attachAgentWebSocketServer({} as never);
    const owner = connect(server, 'sub-a');
    owner.message('task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));

    const sibling = connect(server, 'sub-a');
    sibling.message('narrow it', { is_steering: true, steering_id: 'same-1' });
    await vi.waitFor(() => expect(sibling.send).toHaveBeenCalledTimes(1));
    expect(frames(sibling)[0]).toMatchObject({
      steering_id: 'same-1',
      steering_status: 'received',
    });
    expect(sessionSteeringMessages.get('session')).toHaveLength(1);
    sibling.message('follow-up');
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(1));

    checkpoint.resolve();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1][1]).toEqual({ id: 'sub-a' });
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    expect(sessionActiveSubscriptions.has('session')).toBe(false);
    owner.close();
    sibling.close();
  });

  it('rejects a foreign flood before the queue while the owner keeps FIFO order', async () => {
    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise).mockResolvedValue(undefined);
    mocks.available.mockImplementation(async (_id: string, sub: string) => sub === 'sub-a');
    const server = attachAgentWebSocketServer({} as never);
    const owner = connect(server, 'sub-a');
    owner.message('task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));

    const foreign = connect(server, 'sub-b');
    for (let i = 0; i < 25; i++) foreign.message(`flood ${i}`);
    owner.message('follow-up 1');
    owner.message('follow-up 2');
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(2));
    await vi.waitFor(() => expect(foreign.send).toHaveBeenCalledTimes(25));
    for (const frame of frames(foreign)) {
      expect(frame).toEqual({
        session_id: 'session',
        sender: 'agent',
        content: UNAVAILABLE,
        is_terminal_output: false,
        is_error: true,
      });
    }
    // Only the owner's inputs ever queued; the active owner never changed.
    expect(sessionQueues.get('session')!.map((q) => q.subscription.id)).toEqual(['sub-a', 'sub-a']);
    expect(sessionActiveSubscriptions.get('session')).toEqual({ subscriptionId: 'sub-a' });
    expect(owner.send).not.toHaveBeenCalled();

    checkpoint.resolve();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(3));
    expect(mocks.run.mock.calls.map((c) => [c[1].id, c[2].content])).toEqual([
      ['sub-a', 'task'],
      ['sub-a', 'follow-up 1'],
      ['sub-a', 'follow-up 2'],
    ]);
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    owner.close();
    foreign.close();
  });

  it('queues an owner input behind an unproven foreign claim instead of dropping it', async () => {
    // Unused id: sub-b may claim it first; its turn is refused once the
    // owner's row exists (simulated by the run mock), then sub-a proceeds.
    const foreignTurn = deferred();
    mocks.run.mockImplementationOnce(async () => foreignTurn.promise).mockResolvedValue(undefined);
    const server = attachAgentWebSocketServer({} as never);
    const foreign = connect(server, 'sub-b');
    foreign.message('claim');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(sessionActiveSubscriptions.get('session')).toEqual({ subscriptionId: 'sub-b' });

    const owner = connect(server, 'sub-a');
    owner.message('owner input');
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(1));
    expect(owner.send).not.toHaveBeenCalled();
    // Steering and feedback still never cross into the other run.
    owner.message('steer', { is_steering: true, steering_id: 's-1' });
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledTimes(1));
    expect(frames(owner)[0]).toMatchObject({ steering_id: 's-1', steering_status: 'rejected' });
    expect(sessionSteeringMessages.has('session')).toBe(false);

    foreignTurn.resolve();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1][1]).toEqual({ id: 'sub-a' });
    expect(mocks.run.mock.calls[1][2].content).toBe('owner input');
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    owner.close();
    foreign.close();
  });

  it('admits one connection in arrival order even when an ownership check is slow', async () => {
    const slow = deferred();
    mocks.available
      .mockImplementationOnce(async () => {
        await slow.promise;
        return true;
      })
      .mockResolvedValue(true);
    const firstTurn = deferred();
    mocks.run.mockImplementationOnce(async () => firstTurn.promise).mockResolvedValue(undefined);
    const server = attachAgentWebSocketServer({} as never);
    const owner = connect(server, 'sub-a');
    owner.message('first');
    owner.message('second');
    owner.message('third');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Later messages wait for the first admission instead of overtaking it.
    expect(mocks.run).not.toHaveBeenCalled();
    expect(sessionQueues.has('session')).toBe(false);
    slow.resolve();
    await vi.waitFor(() => expect(sessionQueues.get('session')).toHaveLength(2));
    expect(mocks.run.mock.calls[0][2].content).toBe('first');
    firstTurn.resolve();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(3));
    expect(mocks.run.mock.calls.map((c) => c[2].content)).toEqual(['first', 'second', 'third']);
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    owner.close();
  });

  it('does not wait for a running turn before admitting terminal feedback', async () => {
    const checkpoint = deferred();
    mocks.run.mockImplementationOnce(async () => checkpoint.promise);
    const server = attachAgentWebSocketServer({} as never);
    const owner = connect(server, 'sub-a');
    owner.message('task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const resolve = vi.fn();
    pendingShellScripts.set('session', { resolve, filterKeywords: [] });
    owner.message('output', { is_terminal_output: true });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    // Feedback for an active turn needs no extra ownership lookup.
    expect(mocks.available).toHaveBeenCalledTimes(1);
    checkpoint.resolve();
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    owner.close();
  });

  it('fails closed when the pre-queue ownership check cannot prove access', async () => {
    mocks.available.mockResolvedValueOnce(false);
    const server = attachAgentWebSocketServer({} as never);
    const socket = connect(server, 'sub-a');
    socket.message('task');
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1));
    expect(frames(socket)[0]).toMatchObject({ content: UNAVAILABLE, is_error: true });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(activeSessions.has('session')).toBe(false);
    expect(sessionActiveSubscriptions.has('session')).toBe(false);
    expect(sessionQueues.has('session')).toBe(false);
    socket.close();
  });

  it('clears the run owner after errors and lets another subscription start later', async () => {
    mocks.run.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const server = attachAgentWebSocketServer({} as never);
    const first = connect(server, 'sub-a');
    first.message('task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(mocks.log.error).toHaveBeenCalledWith('Queued agent turn failed', expect.anything()),
    );
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    expect(sessionActiveSubscriptions.has('session')).toBe(false);
    expect(sessionSteeringIds.has('session')).toBe(false);

    const second = connect(server, 'sub-b');
    second.message('own task');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1][1]).toEqual({ id: 'sub-b' });
    await vi.waitFor(() => expect(activeSessions.has('session')).toBe(false));
    expect(sessionActiveSubscriptions.has('session')).toBe(false);
    first.close();
    second.close();
  });
});
