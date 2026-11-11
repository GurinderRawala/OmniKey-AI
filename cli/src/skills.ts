/**
 * `omnikey skills …` — manage backend-owned Skills over the daemon's HTTP API
 * (docs/skills-contract.md). The CLI never touches the database directly and
 * never runs a local matcher: `skills match` calls the backend preview, which
 * does not send anything to the agent.
 *
 * Exit codes: 0 success, 1 API/auth/conflict/network/file failure (including
 * server-side validation), 2 local usage errors. With --json, stdout carries
 * only the success envelope; diagnostics always go to stderr. License keys,
 * tokens and instruction bodies are never written to diagnostics.
 */
import fs from 'fs';
import axios from 'axios';
import { Command, CommanderError } from 'commander';
import { getPort, readConfig } from './utils';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Read bound for instruction files/stdin. The server enforces the exact 32 KiB
 * cap after CRLF→LF normalization; this only stops unbounded buffering. */
export const INSTRUCTIONS_INPUT_MAX_BYTES = 65_536;
/** Same as the backend preview input byte limit. */
export const MATCH_INPUT_MAX_BYTES = 400_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
export const DEFAULT_STDIN_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// ── DTOs (mirror the JSON contract; never import API source) ────────────────

export interface SkillSummary {
  id: string;
  name: string;
  keyword: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SkillDTO extends SkillSummary {
  instructions: string;
}
export interface AppliedSkillRef {
  id: string;
  name: string;
  keyword: string;
  revision: number;
}
export interface SkillWarning {
  code: string;
  skillId?: string;
  message: string;
}
export interface SkillMatchPreview {
  matches: AppliedSkillRef[];
  warnings: SkillWarning[];
}

// ── Adapters ────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export interface HttpResponse {
  status: number;
  data: unknown;
}
/** Authenticated transport to /api/skills. Throws SkillsCliError for network/auth failures. */
export interface SkillsTransport {
  request(
    method: HttpMethod,
    path: string,
    options?: { body?: unknown; ifMatch?: number },
  ): Promise<HttpResponse>;
}

export interface Prompter {
  text(message: string, defaultValue?: string): Promise<string>;
  editor(message: string, defaultValue?: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
}

export interface SkillsIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** True only when prompts can be shown (stdin and stderr are terminals). */
  interactive: boolean;
  prompter: () => Prompter;
}

export interface SkillsDeps {
  io: SkillsIO;
  transport: () => SkillsTransport;
  setExitCode(code: number): void;
  stdinTimeoutMs?: number;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class SkillsCliError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly code: string,
    message: string,
    public readonly details: string[] = [],
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SkillsCliError';
  }
}

/** Thrown from commander's exit override so tests never reach process.exit. */
export class SkillsExit extends Error {
  constructor(public readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'SkillsExit';
  }
}

const usage = (message: string, details: string[] = []) =>
  new SkillsCliError(EXIT_USAGE, 'USAGE_ERROR', message, details);
const failure = (code: string, message: string, details: string[] = [], status?: number) =>
  new SkillsCliError(EXIT_FAILURE, code, message, details, status);

/** Remove terminal control characters (keeps tab/LF) and cap length. */
export function sanitizeForTerminal(value: string, max = Infinity): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// ── HTTP transport (production) ─────────────────────────────────────────────

export interface HttpTransportOptions {
  baseUrl: string;
  licenseKey: string;
  timeoutMs?: number;
  activationTimeoutMs?: number;
}

function networkError(err: unknown, baseUrl: string, timeoutMs: number): SkillsCliError {
  const code = (err as { code?: unknown })?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return failure(
      'BACKEND_UNAVAILABLE',
      `Cannot reach the OmniKey backend at ${baseUrl}. Is the daemon running? Start it with \`omnikey daemon\`.`,
    );
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return failure(
      'TIMEOUT',
      `The OmniKey backend did not respond within ${Math.round(timeoutMs / 1000)}s.`,
    );
  }
  if (code === 'ERR_BAD_RESPONSE' || code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') {
    return failure('BAD_RESPONSE', 'The OmniKey backend returned an unreadable response.');
  }
  return failure('NETWORK_ERROR', `Request to the OmniKey backend at ${baseUrl} failed.`);
}

