// Preloaded with `node --import` by alert-window.test.js: replaces fetch so a live alert runs against
// a canned scanner reply instead of TradingView. MKT_TEST_SCAN is the /scan JSON body to return;
// metainfo answers with the one field the tests filter on. Any other URL fails loudly, so a test can
// never reach the real network. Not a test: the runner's test-directory discovery may import it, and
// without MKT_TEST_SCAN it leaves fetch alone.
if (process.env.MKT_TEST_SCAN) {
  const json = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/scan')) return json(process.env.MKT_TEST_SCAN);
    if (u.endsWith('/metainfo')) return json(JSON.stringify({ fields: [{ n: 'RSI' }] }));
    throw new Error(`fake-scanner: unexpected fetch ${u}`);
  };
}
