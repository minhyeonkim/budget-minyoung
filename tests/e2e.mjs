// 에뮬레이터(가짜 서버) + 실제 index.html + 헤드리스 Chrome으로 동작 검증. 실제 Firebase 서버에는 접근하지 않음.
import puppeteer from "puppeteer-core";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_ = "http://localhost:5173/index.html?emulator";
const SHOTS = process.env.SHOTS;
const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const READONLY_RULES = RULES.replace(
  "match /budget_salaryProfiles/{docId} {\n      allow read, write: if isBudgetMember();",
  "match /budget_salaryProfiles/{docId} {\n      allow read: if isBudgetMember();\n      allow write: if false;"
);
if (READONLY_RULES === RULES) throw new Error("readonly rules patch failed");

let env = await initializeTestEnvironment({ projectId: "demo-budget", firestore: { rules: RULES, host: "127.0.0.1", port: 8080 } });
await env.clearFirestore();

// ---- 테스트 계정 ----
const nodeApp = initializeApp({ apiKey: "fake-key", projectId: "demo-budget" });
const nodeAuth = getAuth(nodeApp);
connectAuthEmulator(nodeAuth, "http://127.0.0.1:9099", { disableWarnings: true });
const member = (await createUserWithEmailAndPassword(nodeAuth, "member@example.com", "pass1234")).user;
const stranger = (await createUserWithEmailAndPassword(nodeAuth, "stranger@example.com", "pass1234")).user;

const admin = async (fn) => { let out; await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore()); }); return out; };
const read = (id) => admin(async (db) => { const s = await getDoc(doc(db, "budget_salaryProfiles", id)); return s.exists() ? s.data() : null; });

// ---- 테스트 데이터 (가짜) ----
await admin(async (db) => {
  await setDoc(doc(db, "budget_members", member.uid), { name: "테스트 민현" });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_fixed"), {
    fixedGiup: [{ id: "g1", name: "대출", day: 20, amount: 600000, enabled: true }],
    fixedNh: [{ id: "n1", name: "보험", day: 15, amount: 400000, enabled: true }],
    cardFixedKb: [{ id: "k1", name: "관리비", day: 25, amount: 200000, enabled: true }],
    cardFixedHyundai: []
  });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_installments"), {
    installments: [{ id: "i1", name: "자동차보험", monthlyAmount: 100000, totalInstallments: 10, anchorMonth: "2026-10", anchorInstallment: 10, enabled: true }]
  });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 4000000, cards: [{ id: "c1", name: "웰스", bank: "농협", amount: 0 }], fixedOverrides: {}, legacyField: "keep-me" });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-11"), { salary: 5000000, cards: [], fixedOverrides: {} });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-12"), { salary: 6000000, cards: [], fixedOverrides: {} });
  await setDoc(doc(db, "budget_salaryProfiles", "minyoung_fixed"), { fixedItems: [{ id: "m1", name: "적금", amount: 700000, bank: "하나", account: "", enabled: true }] });
  await setDoc(doc(db, "budget_salaryProfiles", "minyoung_2026-10"), { salary: 3000000, cards: [], fixedOverrides: {} });
  await setDoc(doc(db, "budget_salaryProfiles", "joint_fixed"), { livingItems: [{ id: "l1", name: "식비", amount: 750000, enabled: true }] });
});

// ---- 결과 기록 ----
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  → " + JSON.stringify(detail)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--window-size=1280,900"] });
const pageErrors = [];
async function newPage(width = 1280, height = 900, mobile = false) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", async (d) => {
    const h = page.__dialogHandler;
    page.__lastDialog = { type: d.type(), message: d.message() };
    if (h) await h(d); else await d.accept();
  });
  return page;
}
const st = (page) => page.evaluate(() => window.__budgetTest.state());
const txt = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const val = (page, sel) => page.$eval(sel, (el) => el.value);
async function waitReady(page, month) {
  await page.waitForFunction((m) => { const s = window.__budgetTest.state(); return s.ready && s.currentMonth === m && !s.saving; }, { timeout: 15000 }, month);
}
async function typeInto(page, sel, value) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(sel, value);
}
async function clickText(page, text) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.offsetParent !== null && x.textContent.trim() === t);
    if (b) { b.click(); return true; } return false;
  }, text);
  if (!ok) throw new Error("button not found: " + text);
}
const modalOpen = (page) => page.$eval("#modal-overlay", (el) => el.classList.contains("open"));
async function waitSaved(page) {
  await page.waitForFunction(() => { const s = window.__budgetTest.state(); return !s.saving; }, { timeout: 15000 });
  await sleep(300);
}

