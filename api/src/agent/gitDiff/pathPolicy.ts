/**
 * Sensitive-path policy shared by the diff pipeline. Pure string checks on an
 * already validated absolute path; never touches the filesystem.
 *
 * Mirrors the native GitSensitivePathPolicy (plus Git internals), and treats
 * any dot-prefixed component below a home directory (`~/.config/gh/hosts.yml`,
 * `~/work/.config/x`, `~/.zshrc`) as sensitive: tool configs and credentials
 * live there. Only the agent's own top-level `~/.omniAgent` / `~/.omnikey`
 * task directory component is exempt; deeper hidden components stay sensitive.
 */

const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.git']);
const SENSITIVE_NAMES = new Set(
  (
    'credentials credentials.json credentials.yml credentials.yaml .netrc _netrc .npmrc .pypirc ' +
    '.htpasswd .git-credentials secrets.json secrets.yml secrets.yaml known_hosts authorized_keys'
  ).split(' '),
);
const SENSITIVE_EXT = new Set('pem key p12 pfx keystore jks p8 ppk asc gpg kdbx'.split(' '));
/** The agent's own task directories: worktrees/scratch, not tool configs. */
const OWN_HIDDEN_HOME_DIRS = new Set(['.omniagent', '.omnikey']);

function hasHiddenHomeComponent(path: string): boolean {
  const home = /^\/(?:Users|home)\/[^/]+\//.exec(path);
  if (!home) return false;
  return path
    .slice(home[0].length)
    .split('/')
    .some(
      (part, index) =>
        part.startsWith('.') && !(index === 0 && OWN_HIDDEN_HOME_DIRS.has(part.toLowerCase())),
    );
}

/** True when `path` (absolute) names a credential/config/Git-internal file. */
export function isSensitivePath(path: string): boolean {
  if (hasHiddenHomeComponent(path)) return true;
  const parts = path.toLowerCase().split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((p) => SENSITIVE_DIRS.has(p))) return true;
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true;
  if (SENSITIVE_NAMES.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return true;
  if (name.startsWith('service-account') && name.endsWith('.json')) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SENSITIVE_EXT.has(name.slice(dot + 1));
}
