"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compressString = compressString;
exports.decompressString = decompressString;
const zlib_1 = __importDefault(require("zlib"));
const COMPRESSED_PREFIX = 'gz1:';
function compressString(value) {
    const buffer = Buffer.from(value, 'utf8');
    const compressed = zlib_1.default.gzipSync(buffer);
    return COMPRESSED_PREFIX + compressed.toString('base64');
}
function decompressString(value) {
    if (value == null)
        return null;
    if (!value.startsWith(COMPRESSED_PREFIX)) {
        // Backwards compatibility: treat as plain text.
        return value;
    }
    try {
        const b64 = value.slice(COMPRESSED_PREFIX.length);
        const compressed = Buffer.from(b64, 'base64');
        const decompressed = zlib_1.default.gunzipSync(compressed);
        return decompressed.toString('utf8');
    }
    catch {
        // If decompression fails, treat as missing instructions.
        return null;
    }
}