function activationError(res: HttpResponse): SkillsCliError {
  const status = res.status;
  const data = res.data as { subscriptionStatus?: unknown } | undefined;
  if (status === 401) {
    return failure(
      'AUTH_FAILED',
      'The backend rejected the configured license key. Run `omnikey onboard` or check your configuration.',
      [],
      status,
    );
  }
  if (status === 403) {
    return failure(
      'AUTH_FAILED',
      data?.subscriptionStatus === 'expired'
        ? 'Your OmniKey subscription has expired.'
        : 'The backend refused authentication.',
      [],
      status,
    );
  }
  return failure(
    'AUTH_FAILED',
    `Authentication with the backend failed (HTTP ${status}).`,
    [],
    status,
  );
}

/**
 * Uses the existing CLI conventions: activate the configured license key at
 * /api/subscription/activate on the local daemon, then send a Bearer JWT. A
 * 401 or the legacy 403 Invalid or expired token response re-activates once and retries;
 * the backend authenticates before reading any body, so the retry is safe.
 */
export function createHttpTransport(options: HttpTransportOptions): SkillsTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  const common = {
    validateStatus: () => true,
    maxRedirects: 0,
    // The daemon is local; never route the license key/JWT via an env proxy.
    proxy: false as const,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
  };
  let token: string | undefined;

  const activate = async (): Promise<string> => {
    let res: HttpResponse;
    try {
      // Existing CLI commands send `licenseKey`; the activation route reads `key`.
      res = await axios.post(
        `${options.baseUrl}/api/subscription/activate`,
        { key: options.licenseKey, licenseKey: options.licenseKey },
        { ...common, timeout: activationTimeoutMs },
      );
    } catch (err) {
      throw networkError(err, options.baseUrl, activationTimeoutMs);
    }
    const value = (res.data as { token?: unknown } | undefined)?.token;
    if (res.status >= 200 && res.status < 300 && typeof value === 'string' && value) {
      token = value;
      return value;
    }
    throw activationError(res);
  };

  const send = async (
    method: HttpMethod,
    path: string,
    body: unknown,
    ifMatch: number | undefined,
    jwt: string,
  ): Promise<HttpResponse> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${jwt}`,
    };
    if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
    try {
      const res = await axios.request({
        ...common,
        method,
        url: `${options.baseUrl}${path}`,
        data: body,
        headers,
        timeout: timeoutMs,
      });
      return { status: res.status, data: res.data };
    } catch (err) {
      throw networkError(err, options.baseUrl, timeoutMs);
    }
  };

  return {
    async request(method, path, { body, ifMatch } = {}) {
      let res = await send(method, path, body, ifMatch, token ?? (await activate()));
      if (
        res.status === 401 ||
        (res.status === 403 &&
          (res.data as { error?: unknown })?.error === 'Invalid or expired token.')
      ) {
        token = undefined;
        res = await send(method, path, body, ifMatch, await activate());
      }
      return res;
    },
  };
}

export function createDefaultTransport(): SkillsTransport {
  const port = getPort();
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw failure('CONFIG_ERROR', 'OMNIKEY_PORT in ~/.omnikey/config.json is not a valid port.');
  }
  const config = readConfig();
  const licenseKey =
    typeof config.OMNIKEY_LICENSE_KEY === 'string' ? config.OMNIKEY_LICENSE_KEY : '';
  return createHttpTransport({ baseUrl: `http://localhost:${port}`, licenseKey });
}

// ── API error mapping ───────────────────────────────────────────────────────

function structuredError(
  data: unknown,
): { code: string; message: string; fields?: Record<string, string> } | null {
  const e = (data as { error?: unknown } | null | undefined)?.error;
  if (!e || typeof e !== 'object') return null;
  const { code, message, fields } = e as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const safeFields: Record<string, string> = {};
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof v === 'string') safeFields[k] = v;
    }
  }
  return { code, message, ...(Object.keys(safeFields).length ? { fields: safeFields } : {}) };
}

const CODE_HINTS: Record<string, string> = {
  REVISION_CONFLICT:
    'The skill changed since it was read. Run `omnikey skills show <id>` and retry.',
  KEYWORD_CONFLICT: 'Another skill (possibly disabled) already uses this keyword.',
  SKILL_QUOTA_EXCEEDED: 'Delete unused skills before adding more.',
  STORE_UNAVAILABLE: 'Skills storage is temporarily unavailable. Retry shortly.',
};

