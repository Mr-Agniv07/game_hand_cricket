// Mirrors client/src/api.ts — same endpoints, same error-shape handling, just
// backed by Node's built-in fetch instead of the browser's.
// Defaults to the production backend (the same one crickflick.netlify.app talks to)
// so a downloaded binary works out of the box; set CRIC_SERVER_URL to point at a
// local `pnpm --filter server run dev` instead.
export const SERVER_URL = process.env.CRIC_SERVER_URL || 'https://cric-flick.onrender.com';

export async function apiGet<T = any>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function apiPost<T = any>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function apiDelete<T = any>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
