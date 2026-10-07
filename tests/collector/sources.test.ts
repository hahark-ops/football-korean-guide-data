import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { SourceNotFoundError, cacheFileName, loadSourceText, playByPlayUrl } from '../../collector/sources.ts';

const URL_CSV = 'https://example.test/data/games.csv';
const URL_GZ = 'https://example.test/data/play_by_play_2026.csv.gz';

function fakeFetch(responses: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const respond = responses[url];
    if (!respond) throw new TypeError(`fetch failed: ${url}`);
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'collector-sources-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('캐시가 max-age보다 새로우면 네트워크를 다시 쓰지 않는다', () =>
  withTempDir(async (cacheDir) => {
    const { impl, calls } = fakeFetch({ [URL_CSV]: () => new Response('a,b\n1,2\n') });
    const options = { cacheDir, maxAgeMs: 30 * 60_000, offline: false, fetchImpl: impl };

    const first = await loadSourceText(URL_CSV, options);
    assert.equal(first.text, 'a,b\n1,2\n');
    assert.equal(first.fromCache, false);
    const second = await loadSourceText(URL_CSV, options);
    assert.equal(second.fromCache, true);
    assert.equal(second.text, first.text);
    assert.equal(calls.length, 1);

    const stale = await loadSourceText(URL_CSV, { ...options, now: () => Date.now() + 31 * 60_000 });
    assert.equal(stale.fromCache, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(await readdir(cacheDir), [cacheFileName(URL_CSV)]);
  }));

test('.gz 소스는 풀어서 돌려준다', () =>
  withTempDir(async (cacheDir) => {
    const { impl } = fakeFetch({ [URL_GZ]: () => new Response(gzipSync('play_id\n1\n')) });
    const result = await loadSourceText(URL_GZ, { cacheDir, maxAgeMs: 0, offline: false, fetchImpl: impl });
    assert.equal(result.text, 'play_id\n1\n');
    const cached = await loadSourceText(URL_GZ, { cacheDir, maxAgeMs: 0, offline: true });
    assert.equal(cached.text, 'play_id\n1\n');
  }));

test('--offline은 캐시만 쓰고, 캐시가 없으면 실패한다', () =>
  withTempDir(async (cacheDir) => {
    const { impl, calls } = fakeFetch({});
    await assert.rejects(
      loadSourceText(URL_CSV, { cacheDir, maxAgeMs: 0, offline: true, fetchImpl: impl }),
      /--offline: no cached copy/,
    );
    assert.equal(calls.length, 0);
  }));

test('404는 SourceNotFoundError, 네트워크 오류는 오래된 캐시로 대신한다', () =>
  withTempDir(async (cacheDir) => {
    const missing = fakeFetch({ [URL_GZ]: () => new Response('Not Found', { status: 404 }) });
    await assert.rejects(
      loadSourceText(URL_GZ, { cacheDir, maxAgeMs: 0, offline: false, fetchImpl: missing.impl }),
      SourceNotFoundError,
    );

    const ok = fakeFetch({ [URL_CSV]: () => new Response('x\n') });
    await loadSourceText(URL_CSV, { cacheDir, maxAgeMs: 0, offline: false, fetchImpl: ok.impl });
    const broken = fakeFetch({ [URL_CSV]: () => new Response('oops', { status: 500 }) });
    const logs: string[] = [];
    const fallback = await loadSourceText(URL_CSV, {
      cacheDir,
      maxAgeMs: 0,
      offline: false,
      fetchImpl: broken.impl,
      log: (message) => logs.push(message),
    });
    assert.equal(fallback.text, 'x\n');
    assert.equal(fallback.fromCache, true);
    assert.equal(logs.length, 1);
  }));

test('play-by-play 주소는 시즌별 nflverse 릴리스 파일이다', () => {
  assert.equal(
    playByPlayUrl(2026),
    'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.csv.gz',
  );
});