function apiError(res: HttpResponse, opts: { listing?: boolean } = {}): SkillsCliError {
  const { status } = res;
  if (status === 404 && (opts.listing || !structuredError(res.data))) {
    return failure(
      'BACKEND_UNSUPPORTED',
      'This OmniKey backend does not support Skills. Upgrade and restart the daemon.',
      [],
      status,
    );
  }
  const err = structuredError(res.data);
  if (err) {
    const details = Object.entries(err.fields ?? {}).map(
      ([k, v]) => `${sanitizeForTerminal(k, 40)}: ${sanitizeForTerminal(v, 200)}`,
    );
    const hint = CODE_HINTS[err.code];
    if (hint) details.push(hint);
    return failure(
      sanitizeForTerminal(err.code, 40),
      sanitizeForTerminal(err.message, 300),
      details,
      status,
    );
  }
  // Legacy/unstructured bodies (auth middleware strings, HTML) are not echoed.
  if (
    status === 401 ||
    (status === 403 && (res.data as { error?: unknown })?.error === 'Invalid or expired token.')
  ) {
    return failure('UNAUTHENTICATED', 'The backend rejected the session token.', [], status);
  }
  if (
    status === 403 &&
    (res.data as { subscriptionStatus?: unknown })?.subscriptionStatus === 'expired'
  ) {
    return failure(
      'FORBIDDEN',
      'Your subscription has expired. Renew it before trying again.',
      [],
      status,
    );
  }
  if (status === 403) return failure('FORBIDDEN', 'The backend denied access.', [], status);
  if (status === 404) {
    return failure(
      'NOT_FOUND',
      'Skill not found (or this backend does not support Skills).',
      [],
      status,
    );
  }
  return failure('HTTP_ERROR', `The backend request failed (HTTP ${status}).`, [], status);
}

// ── Response validation ─────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string';
function isSummary(v: unknown): v is SkillSummary {
  const s = v as Record<string, unknown> | null;
  return (
    !!s &&
    isStr(s.id) &&
    isStr(s.name) &&
    isStr(s.keyword) &&
    typeof s.enabled === 'boolean' &&
    Number.isSafeInteger(s.revision) &&
    isStr(s.createdAt) &&
    isStr(s.updatedAt)
  );
}
const isSkill = (v: unknown): v is SkillDTO =>
  isSummary(v) && isStr((v as unknown as Record<string, unknown>).instructions);
function isRef(v: unknown): v is AppliedSkillRef {
  const s = v as Record<string, unknown> | null;
  return (
    !!s && isStr(s.id) && isStr(s.name) && isStr(s.keyword) && Number.isSafeInteger(s.revision)
  );
}
const badResponse = () =>
  failure('BAD_RESPONSE', 'The OmniKey backend returned an unexpected response.');

function expectSkillEnvelope(res: HttpResponse, okStatus: number): { skill: SkillDTO } {
  if (res.status !== okStatus) throw apiError(res);
  const skill = (res.data as { skill?: unknown } | null)?.skill;
  if (!isSkill(skill)) throw badResponse();
  return res.data as { skill: SkillDTO };
}

// ── Input helpers ───────────────────────────────────────────────────────────

const decoder = () => new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(buf: Buffer, label: string): string {
  try {
    return decoder().decode(buf); // strips a leading BOM
  } catch {
    throw failure('FILE_ERROR', `${label} is not valid UTF-8 text.`);
  }
}

