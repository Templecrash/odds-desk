// Same-origin proxy for the CoinGecko top-100 markets call (cached 60s at the edge).
export const config = { runtime: 'edge' };

export default async function handler() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h,7d,30d';
  const upstream = await fetch(url, { headers: { accept: 'application/json' } });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=60, stale-while-revalidate=120' },
  });
}
