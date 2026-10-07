# football-korean-guide-data

한국어 NFL 안내 앱(이름 미정)이 읽는 공개 경기 데이터를 만드는 저장소입니다. 앱 코드는 여기 없고, 데이터를 모으고 검증해서 GitHub Pages에 올리는 부분만 있습니다.

## 하는 일

- GitHub Actions의 `collect` 워크플로가 **매시 7분(UTC)** 에 돕니다. `main`에 수집기 코드가 바뀌어 올라오거나 Actions 탭에서 직접 실행해도 돕니다.
- 순서: 수집기 테스트 → nflverse 원본으로 정적 JSON 만들기(`collector/run.ts`) → 원본과 다시 대조하는 검증(`collector/verify.ts`) → GitHub Pages 배포.
- 테스트나 검증이 하나라도 실패하면 배포하지 않습니다. 이전에 배포된 데이터가 그대로 남습니다.
- 앞선 실행의 결과와 내려받은 원본은 Actions 캐시로 다음 실행에 넘깁니다. 바뀌지 않은 경기의 `updated_at`이 매시간 바뀌지 않게 하려는 것입니다.
- 3~8월에는 지난 시즌도 함께 내고, 9월부터는 새 시즌만 냅니다. 공개 범위에서 빠진 시즌의 폴더와 경기 요약 파일은 수집기가 지우므로, 캐시로 넘어온 이전 결과가 Pages에 남거나 검증을 막지 않습니다.

## 데이터 주소

```
https://<github-user>.github.io/football-korean-guide-data/
```

| 파일 | 내용 |
| --- | --- |
| `index.json` | 공개 중인 시즌 목록과 각 파일 경로 |
| `seasons/<시즌>/games.json` | 시즌 전체 일정과 결과 |
| `seasons/<시즌>/standings.json` | 지구별 순위와 팀 성적 |
| `seasons/<시즌>/concepts.json` | 용어별 실제 장면 예시 |
| `games/<경기 ID>.json` | 끝난 경기의 흐름 요약(승부를 가른 장면 3~5개와 한국어 해설) |

앱은 이 주소를 `VITE_DATA_BASE_URL`로 읽습니다. 끝에 `/`를 붙이지 않습니다.

## 출처와 라이선스

- 경기 데이터: [nflverse](https://github.com/nflverse) (CC BY 4.0). 데이터를 쓰는 곳에는 `경기 데이터: nflverse (CC BY 4.0)`을 표시합니다. 자세한 문구는 [DATA_NOTICE.md](DATA_NOTICE.md)에 있습니다.
- nflverse의 플레이 기록에는 NFL.com에서 온 내용(영어 플레이 설명, 선수 이름)이 섞여 있고 그 부분은 별도 권리 조건을 따릅니다. 그래서 이 저장소가 배포하는 JSON에는 **영어 플레이 설명과 선수 이름을 넣지 않습니다.** 한국어 해설은 다운, 남은 거리, 전진 야드 같은 구조화된 값으로 새로 만들고, 검증 단계가 원본 설명이나 선수 이름이 섞여 나가지 않았는지 매번 검사합니다.
- 승리 확률은 승부를 가른 장면을 고르는 데만 쓰고 출력하지 않습니다.

## 실시간 점수 지연 측정 (연구용)

- `live-probe` 워크플로가 일요일 낮·늦은 오후 경기와 일요일·월요일·목요일 밤 경기 시간에 balldontlie의 진행 중 점수를 20초 간격으로 조회합니다. 자세한 일정, 기록하지 못하는 경기, 목적은 [research/live/README.md](research/live/README.md)에 있습니다.
- 조회마다 받은 응답은 실행 안에서만 쓰고 저장소에 올리지 않습니다. 상태나 점수가 바뀐 것을 처음 본 시각과 더해진 점수만 뽑아 `main`이 아닌 **`probe-logs` 브랜치**의 `changes/<날짜>.jsonl`에 쌓습니다. 앱은 이 기록을 읽지 않습니다.
- API 키는 저장소 Secret `BALLDONTLIE_API_KEY`에만 둡니다. 키가 없으면 워크플로는 안내만 남기고 성공으로 끝납니다.

## 처음 한 번 설정

1. Settings → Pages → Build and deployment → Source를 **GitHub Actions**로 둡니다.
2. (측정을 시작할 때) Settings → Secrets and variables → Actions에 `BALLDONTLIE_API_KEY`를 추가합니다.
3. Actions 탭에서 `collect`를 Run workflow로 한 번 돌려 첫 배포를 확인합니다.

공개 저장소라 Actions 실행 시간과 Pages는 무료입니다. 저장소에 60일 동안 활동이 없으면 GitHub가 예약 실행을 멈출 수 있습니다. 그때는 Actions 탭에서 워크플로를 다시 켭니다.

## 원본 관리

이 저장소의 파일은 비공개 앱 저장소가 원본이고 동기화 스크립트가 복사해 넣습니다. 여기서 직접 고치면 다음 동기화 때 덮어써지므로 앱 저장소에서 고칩니다. 마지막 동기화의 원본 커밋과 시각, 복사된 파일 목록은 `SYNCED_FROM.txt`에 있습니다.

## 로컬에서 돌리기

Node 24가 필요하고 설치할 패키지는 없습니다.

```bash
npm run test:collector
npm run collect
npm run verify:data
```

결과는 `collector/out/`, 내려받은 원본은 `collector/.cache/`에 생기며 둘 다 커밋하지 않습니다.
