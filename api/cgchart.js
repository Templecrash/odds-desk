// Same-origin proxy for one coin's daily price/volume history (CoinGecko), cached 6h at the edge.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^[a-z0-9-]{1,80}$/.test(id)) return new Response('bad id', { status: 400 });
  const upstream = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`, { headers: { accept: 'application/json' } });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': upstream.ok ? 's-maxage=21600, stale-while-revalidate=43200' : 'no-store' },
  });
}
