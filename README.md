# 말랑 가계부

민현/민영 두 사람의 월급 자동 배분 계산과 공동 자산(대출/적금) 현황을 관리하는 개인용 웹앱입니다. (엑셀로 관리하던 `월급계산(신혼).xlsx`를 대체하는 1단계 버전)

## 구조

- `index.html` 파일 하나로 동작하는 정적 웹페이지입니다. 별도 서버/빌드 과정이 없습니다.
- Firebase 프로젝트: `calendar-minyoung` ([malang-calendar-personal](../malang-calendar-personal)과 동일 프로젝트를 공유하되, 컬렉션을 분리해서 사용)
- 로그인 화면은 없지만, 내부적으로 Firebase 익명 로그인을 한 번 하고 나서만 Firestore 읽기/쓰기가 허용됩니다.

## 기능

1. **월급분배** (민현/민영 둘 다, 각자 탭 안의 하위 탭) — 월급·신용카드 사용금액·고정비 항목을 입력하면 합계와 남는 생활비를 자동 계산.
   - 민현: 신용카드(웰스/현대, 농협 결제) + 기업/농협 고정금(이체일 포함)
   - 민영: 신용카드(현대카드/우리카드) + 고정비 항목(계좌번호/은행 포함, 어느 계좌로 넣어야 하는지 바로 보임)
2. **월급분석** (민현 전용) — 고정금(현금)/고정금(카드)/카드 할부까지 다 반영해서 남는 생활비를 예측. (민영은 추후 추가 예정)
3. **공동자산** (민현/민영 옆의 3번째 탭, 초안) — 민현·민영 각자의 "월급분배" 탭 남는 생활비를 그대로 더해서, 이번 달 둘이 합쳐 쓸 수 있는 생활비를 보여줌. 월급 입력칸/저장 버튼 없이 읽기 전용이고, 상단 월 이동(◀▶)에 따라 그 달 기준으로 다시 계산됨.
4. **자산 현황** — 대출(마이너스통장 등)의 한도/사용액/잔액, 적금 목록을 관리하고 총 대출 잔액·총 적금을 요약.

가계부(일별 거래 입력)는 아직 포함되어 있지 않습니다. 2단계에서 추가 예정입니다.

## Firestore 데이터 구조

고정금(기업/농협/KB카드/현대카드/민영 고정비)은 **"기본값(전역) + 달별 예외" 2단 구조**입니다. 금액이 바뀌면 보통 다음 달에도 계속 이어지는 성격이라, 매달 따로 관리하지 않고 하나의 기본값을 모든 달이 같이 보다가, 특정 달만 다르게 하고 싶을 때만 그 달에 예외를 얹는 방식입니다.

- `budget_salaryProfiles/{personId}_fixed` — 고정금 항목의 **기본값(전역, 월 구분 없음)**. `{ fixedGiup, fixedNh, cardFixedKb, cardFixedHyundai }` (`minyoung`은 `{ fixedItems }`, 각 항목에 `account`(계좌번호)/`bank`(은행명) 필드가 추가로 있음 — 어느 계좌로 넣어야 하는지 보려고). 각 항목은 `{id, name, day?, account?, bank?, amount, enabled}`. 항목명/이체일/계좌정보/추가/삭제/순서변경은 항상 이 전역 문서에 바로 반영됩니다.
- `cards`(신용카드 사용금액)는 민현/민영 둘 다 월별 문서 안에 있고 매달 0원으로 초기화됩니다. 민현은 `{id,name,bank,amount}`(이체 계산에 쓰임), 민영은 `{id,name,amount}`(계좌 구분 없이 단순 합산만).
- `budget_salaryProfiles/{personId}_{yyyy-mm}` — **달별 문서** (예: `minhyun_2026-09`). 화면 상단 "◀ 2026년 9월 ▶" 화살표로 이동. 여기엔 `salary`(월급), `cards`(민현의 신용카드 사용금액), `fixedOverrides`가 들어있음.
  - `salary`와 `cards`의 금액은 **달마다 0원으로 초기화**됩니다 (고정금과 달리 월급·카드 사용액은 매달 달라지는 값이라 이전 달 값을 이어받지 않음). 아직 방문/저장하지 않은 달은 항상 월급 0, 카드 금액 0으로 보입니다.
  - `fixedOverrides`: `{ [항목id]: { amount?, enabled? } }` — 이 달에서만 기본값과 다르게 쓰고 싶은 항목의 예외 값. 체크박스(enabled)는 항상 이 달만의 예외로 저장됨(다른 달에 영향 없음).
  - 금액을 수정하고 "저장"을 누르면, 바뀐 금액이 있는 항목마다 **"전체 적용"**(기본값 자체를 바꿔서 다른 모든 달에도 이어짐, 이 달의 예외가 있었다면 제거) 또는 **"이번 달만 적용"**(이 달의 `fixedOverrides`에만 저장, 기본값은 그대로) 중 선택하는 확인창이 뜸.
  - 화면에 보이는 실제 값 = 기본값에 `fixedOverrides` 있으면 덮어씌운 값.
  - (참고) 월별 분리 이전에 쓰던 `minhyun`/`minyoung` 문서, 그리고 고정금이 월별 문서에 그대로 들어있던 이전 버전의 필드들은 더 이상 앱에서 읽지 않는 예전 데이터입니다.
