/** Turns a raw service failure ("Drive Tracker: POST /api/scheduled → HTTP 422 {json…}") into one readable sentence for people. */
export function plainError(raw: string, max = 280): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const field = (k: string) => text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1]?.replace(/\\"/g, '"');
  const status = text.match(/HTTP (\d{3})/)?.[1];
  const service = text.match(/^([^:]{2,40}):\s/)?.[1];
  const error = field('error'), hint = field('hint');
  if (error) {
    const body = [error.replace(/[.\s]+$/, ''), hint?.replace(/\s+/g, ' ')].filter(Boolean).join('. ');
    return `${service ? service + ' said: ' : ''}${body}`.slice(0, max).replace(/[\s,;—-]+$/, '');
  }
  if (status) return `${service ?? 'The service'} returned an error (HTTP ${status}).${status.startsWith('5') ? ' It may be a problem on their side; try again later.' : ''}`;
  return text.slice(0, max);
}
