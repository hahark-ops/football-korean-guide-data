import assert from 'node:assert/strict';
import test from 'node:test';
import { joinKo, josa } from '../../collector/korean.ts';

test('받침에 맞는 조사를 고른다', () => {
  assert.equal(josa('애틀랜타', '이/가'), '애틀랜타가');
  assert.equal(josa('휴스턴', '이/가'), '휴스턴이');
  assert.equal(josa('워싱턴', '을/를'), '워싱턴을');
  assert.equal(josa('뉴올리언스', '을/를'), '뉴올리언스를');
  assert.equal(josa('시애틀', '은/는'), '시애틀은');
  assert.equal(josa('LA 램스', '과/와'), 'LA 램스와');
  assert.equal(josa('연장전', '과/와'), '연장전과');
});

test('"으로/로"는 ㄹ 받침과 숫자 읽기를 따른다', () => {
  assert.equal(josa('필드골', '으로/로'), '필드골로');
  assert.equal(josa('인터셉션', '으로/로'), '인터셉션으로');
  assert.equal(josa('패스', '으로/로'), '패스로');
  assert.equal(josa('20-20', '으로/로'), '20-20으로');
  assert.equal(josa('21-21', '으로/로'), '21-21로');
  assert.equal(josa('3-3', '으로/로'), '3-3으로');
  assert.equal(josa('2-2', '으로/로'), '2-2로');
});

test('여러 항목을 "A, B와 C"로 잇는다', () => {
  assert.equal(joinKo(['1쿼터']), '1쿼터');
  assert.equal(joinKo(['2쿼터', '4쿼터']), '2쿼터와 4쿼터');
  assert.equal(joinKo(['1쿼터', '3쿼터', '연장전']), '1쿼터, 3쿼터와 연장전');
});
