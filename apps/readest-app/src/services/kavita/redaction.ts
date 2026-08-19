const KOREADER_KEY_SEGMENT = /(\/api\/Koreader\/)([^/\s?#]+)(?=\/)/gi;
const API_KEY_QUERY = /([?&]apiKey=)[^&\s]+/gi;
const API_KEY_HEADER = /(x-api-key\s*[:=]\s*)[^\s,;]+/gi;

export function redactKavitaSecret(value: unknown, authKey?: string): string {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  text = text.replace(KOREADER_KEY_SEGMENT, '$1[REDACTED]');
  text = text.replace(API_KEY_QUERY, '$1[REDACTED]');
  text = text.replace(API_KEY_HEADER, '$1[REDACTED]');
  if (authKey) text = text.split(authKey).join('[REDACTED]');
  return text;
}
