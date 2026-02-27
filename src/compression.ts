import zlib from 'zlib';

const COMPRESSED_PREFIX = 'gz1:';

export function compressString(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  const compressed = zlib.gzipSync(buffer);
  return COMPRESSED_PREFIX + compressed.toString('base64');
}

export function decompressString(value: string | null | undefined): string | null {
  if (value == null) return null;

  if (!value.startsWith(COMPRESSED_PREFIX)) {
    // Backwards compatibility: treat as plain text.
    return value;
  }

  try {
    const b64 = value.slice(COMPRESSED_PREFIX.length);
    const compressed = Buffer.from(b64, 'base64');
    const decompressed = zlib.gunzipSync(compressed);
    return decompressed.toString('utf8');
  } catch {
    // If decompression fails, treat as missing instructions.
    return null;
  }
}
