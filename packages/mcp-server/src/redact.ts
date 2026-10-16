// Secrets never reach logs or error messages: every line the bridge writes
// passes through a redactor that knows the configured tokens.
export const REDACTED = '[REDACTED]';

export type Redactor = (text: string) => string;

export function createRedactor(secrets: Array<string | undefined>): Redactor {
  const known = [...new Set(secrets.filter((secret): secret is string => !!secret && secret.length >= 4))]
    .sort((a, b) => b.length - a.length);
  return text => {
    let out = text;
    for (const secret of known) out = out.split(secret).join(REDACTED);
    // Belt and braces: any bearer credential or URL userinfo that slipped in.
    return out
      .replace(/(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${REDACTED}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`);
  };
}
