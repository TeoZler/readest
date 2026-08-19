import { KavitaError } from './errors';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(IPV4_RE);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host);
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  );
}

export function normalizeKavitaBaseUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new KavitaError(
      'invalid-url',
      'Enter a complete Kavita URL including http:// or https://',
      undefined,
      {
        cause: error,
      },
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KavitaError('invalid-url', 'Kavita URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new KavitaError('invalid-url', 'Credentials must not be embedded in the Kavita URL');
  }
  if (url.search || url.hash) {
    throw new KavitaError('invalid-url', 'Kavita URL must not include a query string or fragment');
  }
  if (url.protocol === 'http:' && !isLocalOrPrivateHost(url.hostname)) {
    throw new KavitaError('insecure-public-http', 'Public Kavita servers must use HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
