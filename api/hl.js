// Same-origin proxy for the Hyperliquid API so the browser never hits CORS.
// POST /api/hl?net=mainnet|testnet&ep=info|exchange  (body forwarded as-is)
export const config = { runtime: 'edge' };

const HOSTS = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
};

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const url = new URL(req.url);
  const host = HOSTS[url.searchParams.get('net')];
  const ep = url.searchParams.get('ep');
  if (!host || !['info', 'exchange'].includes(ep)) return new Response('bad net or ep', { status: 400 });
  const upstream = await fetch(`${host}/${ep}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await req.text(),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
