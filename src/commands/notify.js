import { MktError } from '../errors.js';
import { notify } from '../notify.js';

// Internal scheduler bridge: let shell wrappers use the same configured sinks as CLI alerts.
// Equals-form flags preserve arbitrary leading dashes in wrapper-provided text.
// mkt notify --title=<title> --body=<body>
export default async function notifyCommand({ positionals, flags }) {
  const title = flags.title, body = flags.body;
  if (positionals.length || typeof title !== 'string' || !title || typeof body !== 'string' || !body) {
    throw new MktError('usage', 'notify needs --title and --body.',
      'mkt notify --title=mkt-record --body="backup failed"');
  }
  await notify(title, body);
  return 0;
}
