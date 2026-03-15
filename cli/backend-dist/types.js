"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniKeyError = void 0;
class OmniKeyError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}
exports.OmniKeyError = OmniKeyError;
