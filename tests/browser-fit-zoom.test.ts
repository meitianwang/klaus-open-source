import { join } from 'node:path';
import { FIT_ZOOM_MIN, fitZoomForViewport } from '../main/browser/fit-zoom';
import { Harness, assertEqual } from './harness';

const h = new Harness();

h.test('a page that fits keeps its natural scale', () => {
  assertEqual(fitZoomForViewport(1400, 900), 1, 'narrower content is never enlarged');
  assertEqual(fitZoomForViewport(900, 900), 1, 'an exact fit stays at the natural scale');
});

h.test('overflowing content scales proportionally to the shown width', () => {
  assertEqual(fitZoomForViewport(900, 1800), 0.5, 'half the panel per document half');
  assertEqual(fitZoomForViewport(500, 1640), 500 / 1640, 'the capped panel over the intrinsic width');
});

h.test('unreadable scales floor and broken measurements no-op', () => {
  assertEqual(fitZoomForViewport(500, 4000), FIT_ZOOM_MIN, 'pathological widths keep the floor');
  assertEqual(fitZoomForViewport(0, 1200), 1, 'an unmeasured panel changes nothing');
  assertEqual(fitZoomForViewport(600, 0), 1, 'an unmeasured document changes nothing');
  assertEqual(fitZoomForViewport(600, Number.NaN), 1, 'a broken measurement changes nothing');
});

h.finish(join(__dirname, 'browser-fit-zoom-result.json'), 'browser-fit-zoom').then(code => process.exit(code));
