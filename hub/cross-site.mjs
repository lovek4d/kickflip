// Whether a browser sent this request from another site's page. A browser that sends no Sec-Fetch-Site still sends
// Origin on a cross-origin POST; clients outside a browser send neither, and pass.
export function crossSite(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  if (!headers.origin) return false;
  let origin;
  try { origin = new URL(headers.origin).host; } catch { return true; }
  return origin.toLowerCase() !== String(headers['x-forwarded-host'] || headers.host || '').toLowerCase();
}

export const isJSON = (headers) => (headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';
