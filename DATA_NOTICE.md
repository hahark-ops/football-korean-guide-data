# 데이터 출처 표시

경기 데이터: nflverse (CC BY 4.0)

- nflverse: https://github.com/nflverse
- 일정과 결과: https://github.com/nflverse/nfldata
- 플레이 기록: https://github.com/nflverse/nflverse-data
- 라이선스 전문: https://creativecommons.org/licenses/by/4.0/

## 가공한 내용

이 저장소가 배포하는 JSON은 nflverse 데이터를 그대로 옮긴 것이 아니라 가공한 결과입니다.

- 일정, 점수, 경기 상태를 앱이 쓰는 형식으로 바꾸고 시각을 UTC로 맞췄습니다.
- 끝난 경기의 결과로 지구별 순위와 팀 성적을 계산했습니다.
- 플레이 기록의 구조화된 값(다운, 남은 거리, 필드 위치, 전진 야드, 득점 종류 등)으로 승부를 가른 장면을 고르고 한국어 해설을 새로 썼습니다.

## 넣지 않는 것

- 선수 이름과 영어 플레이 설명(`desc`)은 JSON에 들어 있지 않습니다. 이 부분은 NFL.com에서 온 내용이라 별도 권리 조건을 따르기 때문입니다.
- 승리 확률 같은 확률 값은 장면을 고르는 데만 쓰고 출력하지 않습니다.

NFL과 각 팀의 이름은 해당 권리자의 상표입니다. 이 저장소와 앱은 NFL이나 각 팀과 관계가 없습니다.
