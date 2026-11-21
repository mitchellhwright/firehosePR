import { awaitLogLine } from '../ios/shared/awaitLogLine.js';
const arguments_ = process.argv.slice(2);
const literal = arguments_[0] === '-F';
if (literal)
    arguments_.shift();
const [logPath, pattern] = arguments_;
if (arguments_.length !== 2 || !logPath || pattern === undefined) {
    throw new Error('usage: awaitLogLine.ts [-F] LOG PATTERN');
}
const match = literal ? { kind: 'literal', text: pattern } : { kind: 'regex', pattern };
process.stdout.write(`${await awaitLogLine(logPath, match)}\n`);
