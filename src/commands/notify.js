import { MktError } from '../errors.js';
import { notify } from '../notify.js';

// Internal scheduler bridge: let shell wrappers use the same configured sinks as CLI alerts.
// mkt notify <title> <body>
export default async function notifyCommand({ positionals }) {
  const [title, body, ...extra] = positionals;
  if (!title || !body || extra.length) {
    throw new MktError('usage', 'notify needs exactly a title and body.');
  }
  await notify(title, body);
  return 0;
}
