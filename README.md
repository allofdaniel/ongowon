# ongowon.com

온고원(ONGOWON) 브랜드 홈페이지 — 정적 사이트. main 브랜치에 커밋하면 Vercel이 자동 배포합니다 (1분 내외).

## 페이지
| 언어 | 파일 | 주소 |
|---|---|---|
| 한국어 | `index.html` | https://ongowon.com/ |
| English | `en/index.html` | https://ongowon.com/en/ |
| 日本語 | `ja/index.html` | https://ongowon.com/ja/ |
| 소원 민화 (한국어) | `wish/index.html` | https://ongowon.com/wish/ (탭 바로가기: `#quiz` `#test` `#joseon`) |

- 첫 방문자의 브라우저 언어가 일본어면 `/ja/`, 한국어가 아니면 `/en/` 으로 한 번 안내합니다. 이후에는 헤더의 KO · EN · JA 에서 고른 언어를 기억합니다.
- 문구를 고칠 때는 세 언어 파일을 각각 수정하세요. 스타일(CSS)도 파일마다 `<style>` 안에 들어 있습니다.

- 소원 민화는 원래 Claude 아티팩트 '온고 소원 민화'였던 페이지를 그대로 옮긴 것. 홈 메뉴·'그림으로 소원 빌기' 섹션·푸터에서 연결됨. 영어·일본어 홈에서는 '현재 한국어만 제공'으로 안내.

## 이미지 (`images/`)
- `sheep.jpg` 등 : 민화 원화 시안
- `p_*.jpg` : 담요 패키샷 목업 / `d_*.jpg` : 확대 디테일 (마우스 올리면 보임)
- `life_*.jpg` : 사용 장면 사진 (AI 생성, 온고원 민화를 참고 이미지로 사용)
- `met_books/met_carp/met_peony.jpg` : 메트로폴리탄 미술관 퍼블릭 도메인(CC0) 민화 원본 (소원 민화 퀴즈용)
- `hero.jpg`, `gift.jpg` : 합성 목업 / `og.jpg`, `og_wish.jpg` : 링크 공유 미리보기

이미지를 바꿀 때는 같은 파일명으로 덮어 올리면 됩니다.

## 출시 알림
현재 `mailto:ongowon.contact@gmail.com` 으로 동작합니다 (별도 서버 없음).

제품·사용 이미지는 개발 중인 디자인 시안이며 AI로 생성되었습니다.
