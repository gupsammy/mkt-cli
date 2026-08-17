import { scan, REGIONS } from '../providers/tradingview.js';
import { printRows } from '../output.js';

const LABEL = {
  america: 'US stocks + ETFs', forex: 'FX pairs', crypto: 'crypto', futures: 'futures',
  bond: 'bonds', cfd: 'CFDs', coin: 'coins', economics2: 'global macro indicators', index: 'indices',
};

export default async function regions({ flags }) {
  const rows = await Promise.all(REGIONS.map(async (region) => {
    try { const { total } = await scan({ region, columns: ['name'], range: [0, 1] }); return { region, symbols: total, description: LABEL[region] || '' }; }
    catch { return { region, symbols: null, description: LABEL[region] || '' }; }
  }));
  rows.sort((a, b) => (b.symbols || 0) - (a.symbols || 0));
  printRows(rows, flags);
  return 0;
}