- `budget_salaryProfiles/minhyun_installments` — 카드 할부. 월과 무관한 별도 문서 `{ installments: [{id, name, monthlyAmount, totalInstallments, anchorMonth, anchorInstallment, enabled}] }`.
  - 표시되는 "현재 회차" = `anchorInstallment + (지금 보는 달 - anchorMonth)`. 예: `anchorMonth: "2026-09", anchorInstallment: 7`이면 10월엔 8/N, 8월엔 6/N으로 자동 표시됨.
  - "현재 회차" 칸을 직접 수정하면 그 순간 보고 있는 달이 새 `anchorMonth`가 되고 입력한 값이 새 `anchorInstallment`가 됨 — 마지막으로 수정한 달을 기준으로 앞뒤 달의 회차가 다시 계산됨.
  - 계산된 현재 회차가 `totalInstallments`를 넘어가면(할부 완료) 또는 1보다 작으면(아직 시작 전) 자동으로 합계 계산에서 제외됨.
- 항목명/금액 모두 각 행에서 바로 수정 가능, 금액은 입력 시 천단위 콤마 자동 반영. 화면에는 이미 등록된 항목 목록(체크박스/이체일/금액 수정/삭제)이 항상 보이고, "+ 추가" 버튼을 누르면 같은 목록 + 새 항목 입력폼이 별도 창(모달)으로 뜸 — 기업/농협/KB카드/현대카드/카드 할부/민영 고정비 전부 동일한 방식. 각 행 맨 앞 ⠿ 아이콘으로 드래그해서 순서 변경 가능.
- 계산: 기업은행 이체액 = fixedGiup(기본값+예외) 중 enabled 합계 + cards 중 bank=기업 합계 / 농협은행 이체액 = fixedNh(기본값+예외) 중 enabled 합계 + cards 중 bank=농협 합계 / 남는 생활비 = 월급 - 기업이체액 - 농협이체액
- 월급분석 탭의 "고정금(현금)" 표는 fixedGiup/fixedNh를 그대로 보여주는 거울(mirror)이라, 월급계산 탭과 월급분석 탭 어느 쪽에서 고쳐도 같은 데이터가 바뀜. 예측 계산: 남는 생활비 = 월급 - (fixedGiup+fixedNh 중 enabled 합계) - (cardFixedKb+cardFixedHyundai 중 enabled 합계) - (할부 중 진행중인 것 합계). 대출현황(마이너스통장)은 여기 포함 안 함 — "자산 현황" 탭에서 별도 관리.
- 실제 금액/항목명은 전부 Firestore에만 저장되어 있고, 코드/문서에는 포함하지 않습니다 (공개 저장소 배포 대비). `index.html`의 `defaultFixed`/`defaultInstallments`는 Firestore에 아직 아무것도 없을 때(최초 1회)만 쓰이는 빈 기본값입니다.
- `budget_assets/{autoId}`
  - 공통: `kind`(`loan` | `saving`), `owner`(`민현`|`민영`|`공동`), `name`, `createdAt`
  - `kind: loan`일 때: `limit`(한도), `used`(사용액) → 잔액은 클라이언트에서 `limit - used`로 계산
  - `kind: saving`일 때: `amount`(적금액)

## Firestore 보안 규칙 (추가 필요)

기존 `calendar-minyoung` 프로젝트 규칙에 아래 두 블록을 추가해야 합니다.

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eventId} {
      allow read, write: if request.auth != null;
    }
    match /budget_salaryProfiles/{personId} {
      allow read, write: if request.auth != null;
    }
    match /budget_assets/{assetId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## Firebase 설정값 위치

`index.html` 안의 `firebaseConfig` 객체에 있습니다.

## 배포 방법 (GitHub Pages)

1. 이 폴더를 개인 GitHub 저장소에 push 합니다.
2. 저장소 설정(Settings) → Pages → Source에서 `main` 브랜치, 루트(`/`) 선택 후 저장합니다.
3. 몇 분 후 `https://<깃허브아이디>.github.io/<저장소이름>/` 주소로 접속 가능합니다.

## 나중에 할 수 있는 것

- 일별 가계부 입력/카테고리별 예산-실적 대시보드 추가 (엑셀 `가계부` 시트 기능)
- 신용카드 실적 관리, 계좌별 자동이체 체크리스트
- 월별 변동 추이 차트