/** Reads a regular file without ever buffering more than maxBytes + 1 bytes. */
export async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  let handle: fs.promises.FileHandle;
  try {
    // O_NONBLOCK keeps a FIFO from blocking open(); fstat then rejects it.
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const reason =
      code === 'ENOENT'
        ? 'does not exist'
        : code === 'EACCES' || code === 'EPERM'
          ? 'is not readable'
          : 'could not be opened';
    throw failure('FILE_ERROR', `${label} ${reason}.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('FILE_ERROR', `${label} must be a regular file.`);
    const tooLarge = () => failure('FILE_ERROR', `${label} is larger than ${maxBytes} bytes.`);
    if (stat.size > maxBytes) throw tooLarge();
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
    }
    return decodeUtf8(buf.subarray(0, total), label);
  } catch (err) {
    if (err instanceof SkillsCliError) throw err;
    throw failure('FILE_ERROR', `${label} could not be read.`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads a stream to EOF, rejecting as soon as it exceeds maxBytes or times out. */
export function readBoundedStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  timeoutMs: number,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (err: SkillsCliError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (err) {
        stream.pause();
        (stream as { destroy?: () => void }).destroy?.();
        reject(err);
        return;
      }
      try {
        resolve(decodeUtf8(Buffer.concat(chunks, total), label));
      } catch (e) {
        reject(e);
      }
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buf.length;
      if (total > maxBytes) {
        finish(failure('FILE_ERROR', `${label} is larger than ${maxBytes} bytes.`));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish(null);
    const onError = () => finish(failure('FILE_ERROR', `${label} could not be read.`));
    const timer = setTimeout(
      () =>
        finish(
          failure('TIMEOUT', `${label} was not closed within ${Math.round(timeoutMs / 1000)}s.`),
        ),
      timeoutMs,
    );
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}

async function readSource(
  deps: SkillsDeps,
  source: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (source === '-') {
    if (deps.io.stdin.isTTY) {
      throw usage(`Refusing to read ${label} from an interactive terminal; pipe or redirect it.`);
    }
    return readBoundedStream(
      deps.io.stdin,
      maxBytes,
      deps.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS,
      `${label} from stdin`,
    );
  }
  return readBoundedFile(source, maxBytes, `${label} file`);
}

function parseRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw usage('--revision must be a positive integer.');
  }
  return Number(value);
}

function requireId(id: string): string {
  if (!id || !id.trim()) throw usage('A skill id is required.');
  return id.trim();
}

const itemPath = (id: string) => `/api/skills/${encodeURIComponent(id)}`;

/** Classify cancellation without echoing prompt input or raw initialization errors. */
async function ask<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const error = err as { name?: unknown; message?: unknown };
    if (
      error?.name === 'ExitPromptError' ||
      error?.name === 'AbortPromptError' ||
      error?.message === 'User force closed the prompt' ||
      error?.message === 'User force closed the prompt with 0 null'
    ) {
      throw failure('CANCELLED', 'Cancelled.');
    }
    throw failure(
      'PROMPT_ERROR',
      'The interactive prompt could not be opened or completed. Retry, or supply command flags and an instructions file.',
    );
  }
}

async function requiredText(p: Prompter, message: string, def?: string): Promise<string> {
  for (;;) {
    const value = (await ask(() => p.text(message, def))).trim();
    if (value) return value;
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

const writeJson = (deps: SkillsDeps, value: unknown) =>
  deps.io.stdout(`${JSON.stringify(value, null, 2)}\n`);

function padEnd(value: string, width: number): string {
  const len = [...value].length;
  return len >= width ? value : value + ' '.repeat(width - len);
}

function printSkill(deps: SkillsDeps, skill: SkillDTO, withInstructions: boolean): void {
  const out = deps.io.stdout;
  out(`ID:        ${sanitizeForTerminal(skill.id)}\n`);
  out(`Name:      ${sanitizeForTerminal(skill.name)}\n`);
  out(`Keyword:   ${sanitizeForTerminal(skill.keyword)}\n`);
  out(`Enabled:   ${skill.enabled ? 'yes' : 'no'}\n`);
  out(`Revision:  ${skill.revision}\n`);
  out(`Updated:   ${sanitizeForTerminal(skill.updatedAt)}\n`);
  if (withInstructions) {
    out('Instructions:\n');
    const body = sanitizeForTerminal(skill.instructions);
    out(body.endsWith('\n') ? body : `${body}\n`);
  }
}

function reportError(deps: SkillsDeps, err: unknown, json: boolean): number {
  const e =
    err instanceof SkillsCliError
      ? err
      : failure('INTERNAL_ERROR', 'Unexpected error while running the skills command.');
  if (json) {
    deps.io.stderr(
      `${JSON.stringify({
        error: {
          code: e.code,
          message: e.message,
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.details.length ? { details: e.details } : {}),
        },
      })}\n`,
    );
  } else {
    deps.io.stderr(`Error: ${e.message}\n`);
    for (const d of e.details) deps.io.stderr(`  ${d}\n`);
  }
  return e.exitCode;
}

// ── Command implementations ─────────────────────────────────────────────────

async function getSkill(t: SkillsTransport, id: string): Promise<SkillDTO> {
  return expectSkillEnvelope(await t.request('GET', itemPath(id)), 200).skill;
}

async function cmdList(deps: SkillsDeps, opts: { json?: boolean }): Promise<void> {
  const res = await deps.transport().request('GET', '/api/skills');
  if (res.status !== 200) throw apiError(res, { listing: true });
  const skills = (res.data as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills) || !skills.every(isSummary)) throw badResponse();
  if (opts.json) return writeJson(deps, res.data);
  if (skills.length === 0) {
    deps.io.stdout('No skills yet. Add one with `omnikey skills add`.\n');
    return;
  }
  deps.io.stdout(`${padEnd('ID', 28)}${padEnd('ENABLED', 9)}${padEnd('REV', 6)}NAME  [KEYWORD]\n`);
  for (const s of skills as SkillSummary[]) {
    deps.io.stdout(
      `${padEnd(sanitizeForTerminal(s.id), 28)}${padEnd(s.enabled ? 'yes' : 'no', 9)}${padEnd(
        String(s.revision),
        6,
      )}${sanitizeForTerminal(s.name)}  [${sanitizeForTerminal(s.keyword)}]\n`,
    );
  }
}

async function cmdShow(deps: SkillsDeps, rawId: string, opts: { json?: boolean }): Promise<void> {
  const id = requireId(rawId);
  const envelope = expectSkillEnvelope(await deps.transport().request('GET', itemPath(id)), 200);
  if (opts.json) return writeJson(deps, envelope);
  printSkill(deps, envelope.skill, true);
}

interface AddOptions {
  name?: string;
  keyword?: string;
  instructionsFile?: string;
  disabled?: boolean;
  json?: boolean;
}

async function cmdAdd(deps: SkillsDeps, opts: AddOptions): Promise<void> {
  let name = opts.name?.trim();
  let keyword = opts.keyword?.trim();
  if (opts.name !== undefined && !name) throw usage('--name must not be blank.');
  if (opts.keyword !== undefined && !keyword) throw usage('--keyword must not be blank.');
  const missing = [
    !name && '--name',
    !keyword && '--keyword',
    opts.instructionsFile === undefined && '--instructions-file',
  ].filter(Boolean) as string[];
  if (missing.length && !deps.io.interactive) {
    throw usage(`Missing required options: ${missing.join(', ')}.`, [
      'Non-interactive use requires --name, --keyword and --instructions-file <path|->.',
    ]);
  }
  // Read input before prompting so file errors surface before any typing.
  let instructions =
    opts.instructionsFile !== undefined
      ? await readSource(deps, opts.instructionsFile, INSTRUCTIONS_INPUT_MAX_BYTES, 'Instructions')
      : undefined;
  if (instructions !== undefined && !instructions.trim()) {
    throw usage('Instructions must not be blank.');
  }
  if (missing.length) {
    const p = deps.io.prompter();
    if (!name) name = await requiredText(p, 'Skill name:');
    if (!keyword) keyword = await requiredText(p, 'Trigger keyword or phrase:');
    if (instructions === undefined) {
      instructions = await ask(() => p.editor('Instructions (opens your editor):'));
      if (!instructions.trim()) throw usage('Instructions must not be blank.');
    }
  }
  const res = await deps.transport().request('POST', '/api/skills', {
    body: { name, keyword, instructions, enabled: !opts.disabled },
  });
  const envelope = expectSkillEnvelope(res, 201);
  if (opts.json) return writeJson(deps, envelope);
  deps.io.stdout('Skill created.\n');
  printSkill(deps, envelope.skill, false);
}

interface EditOptions {
  name?: string;
  keyword?: string;
  instructionsFile?: string;
  revision?: string;
  json?: boolean;
}

async function cmdEdit(deps: SkillsDeps, rawId: string, opts: EditOptions): Promise<void> {
  const id = requireId(rawId);
  const expected = parseRevision(opts.revision);
  if (opts.name !== undefined && !opts.name.trim()) throw usage('--name must not be blank.');
  if (opts.keyword !== undefined && !opts.keyword.trim()) {
    throw usage('--keyword must not be blank.');
  }
  const hasFlags =
    opts.name !== undefined || opts.keyword !== undefined || opts.instructionsFile !== undefined;
  if (!hasFlags && !deps.io.interactive) {
    throw usage('Nothing to edit.', [
      'Non-interactive use requires at least one of --name, --keyword, --instructions-file.',
    ]);
  }
  const patch: { name?: string; keyword?: string; instructions?: string } = {};
  if (opts.name !== undefined) patch.name = opts.name.trim();
  if (opts.keyword !== undefined) patch.keyword = opts.keyword.trim();
  if (opts.instructionsFile !== undefined) {
    patch.instructions = await readSource(
      deps,
      opts.instructionsFile,
      INSTRUCTIONS_INPUT_MAX_BYTES,
      'Instructions',
    );
    if (!patch.instructions.trim()) throw usage('Instructions must not be blank.');
  }

  const t = deps.transport();
  // Always read the current revision (and defaults for prompts).
  const current = await getSkill(t, id);
  if (expected !== undefined && expected !== current.revision) {
    throw failure('REVISION_CONFLICT', 'Skill changed. Reload before retrying.', [
      `Expected revision ${expected}, current revision is ${current.revision}.`,
    ]);
  }
  if (!hasFlags) {
    const p = deps.io.prompter();
    const name = await requiredText(p, 'Skill name:', current.name);
    const keyword = await requiredText(p, 'Trigger keyword or phrase:', current.keyword);
    if (name !== current.name) patch.name = name;
    if (keyword !== current.keyword) patch.keyword = keyword;
    if (await ask(() => p.confirm('Edit instructions in your editor?', false))) {
      const edited = await ask(() => p.editor('Instructions:', current.instructions));
      if (!edited.trim()) throw usage('Instructions must not be blank.');
      if (edited !== current.instructions) patch.instructions = edited;
    }
    if (Object.keys(patch).length === 0) {
      if (opts.json) return writeJson(deps, { skill: current });
      deps.io.stdout('No changes.\n');
      return;
    }
  }
  const res = await t.request('PATCH', itemPath(id), {
    body: patch,
    ifMatch: expected ?? current.revision,
  });
  const envelope = expectSkillEnvelope(res, 200);
  if (opts.json) return writeJson(deps, envelope);
  deps.io.stdout('Skill updated.\n');
  printSkill(deps, envelope.skill, false);
}

async function cmdSetEnabled(
  deps: SkillsDeps,
  rawId: string,
  enabled: boolean,
  opts: { revision?: string; json?: boolean },
): Promise<void> {
  const id = requireId(rawId);
  const expected = parseRevision(opts.revision);
  const t = deps.transport();
  let revision = expected;
  if (revision === undefined) {
    const current = await getSkill(t, id);
    if (current.enabled === enabled) {
      if (opts.json) return writeJson(deps, { skill: current });
      deps.io.stdout(`Skill is already ${enabled ? 'enabled' : 'disabled'}.\n`);
      return;
    }
    revision = current.revision;
  }
  const envelope = expectSkillEnvelope(
    await t.request('PATCH', itemPath(id), { body: { enabled }, ifMatch: revision }),
    200,
  );
  if (opts.json) return writeJson(deps, envelope);
  deps.io.stdout(
    `Skill "${sanitizeForTerminal(envelope.skill.name)}" ${enabled ? 'enabled' : 'disabled'} (revision ${envelope.skill.revision}).\n`,
  );
  if (!enabled) {
    deps.io.stdout('Runs already in progress keep their snapshot; use Stop to end them.\n');
  }
}

async function cmdDelete(
  deps: SkillsDeps,
  rawId: string,
  opts: { yes?: boolean; revision?: string; json?: boolean },
): Promise<void> {
  const id = requireId(rawId);
  const expected = parseRevision(opts.revision);
  if (!opts.yes && !deps.io.interactive) {
    throw usage('Refusing to delete without confirmation; pass --yes in non-interactive use.');
  }
  const t = deps.transport();
  const current = await getSkill(t, id);
  if (expected !== undefined && expected !== current.revision) {
    throw failure('REVISION_CONFLICT', 'Skill changed. Reload before retrying.', [
      `Expected revision ${expected}, current revision is ${current.revision}.`,
    ]);
  }
  if (!opts.yes) {
    const ok = await ask(() =>
      deps.io
        .prompter()
        .confirm(
          `Permanently delete skill "${sanitizeForTerminal(current.name)}" [${sanitizeForTerminal(current.keyword)}]?`,
          false,
        ),
    );
    if (!ok) throw failure('CANCELLED', 'Not confirmed; skill was not deleted.');
  }
  const res = await t.request('DELETE', itemPath(id), { ifMatch: current.revision });
  if (res.status !== 204 && res.status !== 200) throw apiError(res);
  if (opts.json) return writeJson(deps, { deleted: true });
  deps.io.stdout(`Skill "${sanitizeForTerminal(current.name)}" deleted.\n`);
}

async function cmdMatch(
  deps: SkillsDeps,
  opts: { text?: string; textFile?: string; json?: boolean },
): Promise<void> {
  if (opts.text !== undefined && opts.textFile !== undefined) {
    throw usage('Use either --text or --text-file, not both.');
  }
  let text: string;
  if (opts.text !== undefined) {
    text = opts.text;
  } else if (opts.textFile !== undefined) {
    text = await readSource(deps, opts.textFile, MATCH_INPUT_MAX_BYTES, 'Preview text');
  } else if (deps.io.interactive) {
    text = await ask(() => deps.io.prompter().text('Sample message to preview:'));
  } else {
    throw usage('Missing --text <text> or --text-file <path|->.');
  }
  const res = await deps.transport().request('POST', '/api/skills/match', { body: { text } });
  if (res.status !== 200) throw apiError(res);
  const data = res.data as { matches?: unknown; warnings?: unknown } | null;
  if (!data || !Array.isArray(data.matches) || !data.matches.every(isRef)) throw badResponse();
  if (!Array.isArray(data.warnings)) throw badResponse();
  const preview = data as SkillMatchPreview;
  if (opts.json) return writeJson(deps, preview);
  const out = deps.io.stdout;
  out('Preview only: nothing was sent to the agent.\n');
  if (preview.matches.length === 0) {
    out('No enabled skills would apply to this text.\n');
  } else {
    out('Skills that would apply to a message with this text, in order:\n');
    for (const m of preview.matches) {
      out(
        `  ${sanitizeForTerminal(m.name)}  [${sanitizeForTerminal(m.keyword)}]  ${sanitizeForTerminal(m.id)} r${m.revision}\n`,
      );
    }
  }
  for (const w of preview.warnings as SkillWarning[]) {
    const ref = typeof w?.skillId === 'string' ? ` (${sanitizeForTerminal(w.skillId)})` : '';
    out(`Warning${ref}: ${sanitizeForTerminal(String(w?.message ?? ''), 300)}\n`);
  }
}

// ── Commander wiring ────────────────────────────────────────────────────────

function exitOverride(err: CommanderError): never {
  throw new SkillsExit(err.exitCode === 0 ? EXIT_OK : EXIT_USAGE);
}

/**
 * Adds `skills` to the given program. Commander parse errors inside the
 * subtree throw SkillsExit (0 for help, 2 for usage) instead of exiting.
 */
export function registerSkillsCommand(program: Command, deps: SkillsDeps): Command {
  const skills = program
    .command('skills')
    .description('Manage Skills: saved instructions applied when a message contains their keyword')
    .configureOutput({
      writeOut: (s) => deps.io.stdout(s),
      writeErr: (s) => deps.io.stderr(s),
    })
    .exitOverride(exitOverride);

  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      const opts = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as
        | { json?: boolean }
        | undefined;
      try {
        await fn(...args);
        deps.setExitCode(EXIT_OK);
      } catch (err) {
        deps.setExitCode(reportError(deps, err, !!opts?.json));
      }
    };

  skills
    .command('list')
    .description('List skills (instructions are not included)')
    .option('--json', 'print the API response as JSON')
    .action(run((opts: { json?: boolean }) => cmdList(deps, opts)));

  skills
    .command('show <id>')
    .description('Show a skill, including its instructions')
    .option('--json', 'print the API response as JSON')
    .action(run((id: string, opts: { json?: boolean }) => cmdShow(deps, id, opts)));

  skills
    .command('add')
    .description('Create a skill (prompts for missing fields on a terminal)')
    .option('--name <name>', 'display name')
    .option('--keyword <keyword>', 'literal trigger keyword or phrase')
    .option('--instructions-file <path>', 'read instructions from a file, or - for stdin')
    .option('--disabled', 'create the skill disabled')
    .option('--json', 'print the API response as JSON')
    .action(run((opts: AddOptions) => cmdAdd(deps, opts)));

  skills
    .command('edit <id>')
    .description('Edit a skill (prompts on a terminal when no field options are given)')
    .option('--name <name>', 'new display name')
    .option('--keyword <keyword>', 'new trigger keyword or phrase')
    .option('--instructions-file <path>', 'read new instructions from a file, or - for stdin')
    .option('--revision <n>', 'fail unless the skill is still at this revision')
    .option('--json', 'print the API response as JSON')
    .action(run((id: string, opts: EditOptions) => cmdEdit(deps, id, opts)));

  skills
    .command('enable <id>')
    .description('Enable a skill')
    .option('--revision <n>', 'fail unless the skill is still at this revision')
    .option('--json', 'print the API response as JSON')
    .action(
      run((id: string, opts: { revision?: string; json?: boolean }) =>
        cmdSetEnabled(deps, id, true, opts),
      ),
    );

  skills
    .command('disable <id>')
    .description('Disable a skill (future messages only)')
    .option('--revision <n>', 'fail unless the skill is still at this revision')
    .option('--json', 'print the API response as JSON')
    .action(
      run((id: string, opts: { revision?: string; json?: boolean }) =>
        cmdSetEnabled(deps, id, false, opts),
      ),
    );

  skills
    .command('delete <id>')
    .alias('remove')
    .description('Permanently delete a skill')
    .option('-y, --yes', 'do not ask for confirmation (required when not on a terminal)')
    .option('--revision <n>', 'fail unless the skill is still at this revision')
    .option('--json', 'print {"deleted":true} on success')
    .action(
      run((id: string, opts: { yes?: boolean; revision?: string; json?: boolean }) =>
        cmdDelete(deps, id, opts),
      ),
    );

  skills
    .command('match')
    .description(
      'Preview which enabled skills the backend would apply to a message. Does not send it to the agent.',
    )
    .option('--text <text>', 'sample message text')
    .option('--text-file <path>', 'read sample text from a file, or - for stdin')
    .option('--json', 'print the API response as JSON')
    .action(
      run((opts: { text?: string; textFile?: string; json?: boolean }) => cmdMatch(deps, opts)),
    );

  skills.allowExcessArguments(false);
  for (const command of skills.commands) command.allowExcessArguments(false);
  return skills;
}

/** Parses `argv` (user args, e.g. ['skills','list']) with a fresh program; never exits. */
export async function runSkillsCli(argv: string[], deps: SkillsDeps): Promise<number> {
  let code = EXIT_OK;
  const tracked: SkillsDeps = {
    ...deps,
    setExitCode: (c) => {
      code = c;
      deps.setExitCode(c);
    },
  };
  const program = new Command('omnikey').exitOverride(exitOverride).configureOutput({
    writeOut: (s) => deps.io.stdout(s),
    writeErr: (s) => deps.io.stderr(s),
  });
  registerSkillsCommand(program, tracked);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof SkillsExit) return err.exitCode;
    throw err;
  }
  return code;
}

// ── Production adapters ─────────────────────────────────────────────────────

function createInquirerPrompter(): Prompter {
  const load = async () => {
    const inquirer = (await import('inquirer')).default;
    // Prompts render on stderr so --json stdout stays clean.
    return inquirer.createPromptModule({ output: process.stderr });
  };
  return {
    async text(message, defaultValue) {
      const prompt = await load();
      const { value } = await prompt([
        { type: 'input', name: 'value', message, default: defaultValue },
      ]);
      return String(value ?? '');
    },
    async editor(message, defaultValue) {
      const prompt = await load();
      const { value } = await prompt([
        { type: 'editor', name: 'value', message, default: defaultValue },
      ]);
      return String(value ?? '');
    },
    async confirm(message, defaultValue) {
      const prompt = await load();
      const { value } = await prompt([
        { type: 'confirm', name: 'value', message, default: defaultValue },
      ]);
      return Boolean(value);
    },
  };
}

export function createProcessDeps(): SkillsDeps {
  return {
    io: {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
      stdin: process.stdin,
      interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      prompter: createInquirerPrompter,
    },
    transport: createDefaultTransport,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}
