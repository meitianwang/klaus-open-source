import { expect, test } from 'bun:test';
import { findTextMatches } from './content-find';

test('literal Unicode search returns original text offsets and treats punctuation literally', () => {
  expect(findTextMatches('a😀b😀', '😀')).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  expect(findTextMatches('a+b A+B aab', 'a+b')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  expect(findTextMatches('a+b A+B', 'a+b', true)).toEqual([{ start: 0, end: 3 }]);
  expect(findTextMatches('anything', '')).toEqual([]);
});
