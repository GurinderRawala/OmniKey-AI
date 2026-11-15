// TypeScript's CommonJS transform rewrites import() to require(), but Inquirer
// is ESM-only. Preserve a native dynamic import for Node 22.0–22.11 as well.
const importInquirer = new Function('return import("inquirer")') as () => Promise<
  typeof import('inquirer')
>;
let loading: ReturnType<typeof importInquirer> | undefined;

export async function loadInquirer(): Promise<(typeof import('inquirer'))['default']> {
  loading ??= importInquirer();
  return (await loading).default;
}
