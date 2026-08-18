// Spawned by record-staged-write.test.js to exercise writeSnapshotGz from a separate process
// (its own pid → its own staged tmp; killable mid-write). Not a test: the argv guard makes it a
// no-op if the runner's test-directory discovery ever executes it directly.
import { writeSnapshotGz } from '../../src/commands/record.js';

const [file, date, marker, count] = process.argv.slice(2);
if (!file) process.exit(0);

// 'endless' can never finish — the deterministic target for the SIGKILL-mid-write test. The pad
// keeps gzip busy so bytes are genuinely in flight when the parent kills us.
function* endless() {
  for (let i = 0; ; i++) yield { symbol: `S${i}`, marker, pad: 'x'.repeat(200) };
}
const rows = marker === 'endless'
  ? endless()
  : Array.from({ length: Number(count) }, (_, i) => ({ symbol: `S${i}`, marker }));

await writeSnapshotGz(file, date, rows);
process.stdout.write('done');
