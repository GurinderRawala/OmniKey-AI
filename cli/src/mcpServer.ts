import axios from 'axios';
import inquirer from 'inquirer';
import { readConfig, getPort } from './utils';

type Transport = 'stdio' | 'http' | 'sse';

interface MCPServerDto {
  id: string;
  name: string;
  description?: string | null;
  transport: Transport;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
  isEnabled: boolean;
  lastConnectedAt?: string | null;
  lastError?: string | null;
}

async function getJwt(): Promise<string> {
  const config = readConfig();
  const port = getPort();
  const licenseKey = config.OMNIKEY_LICENSE_KEY || '';
  const baseUrl = `http://localhost:${port}`;
  const res = await axios.post(
    `${baseUrl}/api/subscription/activate`,
    { licenseKey },
    { timeout: 10_000 },
  );
  return (res.data as { token: string }).token;
}

function getBaseUrl(): string {
  return `http://localhost:${getPort()}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  let token: string;
  try {
    token = await getJwt();
  } catch (err: any) {
    throw new Error(
      `Authentication failed — make sure the OmniKey backend is running and your license key is configured.\nCause: ${err?.message ?? String(err)}`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

function parseLines(input: string): string[] {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseKeyValueLines(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(input)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

async function promptTransportFields(
  transport: Transport,
  defaults?: Partial<MCPServerDto>,
): Promise<{
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
}> {
  if (transport === 'stdio') {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'command',
        message: 'Command (executable path or name):',
        default: defaults?.command ?? '',
        validate: (v: string) => v.trim().length > 0 || 'Command is required for stdio transport',
      },
      {
        type: 'editor',
        name: 'args',
        message: 'Args (one per line):',
        default: (defaults?.args ?? []).join('\n'),
      },
      {
        type: 'editor',
        name: 'env',
        message: 'Environment variables (one KEY=VALUE per line):',
        default: formatKVForEditor(defaults?.env),
      },
    ]);
    return {
      command: (ans.command as string).trim(),
      args: parseLines(ans.args as string),
      env: parseKeyValueLines(ans.env as string),
      url: null,
      headers: {},
    };
  }

  const ans = await inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: `URL for ${transport} transport:`,
      default: defaults?.url ?? '',
      validate: (v: string) => v.trim().length > 0 || 'URL is required',
    },
    {
      type: 'editor',
      name: 'headers',
      message: 'Headers (one KEY=VALUE per line):',
      default: formatKVForEditor(defaults?.headers),
    },
  ]);
  return {
    url: (ans.url as string).trim(),
    headers: parseKeyValueLines(ans.headers as string),
    command: null,
    args: [],
    env: {},
  };
}

function formatKVForEditor(dict: Record<string, string> | undefined): string {
  if (!dict) return '';
  return Object.entries(dict)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export async function mcpAdd(): Promise<void> {
  const baseAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Name (unique, e.g. "github"):',
      validate: (v: string) => v.trim().length > 0 || 'Name is required',
    },
    {
      type: 'input',
      name: 'description',
      message: 'Description (optional):',
    },
    {
      type: 'list',
      name: 'transport',
      message: 'Transport:',
      choices: [
        { name: 'stdio (local process)', value: 'stdio' },
        { name: 'http', value: 'http' },
        { name: 'sse', value: 'sse' },
      ],
      default: 'stdio',
    },
    {
      type: 'confirm',
      name: 'isEnabled',
      message: 'Enabled?',
      default: true,
    },
  ]);

  const transportFields = await promptTransportFields(baseAnswers.transport as Transport);

  try {
    const headers = await authHeaders();
    const res = await axios.post<MCPServerDto>(
      `${getBaseUrl()}/api/mcp-servers`,
      {
        name: (baseAnswers.name as string).trim(),
        description: (baseAnswers.description as string).trim() || null,
        transport: baseAnswers.transport,
        isEnabled: baseAnswers.isEnabled,
        ...transportFields,
      },
      { headers, timeout: 15_000 },
    );
    console.log('\nMCP server created:');
    printServer(res.data);
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error creating MCP server: ${msg}`);
  }
}

