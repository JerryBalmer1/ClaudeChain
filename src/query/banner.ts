import { RABBIT_HOLE_MESSAGE, type SelfReferenceMatch } from '../ingest/detector.js';

const RULE = '='.repeat(78);

/** The unmissable banner logged at info level when the chain finds itself. */
export function renderSelfReferenceBanner(match: SelfReferenceMatch): string {
  return [
    RULE,
    RULE,
    `    ${RABBIT_HOLE_MESSAGE}`,
    RULE,
    '    status   halted:self-reference',
    `    method   ${match.method}`,
    `    matched  ${match.matchedPath}`,
    `    self     ${match.selfFile}`,
    `    sha256   ${match.hash}`,
    RULE,
    RULE,
  ].join('\n');
}
