"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const util_1 = __importDefault(require("util"));
const config_1 = require("./config");
exports.logger = winston_1.default.createLogger({
    level: config_1.config.logLevel,
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }), winston_1.default.format.printf((info) => {
        const { level, message, timestamp, metadata } = info;
        const isLocal = config_1.config.isLocal;
        let metaString = '';
        if (metadata &&
            (typeof metadata === 'object' ? Object.keys(metadata).length > 0 : true)) {
            if (isLocal) {
                metaString = `\n${util_1.default.inspect(metadata, { colors: true, depth: null, breakLength: 80 })}`;
            }
            else {
                metaString = ` ${JSON.stringify(metadata)}`;
            }
        }
        const base = `${timestamp} [${level}] ${message}`;
        return isLocal
            ? winston_1.default.format.colorize().colorize(level, `${base}${metaString}`)
            : `${base}${metaString}`;
    })),
    transports: [new winston_1.default.transports.Console()],
});
