import { appendFileSync } from 'node:fs';
/**
 * The single-line form. GitHub splits on the first `=`, so a value that
 * contains a newline would be read as further keys; `renderMultilineOutput`
 * is the form for those.
 */
export function renderStepOutputs(entries) {
    let rendered = '';
    for (const [name, value] of entries) {
        if (value.includes('\n')) {
            throw new Error(`Step output ${name} contains a newline; use the multi-line delimiter form`);
        }
        rendered += `${name}=${value}\n`;
    }
    return rendered;
}
/**
 * The heredoc form: `name<<DELIMITER`, the value, then the delimiter alone on
 * its own line. A value carrying the delimiter as a whole line would end the
 * block early and leak the rest into the file as further keys, so that is
 * rejected rather than written.
 */
export function renderMultilineOutput(name, value, delimiter) {
    if (value.split('\n').includes(delimiter)) {
        throw new Error(`Step output ${name} contains its own ${delimiter} delimiter on a line`);
    }
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}
function appendTo(variable, contents) {
    const path = process.env[variable];
    if (path === undefined || path.length === 0)
        throw new Error(`${variable} is required`);
    appendFileSync(path, contents, 'utf8');
}
export function appendStepOutputs(entries) {
    appendTo('GITHUB_OUTPUT', renderStepOutputs(entries));
}
export function appendMultilineStepOutput(name, value, delimiter) {
    appendTo('GITHUB_OUTPUT', renderMultilineOutput(name, value, delimiter));
}
export function appendJobEnvironment(entries) {
    appendTo('GITHUB_ENV', renderStepOutputs(entries));
}
