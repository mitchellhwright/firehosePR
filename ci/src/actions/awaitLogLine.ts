import { awaitLogLine, type LogMatch } from '../ios/shared/awaitLogLine.ts';

const arguments_ = process.argv.slice(2);
const literal = arguments_[0] === '-F';
if (literal) arguments_.shift();
const [logPath, pattern] = arguments_;
if (arguments_.length !== 2 || !logPath || pattern === undefined) {
  throw new Error('usage: awaitLogLine.ts [-F] LOG PATTERN');
}
const match: LogMatch = literal ? { kind: 'literal', text: pattern } : { kind: 'regex', pattern };
process.stdout.write(`${await awaitLogLine(logPath, match)}\n`);
