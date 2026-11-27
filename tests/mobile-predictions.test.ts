import { join } from 'node:path';
import { Harness } from './harness';
import { registerMobilePredictionTests } from './mobile-prediction-tests';

const h = new Harness();
const deadline = setTimeout(() => {
  process.stderr.write('Mobile prediction tests exceeded 30 seconds\n');
  process.exit(1);
}, 30_000);

void (async () => {
  try {
    await registerMobilePredictionTests(h);
    process.exitCode = await h.finish(join(__dirname, 'mobile-predictions-result.json'), 'mobile-predictions');
  } finally {
    clearTimeout(deadline);
  }
})().catch(error => {
  clearTimeout(deadline);
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
  process.exit(1);
});