export async function mcpList(): Promise<void> {
  try {
    const headers = await authHeaders();
    const res = await axios.get<{ servers: MCPServerDto[] }>(`${getBaseUrl()}/api/mcp-servers`, {
      headers,
      timeout: 10_000,
    });
    const { servers } = res.data;
    if (servers.length === 0) {
      console.log('No MCP servers installed.');
      return;
    }
    console.log('\nMCP Servers:');
    console.log('─'.repeat(90));
    console.log(
      padRight('ID', 28) +
        padRight('Name', 22) +
        padRight('Transport', 12) +
        padRight('Enabled', 10) +
        'Endpoint',
    );
    console.log('─'.repeat(90));
    for (const s of servers) {
      const endpoint = s.transport === 'stdio' ? (s.command ?? '—') : (s.url ?? '—');
      console.log(
        padRight(s.id.slice(0, 26), 28) +
          padRight(s.name.slice(0, 20), 22) +
          padRight(s.transport, 12) +
          padRight(s.isEnabled ? 'yes' : 'no', 10) +
          endpoint.slice(0, 40),
      );
    }
    console.log('─'.repeat(90));
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error fetching MCP servers: ${msg}`);
  }
}

async function pickServer(action: string): Promise<MCPServerDto | null> {
  const headers = await authHeaders();
  const res = await axios.get<{ servers: MCPServerDto[] }>(`${getBaseUrl()}/api/mcp-servers`, {
    headers,
    timeout: 10_000,
  });
  const { servers } = res.data;
  if (servers.length === 0) {
    console.log(`No MCP servers to ${action}.`);
    return null;
  }
  const { id } = await inquirer.prompt([
    {
      type: 'list',
      name: 'id',
      message: `Select an MCP server to ${action}:`,
      choices: servers.map((s) => ({
        name: `${s.name} [${s.transport}] ${s.isEnabled ? '✓' : '✗'}`,
        value: s.id,
      })),
    },
  ]);
  return servers.find((s) => s.id === id) ?? null;
}

export async function mcpRemove(): Promise<void> {
  try {
    const server = await pickServer('remove');
    if (!server) return;

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Delete MCP server "${server.name}"?`,
        default: false,
      },
    ]);
    if (!confirm) {
      console.log('Aborted.');
      return;
    }

    const headers = await authHeaders();
    await axios.delete(`${getBaseUrl()}/api/mcp-servers/${server.id}`, {
      headers,
      timeout: 10_000,
    });
    console.log('MCP server removed.');
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error removing MCP server: ${msg}`);
  }
}

export async function mcpToggle(id: string): Promise<void> {
  try {
    const headers = await authHeaders();
    const current = await axios.get<MCPServerDto>(`${getBaseUrl()}/api/mcp-servers/${id}`, {
      headers,
      timeout: 10_000,
    });
    const newState = !current.data.isEnabled;
    const res = await axios.patch<MCPServerDto>(
      `${getBaseUrl()}/api/mcp-servers/${id}`,
      { isEnabled: newState },
      { headers, timeout: 10_000 },
    );
    console.log(
      `MCP server ${res.data.name} is now ${res.data.isEnabled ? 'enabled' : 'disabled'}.`,
    );
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error toggling MCP server: ${msg}`);
  }
}

export async function mcpUpdate(id: string): Promise<void> {
  try {
    const headers = await authHeaders();
    const current = (
      await axios.get<MCPServerDto>(`${getBaseUrl()}/api/mcp-servers/${id}`, {
        headers,
        timeout: 10_000,
      })
    ).data;

    const baseAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Name:',
        default: current.name,
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:',
        default: current.description ?? '',
      },
      {
        type: 'list',
        name: 'transport',
        message: 'Transport:',
        choices: ['stdio', 'http', 'sse'],
        default: current.transport,
      },
      {
        type: 'confirm',
        name: 'isEnabled',
        message: 'Enabled?',
        default: current.isEnabled,
      },
    ]);

    const transportFields = await promptTransportFields(
      baseAnswers.transport as Transport,
      current,
    );

    const res = await axios.patch<MCPServerDto>(
      `${getBaseUrl()}/api/mcp-servers/${id}`,
      {
        name: (baseAnswers.name as string).trim(),
        description: (baseAnswers.description as string).trim() || null,
        transport: baseAnswers.transport,
        isEnabled: baseAnswers.isEnabled,
        ...transportFields,
      },
      { headers, timeout: 15_000 },
    );
    console.log('\nMCP server updated:');
    printServer(res.data);
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error updating MCP server: ${msg}`);
  }
}

function printServer(s: MCPServerDto): void {
  console.log(`  ID:        ${s.id}`);
  console.log(`  Name:      ${s.name}`);
  console.log(`  Transport: ${s.transport}`);
  console.log(`  Enabled:   ${s.isEnabled}`);
  if (s.transport === 'stdio') {
    console.log(`  Command:   ${s.command ?? '—'}`);
    if (s.args.length > 0) console.log(`  Args:      ${s.args.join(' ')}`);
  } else {
    console.log(`  URL:       ${s.url ?? '—'}`);
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}
