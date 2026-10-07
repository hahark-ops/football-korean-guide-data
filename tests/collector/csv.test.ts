import assert from 'node:assert/strict';
import test from 'node:test';
import { cell, iterateSelectedColumns, parseCsv } from '../../collector/csv.ts';

test('따옴표 안의 쉼표, 겹따옴표, 줄바꿈을 한 칸으로 읽는다', () => {
  const text = 'a,b,c\n"x, y","say ""hi""","line1\nline2"\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['x, y', 'say "hi"', 'line1\nline2'],
  ]);
});

test('CRLF 줄끝, BOM, 마지막 줄바꿈 유무를 모두 처리한다', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r\n"1\r\n2",3'), [['a', 'b'], ['1\r\n2', '3']]);
  assert.deepEqual(parseCsv(''), []);
});

test('빈 칸과 끝의 빈 칸을 보존한다', () => {
  assert.deepEqual(parseCsv('a,,c\n,,\n"",x,'), [
    ['a', '', 'c'],
    ['', '', ''],
    ['', 'x', ''],
  ]);
});

test('닫히지 않은 따옴표는 조용히 넘기지 않고 오류로 알린다', () => {
  assert.throws(() => parseCsv('a\n"open'), /unterminated/);
  assert.throws(() => parseCsv('"a"b,c'), /unexpected character/);
});

test('NA와 빈 값은 null이 된다', () => {
  assert.equal(cell('NA'), null);
  assert.equal(cell(''), null);
  assert.equal(cell('  '), null);
  assert.equal(cell(undefined), null);
  assert.equal(cell('0'), '0');
  assert.equal(cell('NAN'), 'NAN');
});

test('지정한 열만 읽고 없는 열은 오류로 알린다', () => {
  const text = 'keep,secret,also\n1,hidden,NA\n\n2,"x, y",3\n';
  const rows = [...iterateSelectedColumns(text, ['keep', 'also'] as const)];
  assert.deepEqual(rows, [
    { keep: '1', also: null },
    { keep: '2', also: '3' },
  ]);
  for (const row of rows) assert.ok(!('secret' in row));
  assert.throws(() => [...iterateSelectedColumns(text, ['missing'] as const)], /missing column "missing"/);
});