try {
  /* ===== 6. 권한: 로그인 전 / 미승인 계정 ===== */
  {
    const page = await newPage();
    await page.goto(URL_);
    await page.waitForFunction(() => window.__budgetTest && document.getElementById("login-btn").style.display !== "none", { timeout: 15000 });
    const shown = await page.evaluate(() => ({
      gate: getComputedStyle(document.getElementById("auth-gate")).display !== "none",
      app: getComputedStyle(document.getElementById("app-main")).display,
      body: document.body.innerText
    }));
    check("로그인 전: 로그인 화면만 보이고 앱(금융정보)은 숨김", shown.gate && shown.app === "none" && !/4,000,000|3,000,000/.test(shown.body), shown.app);
    await page.evaluate(() => window.__budgetTest.signIn("stranger@example.com", "pass1234"));
    await page.waitForFunction(() => document.getElementById("gate-uid").textContent.length > 0, { timeout: 15000 });
    const denied = await page.evaluate(() => ({
      title: document.getElementById("gate-title").textContent,
      uid: document.getElementById("gate-uid").textContent,
      app: getComputedStyle(document.getElementById("app-main")).display,
      ready: window.__budgetTest.state().authorized
    }));
    check("미승인 계정: '승인되지 않은 계정' 화면 + UID 표시, 앱 숨김, 구독 안 함", denied.title.includes("승인되지 않은") && denied.uid === stranger.uid && denied.app === "none" && !denied.ready, denied);
    await page.close();
  }

  const page = await newPage();
  await page.goto(URL_);
  await page.waitForFunction(() => window.__budgetTest, { timeout: 15000 });
  await page.evaluate(() => window.__budgetTest.signIn("member@example.com", "pass1234"));
  await waitReady(page, "2026-10");
  check("승인 계정: 로그인 후 데이터 표시", (await val(page, "#salary-amount")) === "4,000,000");

  /* ===== 계산 ===== */
  await clickText(page, "월급분석");
  check("월급 400만 − 현금 고정비 100만 − 카드 고정비 20만 − 할부 10만 = 생활비 270만",
    (await txt(page, "#af-stat-remaining")) === "2,700,000원" && (await txt(page, "#af-stat-cash")) === "1,000,000원" &&
    (await txt(page, "#af-stat-card")) === "200,000원" && (await txt(page, "#af-stat-inst")) === "100,000원",
    [await txt(page, "#af-stat-cash"), await txt(page, "#af-stat-card"), await txt(page, "#af-stat-inst"), await txt(page, "#af-stat-remaining")]);
  check("공동자산 민현 남는 생활비 = 월급분석 값", await page.$eval("#joint-stat-minhyun", (el) => el.textContent) === "2,700,000원");

  /* ===== 완료된 할부 ===== */
  await page.click("#month-next-btn");
  await waitReady(page, "2026-11");
  check("완료된 할부(10/10)가 다음 달 합계에서 제외됨", (await txt(page, "#af-stat-inst")) === "0원" && (await txt(page, "#installments-total")) === "0", await txt(page, "#af-stat-inst"));
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-10");

  /* ===== 월 이동 로딩 중 저장 불가 / 빠른 월 이동 ===== */
  const loading = await page.evaluate(() => {
    document.getElementById("month-next-btn").click();
    const s = window.__budgetTest.state();
    const saveBtn = document.getElementById("save-salary-btn");
    const area = document.getElementById("salary-work-area");
    // 로딩 중 편집 시도
    const inp = document.getElementById("salary-amount");
    inp.value = "9,999,999";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    saveBtn.click();
    const s2 = window.__budgetTest.state();
    return { ready: s.ready, saveDisabled: saveBtn.disabled, inert: area.inert, dirtyAfterEdit: s2.dirty, saving: s2.saving };
  });
  check("월 이동 직후(로딩 중): 저장 버튼 비활성·편집 영역 잠금·편집/저장 무시", !loading.ready && loading.saveDisabled && loading.inert && loading.dirtyAfterEdit.length === 0 && !loading.saving, loading);
  await waitReady(page, "2026-11");
  check("로딩 중 입력한 값이 저장·반영되지 않음", (await val(page, "#salary-amount")) === "5,000,000" && (await read("minhyun_2026-11")).salary === 5000000);

  await page.evaluate(() => {
    document.getElementById("month-next-btn").click(); // 12월
    document.getElementById("month-prev-btn").click(); // 11월
    document.getElementById("month-next-btn").click(); // 12월
    document.getElementById("month-prev-btn").click(); // 11월
    document.getElementById("month-prev-btn").click(); // 10월
  });
  await waitReady(page, "2026-10");
  await sleep(800);
  check("빠른 월 이동 후에도 마지막 달(10월) 데이터만 표시", (await val(page, "#salary-amount")) === "4,000,000" && (await txt(page, "#month-label")) === "2026년 10월" && (await txt(page, "#mh-stat-salary")) === "4,000,000원");

  // 입력 칸에 포커스가 남은 채(모바일에서 버튼을 눌러도 포커스가 안 옮겨지는 경우) 달 이동
  await page.focus("#salary-amount");
  await page.evaluate(() => document.getElementById("month-next-btn").click());
  await waitReady(page, "2026-11");
  await sleep(300);
  const focusedMove = { v: await val(page, "#salary-amount"), focused: await page.evaluate(() => document.activeElement.id) };
  check("포커스가 남은 칸도 달 이동 후 새 달 값으로 바뀜", focusedMove.v === "5,000,000", focusedMove);
  await page.evaluate(() => document.getElementById("month-prev-btn").click());
  await waitReady(page, "2026-10");
  await sleep(300);

  /* ===== 미저장 변경: 이동 취소 / 변경 취소 후 이동 / 저장 후 이동 ===== */
  await clickText(page, "월급분배");
  await typeInto(page, "#salary-amount", "4100000");
  let s = await st(page);
  const dot = await page.$eval('#person-tabs button[data-person="minhyun"]', (b) => b.classList.contains("dirty"));
  check("월급 수정 → 미저장 변경으로 표시(탭 점·상태)", s.dirty.includes("minhyun") && dot && (await txt(page, "#status")).includes("미저장"), { dirty: s.dirty, status: await txt(page, "#status") });

  await page.click("#month-next-btn");
  check("미저장 상태에서 달 이동 → 선택창 표시", await modalOpen(page));
  await clickText(page, "이동 취소");
  s = await st(page);
  check("이동 취소: 달 그대로, 입력값 유지", s.currentMonth === "2026-10" && (await val(page, "#salary-amount")) === "4,100,000" && s.dirty.includes("minhyun"));

  await page.click("#month-next-btn");
  await clickText(page, "변경 취소 후 이동");
  await waitReady(page, "2026-11");
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-10");
  check("변경 취소 후 이동: 변경 버려지고 서버 값 유지", (await val(page, "#salary-amount")) === "4,000,000" && (await read("minhyun_2026-10")).salary === 4000000 && (await st(page)).dirty.length === 0);

  // 저장 범위 선택창에서 취소 → 이동하지 않음
  await typeInto(page, "#fixed-giup-body input.money-input", "610000");
  await page.click("#month-next-btn");
  await clickText(page, "저장 후 이동");
  check("저장 후 이동 + 금액 변경 → 저장 범위 선택창", await modalOpen(page) && (await page.$eval("#modal-title", (e) => e.textContent)) === "변경사항 확인");
  await clickText(page, "취소");
  s = await st(page);
  check("범위 선택창에서 취소: 이동 안 함, 변경 유지", s.currentMonth === "2026-10" && s.pending.g1 && s.pending.g1.newAmount === 610000);

  /* ===== 이번 달만 / 전체 적용 ===== */
  await page.click("#save-salary-btn");
  await page.click('input[name="scope-g1"][value="month"]');
  await page.click("#confirm-save-apply");
  await waitSaved(page);
  let m10 = await read("minhyun_2026-10"), fx = await read("minhyun_fixed");
  check("이번 달만 적용: 10월 예외 금액만 저장, 기본값 유지", m10.fixedOverrides.g1 && m10.fixedOverrides.g1.amount === 610000 && fx.fixedGiup[0].amount === 600000, { ov: m10.fixedOverrides, base: fx.fixedGiup[0].amount });
  check("저장 시 다른 필드 보존(legacyField)", m10.legacyField === "keep-me");

  await typeInto(page, "#fixed-giup-body input.money-input", "620000");
  await page.click("#save-salary-btn");
  await page.click('input[name="scope-g1"][value="all"]');
  await page.click("#confirm-save-apply");
  await waitSaved(page);
  m10 = await read("minhyun_2026-10"); fx = await read("minhyun_fixed");
  check("전체 적용: 기본값 변경 + 기존 10월 금액 예외가 서버에서 제거됨", fx.fixedGiup[0].amount === 620000 && !(m10.fixedOverrides.g1 && "amount" in m10.fixedOverrides.g1), { ov: m10.fixedOverrides, base: fx.fixedGiup[0].amount });

  // 저장 후 이동
  await typeInto(page, "#salary-amount", "4200000");
  await page.click("#month-next-btn");
  await clickText(page, "저장 후 이동");
  await waitReady(page, "2026-11");
  check("저장 후 이동: 저장되고 다음 달로 이동", (await read("minhyun_2026-10")).salary === 4200000 && (await st(page)).currentMonth === "2026-11");
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-10");

  /* ===== 같은 항목의 여러 화면 동기화 ===== */
  await page.click("#fixed-giup-body input.money-input", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("#fixed-giup-body input.money-input", "630000");
  const sync = await page.evaluate(() => ({
    focused: document.activeElement && document.activeElement.dataset.focusKey,
    af: document.querySelector("#af-fixed-giup-body input.money-input").value,
    modal: document.querySelector("#modal-giup-body input.money-input").value,
    t1: document.getElementById("fixed-giup-total").textContent,
    t2: document.getElementById("af-fixed-giup-total").textContent,
    t3: document.getElementById("modal-giup-total").textContent,
    joint: document.getElementById("joint-stat-minhyun").textContent,
    an: document.getElementById("af-stat-remaining").textContent
  }));
  check("한 곳에서 금액 수정 → 월급분석·추가창 금액·합계 모두 일치, 입력 칸 포커스 유지",
    sync.af === "630,000" && sync.modal === "630,000" && sync.t1 === "630,000" && sync.t2 === "630,000" && sync.t3 === "630,000" && sync.focused === "fixed-giup-body|item|minhyun|fixedGiup|g1|amount", sync);
  check("관련 값 변경 → 공동 생활비도 함께 갱신", sync.joint === sync.an, sync);
  await page.click("#add-giup-btn-calc");
  const modalVals = await page.evaluate(() => ({ v: document.querySelector("#modal-body input.money-input").value, t: document.getElementById("modal-giup-total").textContent }));
  check("추가 창을 열면 같은 수정값(630,000)과 합계 표시", modalVals.v === "630,000" && modalVals.t === "630,000", modalVals);
  await page.click("#modal-close-btn");
  await typeInto(page, "#fixed-giup-body input.money-input", "620000");
  check("원래 금액으로 되돌리면 미저장 표시 해제", (await st(page)).dirty.length === 0);

  // 이름 입력 + 한글 조합 중 다시 그리기 보류
  await page.click("#fixed-giup-body input.name-input", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("#fixed-giup-body input.name-input", "주담대");
  const nameSync = await page.evaluate(() => ({ af: document.querySelector("#af-fixed-giup-body input.name-input").value, focused: document.activeElement.dataset.focusKey }));
  check("항목명 수정이 다른 화면에 반영되고 포커스 유지", nameSync.af === "주담대" && nameSync.focused.endsWith("|name"), nameSync);
  await page.evaluate(() => {
    window.__elBefore = document.activeElement;
    document.activeElement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await admin((db) => updateDoc(doc(db, "budget_salaryProfiles", "minyoung_2026-10"), { salary: 3100000 }));
  await sleep(1200);
  const ime = await page.evaluate(() => ({ same: document.activeElement === window.__elBefore, connected: window.__elBefore.isConnected, my: document.getElementById("joint-stat-minyoung").textContent }));
  await page.evaluate(() => document.activeElement.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await sleep(500);
  check("한글 조합 중 다른 기기 변경이 와도 입력 칸을 다시 만들지 않음(조합 끝난 뒤 반영)", ime.same && ime.connected && ime.my === "2,400,000원", ime);
  // 이름 원복
  await typeInto(page, "#fixed-giup-body input.name-input", "대출");
  check("이름 원복 후 미저장 없음", (await st(page)).dirty.length === 0, await st(page));

  /* ===== 저장 실패 ===== */
  await typeInto(page, "#salary-amount", "4300000");
  await env.cleanup();
  env = await initializeTestEnvironment({ projectId: "demo-budget", firestore: { rules: READONLY_RULES, host: "127.0.0.1", port: 8080 } });
  await page.click("#save-salary-btn");
  await page.waitForFunction(() => window.__budgetTest.state().stickyError, { timeout: 15000 });
  await sleep(3200);
  s = await st(page);
  const failStatus = await txt(page, "#status");
  check("저장 실패: 작성 중인 값 유지, 실패 메시지가 3초 뒤에도 유지", (await val(page, "#salary-amount")) === "4,300,000" && s.dirty.includes("minhyun") && failStatus.includes("저장 실패"), failStatus);
  await env.cleanup();
  env = await initializeTestEnvironment({ projectId: "demo-budget", firestore: { rules: RULES, host: "127.0.0.1", port: 8080 } });
  await page.click("#save-salary-btn");
  await waitSaved(page);
  check("규칙 복구 후 다시 저장 → 성공", (await read("minhyun_2026-10")).salary === 4300000 && (await st(page)).dirty.length === 0);

  /* ===== 다른 기기 변경과 충돌 ===== */
  const myBefore = await read("minyoung_2026-10");
  await typeInto(page, "#salary-amount", "4400000");
  await admin((db) => updateDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 9999999, "fixedOverrides.n1": { enabled: false } }));
  await page.waitForFunction(() => window.__budgetTest.state().conflict.minhyun, { timeout: 15000 });
  const banner = await page.$eval("#conflict-banner", (el) => getComputedStyle(el).display !== "none" && el.textContent);
  check("다른 기기 변경: 작성 중인 값 유지 + 충돌 안내 표시", (await val(page, "#salary-amount")) === "4,400,000" && banner && banner.includes("다른 기기"), banner);
  await clickText(page, "내 변경 유지");
  await page.click("#save-salary-btn");
  const cmpTitle = await page.$eval("#modal-title", (e) => e.textContent);
  const cmpBody = await page.$eval("#modal-body", (e) => e.textContent);
  check("내 변경 유지 후 저장 → 서버 값과 비교 화면", cmpTitle === "서버 값과 비교" && cmpBody.includes("9,999,999") && cmpBody.includes("4,400,000"), cmpBody.slice(0, 200));
  await page.click("#compare-apply");
  await waitSaved(page);
  m10 = await read("minhyun_2026-10");
  const myAfter = await read("minyoung_2026-10");
  check("비교 후 저장: 내가 바꾼 월급만 덮어쓰고, 다른 기기가 바꾼 체크 상태는 보존", m10.salary === 4400000 && m10.fixedOverrides.n1 && m10.fixedOverrides.n1.enabled === false, m10.fixedOverrides);
  check("다른 사람 문서(민영)는 건드리지 않음", JSON.stringify(myBefore) === JSON.stringify(myAfter));

  await typeInto(page, "#salary-amount", "4500000");
  await admin((db) => updateDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 7777777 }));
  await page.waitForFunction(() => window.__budgetTest.state().conflict.minhyun, { timeout: 15000 });
  page.__dialogHandler = (d) => d.accept();
  await clickText(page, "서버 값 불러오기");
  await sleep(300);
  check("서버 값 불러오기: 서버 값으로 교체, 미저장 해제", (await val(page, "#salary-amount")) === "7,777,777" && (await st(page)).dirty.length === 0);

  /* ===== 사람 탭 전환 시 미저장 보존 ===== */
  await typeInto(page, "#salary-amount", "4600000");
  await page.click('#person-tabs button[data-person="minyoung"]');
  await typeInto(page, "#salary-amount", "3200000");
  await page.click('#person-tabs button[data-person="minhyun"]');
  const keep = { mh: await val(page, "#salary-amount"), dirty: (await st(page)).dirty, note: await txt(page, "#dirty-note") };
  await page.click('#person-tabs button[data-person="minyoung"]');
  keep.my = await val(page, "#salary-amount");
  check("사람 탭을 바꿔도 각자 미저장 값 유지 + 누구 변경인지 표시", keep.mh === "4,600,000" && keep.my === "3,200,000" && keep.dirty.join() === "minhyun,minyoung" && keep.note.includes("민현") && keep.note.includes("민영"), keep);

  /* ===== 새로고침 경고 ===== */
  page.__dialogHandler = (d) => d.dismiss();
  page.__lastDialog = null;
  try { await page.reload({ timeout: 4000 }); } catch (_) {}
  check("미저장 상태에서 새로고침 → 경고(beforeunload)", page.__lastDialog && page.__lastDialog.type === "beforeunload", page.__lastDialog);
  page.__dialogHandler = null;

  /* ===== 자산: 대출 총 잔액 / 사용 가능 금액 / 검증 / 삭제 확인 ===== */
  await page.goto("about:blank");
  const p2 = await newPage();
  await p2.goto(URL_);
  await p2.waitForFunction(() => window.__budgetTest, { timeout: 15000 });
  await p2.evaluate(() => window.__budgetTest.signIn("member@example.com", "pass1234"));
  await waitReady(p2, "2026-10");
  await clickText(p2, "자산 현황");
  const countLoans = () => admin(async (db) => (await getDocs(collection(db, "budget_assets"))).size);
  await typeInto(p2, "#loan-name", "마이너스통장");
  await typeInto(p2, "#loan-limit", "30,000,000");
  await typeInto(p2, "#loan-used", "20,000,000");
  await p2.click("#add-loan-btn");
  await p2.waitForFunction(() => document.querySelectorAll("#loans-body tr").length === 1, { timeout: 10000 });
  check("대출 총 잔액 = 사용액 2,000만, 사용 가능 금액 = 1,000만",
    (await txt(p2, "#stat-loan-balance")) === "20,000,000원" && (await txt(p2, "#stat-loan-available")) === "10,000,000원" && (await txt(p2, "#stat-loan-limit")) === "30,000,000원",
    [await txt(p2, "#stat-loan-balance"), await txt(p2, "#stat-loan-available")]);
  const before = await countLoans();
  const invalid = [];
  for (const [limit, used] of [["30,000,000", "-5"], ["30,000,000", "1.5"], ["10,000,000", "20,000,000"], ["1,00", "0"]]) {
    await typeInto(p2, "#loan-name", "검증");
    await typeInto(p2, "#loan-limit", limit);
    await typeInto(p2, "#loan-used", used);
    await p2.click("#add-loan-btn");
    await sleep(200);
    invalid.push(await txt(p2, "#loan-error"));
  }
  check("음수·소수·한도 초과·잘못된 쉼표는 오류로 표시하고 저장 안 함",
    invalid[0].includes("음수") && invalid[1].includes("소수") && invalid[2].includes("한도") && invalid[3].includes("쉼표") && (await countLoans()) === before, invalid);
  p2.__dialogHandler = (d) => d.dismiss();
  await p2.click("#loans-body button.danger");
  await sleep(500);
  check("자산 삭제 확인창에서 취소 → 삭제 안 됨", (await countLoans()) === before && p2.__lastDialog && p2.__lastDialog.type === "confirm");
  p2.__dialogHandler = (d) => d.accept();
  await p2.click("#loans-body button.danger");
  await p2.waitForFunction(() => document.querySelectorAll("#loans-body tr").length === 0, { timeout: 10000 });
  check("확인 후 삭제 → 즉시 삭제", (await countLoans()) === before - 1);

  /* ===== 모바일 ===== */
  const mp = await newPage(390, 844, true);
  await mp.goto(URL_);
  await mp.waitForFunction(() => window.__budgetTest, { timeout: 15000 });
  await mp.evaluate(() => window.__budgetTest.signIn("member@example.com", "pass1234"));
  await waitReady(mp, "2026-10");
  const mobile = {};
  mobile.overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await mp.evaluate(() => window.scrollTo(0, 600));
  await sleep(300);
  mobile.saveBar = await mp.evaluate(() => {
    const b = document.getElementById("save-salary-btn").getBoundingClientRect();
    return b.bottom <= window.innerHeight && b.top >= 0;
  });
  if (SHOTS) await mp.screenshot({ path: SHOTS + "/mobile_main.png" });
  await typeInto(mp, "#fixed-giup-body input.money-input", "640000");
  mobile.tableInputWorks = (await st(mp)).dirty.includes("minhyun");
  mobile.saveClickable = await mp.evaluate(() => {
    const b = document.getElementById("save-salary-btn"); const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !b.disabled && (top === b || b.contains(top));
  });
  await mp.tap("#save-salary-btn");
  await sleep(300);
  mobile.modal = await mp.evaluate(() => {
    const box = document.querySelector(".modal-box").getBoundingClientRect();
    const btn = document.getElementById("confirm-save-apply").getBoundingClientRect();
    const radio = document.querySelector('input[name="scope-g1"][value="month"]').getBoundingClientRect();
    const scroller = document.querySelector("#modal-body .table-scroll");
    return box.left >= 0 && box.right <= window.innerWidth && btn.bottom <= window.innerHeight &&
      radio.right <= box.right && scroller.scrollWidth <= scroller.clientWidth;
  });
  if (SHOTS) await mp.screenshot({ path: SHOTS + "/mobile_modal.png" });
  await mp.tap('input[name="scope-g1"][value="month"]');
  await mp.tap("#confirm-save-apply");
  await waitSaved(mp);
  mobile.saved = (await read("minhyun_2026-10")).fixedOverrides.g1.amount === 640000;
  await mp.tap("#add-giup-btn-calc");
  await sleep(200);
  mobile.addModal = await mp.evaluate(() => {
    const box = document.querySelector(".modal-box").getBoundingClientRect();
    const close = document.getElementById("modal-close-btn").getBoundingClientRect();
    return box.right <= window.innerWidth && close.top >= 0 && close.right <= window.innerWidth;
  });
  if (SHOTS) await mp.screenshot({ path: SHOTS + "/mobile_add_modal.png" });
  check("모바일(390px): 가로 넘침 없음, 저장 버튼 하단 고정·탭 가능, 표 입력·모달 사용 가능", !mobile.overflow && mobile.saveBar && mobile.tableInputWorks && mobile.saveClickable && mobile.modal && mobile.saved && mobile.addModal, mobile);

  /* ===== 임시 익명 모드 (콘솔 설정 전 배포용, 현재 실제 서버와 같은 request.auth != null 규칙) ===== */
  const LEGACY_RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if request.auth != null;\n    }\n  }\n}\n";
  await env.cleanup();
  env = await initializeTestEnvironment({ projectId: "demo-budget", firestore: { rules: LEGACY_RULES, host: "127.0.0.1", port: 8080 } });
  const ap = await newPage();
  await ap.goto(URL_ + "&auth=anonymous");
  await ap.waitForFunction(() => window.__budgetTest && window.__budgetTest.state().ready, { timeout: 15000 });
  const anonView = { salary: await val(ap, "#salary-amount"), gate: await ap.$eval("#auth-gate", (e) => getComputedStyle(e).display) };
  await typeInto(ap, "#salary-amount", "4700000");
  await ap.click("#save-salary-btn");
  await waitSaved(ap);
  check("임시 익명 모드: 로그인 화면 없이 바로 열리고 기존 데이터 표시·저장 가능", anonView.gate === "none" && anonView.salary !== "" && (await read("minhyun_2026-10")).salary === 4700000, anonView);
  await ap.close();

  check("페이지 스크립트 오류 없음", pageErrors.length === 0, pageErrors);
} catch (e) {
  check("테스트 실행 중 예외", false, e.stack);
} finally {
  await browser.close();
  await env.cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`E2E ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
