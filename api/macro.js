// Same-origin proxy for live macro markets: S&P 500 futures, US dollar index, 10-year Treasury yield.
export const config = { runtime: 'edge' };
const SYMBOLS = { es: 'ES=F', dxy: 'DX-Y.NYB', tnx: '^TNX' };

async function chart(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (OddsDesk)', accept: 'application/json' } });
  if (!r.ok) throw new Error(sym + ' ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const closes = (res?.indicators?.quote?.[0]?.close || []).filter(x => x != null);
  const last = res?.meta?.regularMarketPrice ?? closes[closes.length - 1];
  if (!closes.length || last == null) throw new Error(sym + ' no data');
  const prev = closes.length >= 2 ? closes[closes.length - 2] : closes[0];
  const five = closes.length >= 6 ? closes[closes.length - 6] : closes[0];
  return { last, d1: last / prev - 1, d5: last / five - 1, d5abs: last - five };
}

export default async function handler() {
  const out = { at: Date.now() };
  await Promise.all(Object.entries(SYMBOLS).map(async ([k, sym]) => {
    try { out[k] = await chart(sym); } catch (e) { out[k] = { error: String(e.message || e) }; }
  }));
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 's-maxage=300, stale-while-revalidate=900' } });
}
