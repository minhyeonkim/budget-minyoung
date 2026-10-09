// 에뮬레이터(가짜 서버) + 실제 index.html + 헤드리스 Chrome으로 동작 검증. 실제 Firebase 서버에는 접근하지 않음.
import puppeteer from "puppeteer-core";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from "firebase/firestore";
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:5173/index.html?emulator";
const URL_ = BASE + "#edit";
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
const SHARED_PW = "Test-Shared-Pass-2026!";
const shared = (await createUserWithEmailAndPassword(nodeAuth, "family@budget-minyoung.invalid", SHARED_PW)).user;

const admin = async (fn) => { let out; await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore()); }); return out; };
const read = (id) => admin(async (db) => { const s = await getDoc(doc(db, "budget_salaryProfiles", id)); return s.exists() ? s.data() : null; });

// ---- 테스트 데이터 (가짜) ----
await admin(async (db) => {
  await setDoc(doc(db, "budget_members", member.uid), { name: "테스트 민현" });
  await setDoc(doc(db, "budget_members", shared.uid), { name: "공용" });
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
  await setDoc(doc(db, "budget_salaryProfiles", "minyoung_fixed"), {
    fixedItems: [{ id: "m1", name: "적금", amount: 700000, bank: "하나", account: "", enabled: true }],
    cardFixedWoori: [{ id: "w1", name: "코수술", amount: 550000, enabled: true }, { id: "w2", name: "기타(당월 사용금액)", amount: 0, enabled: true, auto: true }],
    cardFixedHyundai: []
  });
  await setDoc(doc(db, "budget_salaryProfiles", "minyoung_2026-10"), { salary: 3000000, cards: [{ id: "mc1", name: "신용카드(현대카드)", amount: 0 }, { id: "mc2", name: "신용카드(우리카드)", amount: 0 }], fixedOverrides: {} });
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
  check("월급 400만 − 현금 고정비 100만 − 카드(KB 고정비 20만 + 현대카드 할부 10만) = 생활비 270만",
    (await txt(page, "#af-stat-remaining")) === "2,700,000원" && (await txt(page, "#af-stat-cash")) === "1,000,000원" &&
    (await txt(page, "#af-stat-card")) === "300,000원" && (await txt(page, "#af-stat-inst")) === "100,000원" &&
    (await txt(page, '#af-card-hyundai [data-sum-card]')) === "100,000" && (await page.$eval("#card-fixed-hyundai-body-inst", (e) => e.querySelectorAll("tr").length)) === 1,
    [await txt(page, "#af-stat-cash"), await txt(page, "#af-stat-card"), await txt(page, "#af-stat-inst"), await txt(page, "#af-stat-remaining")]);
  check("공동자산 민현 남는 생활비 = 월급분석 값", await page.$eval("#joint-stat-minhyun", (el) => el.textContent) === "2,700,000원");

  /* ===== 완료된 할부 ===== */
  await page.click("#month-next-btn");
  await waitReady(page, "2026-11");
  check("완료된 할부(10/10)가 다음 달 합계에서 제외됨", (await txt(page, "#af-stat-inst")) === "0원" && (await txt(page, '#af-card-hyundai [data-sum-inst]')) === "0", await txt(page, "#af-stat-inst"));
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

  /* ===== 전월 / 현재월 버튼 (오늘 한국 시간 기준) ===== */
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-09");
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-08");
  await page.click("#month-prevmonth-btn");
  await waitReady(page, "2026-09");
  const quick1 = { month: (await st(page)).currentMonth, prevOn: await page.$eval("#month-prevmonth-btn", (e) => e.classList.contains("current")) };
  await page.click("#month-next-btn");
  await waitReady(page, "2026-10");
  await page.click("#month-next-btn");
  await waitReady(page, "2026-11");
  await page.click("#month-prevmonth-btn");
  await waitReady(page, "2026-09");
  await page.click("#month-thismonth-btn");
  await waitReady(page, "2026-10");
  const quick2 = { month: (await st(page)).currentMonth, curOn: await page.$eval("#month-thismonth-btn", (e) => e.classList.contains("current")), salary: await val(page, "#salary-amount") };
  check("전월/현재월: 보고 있는 달과 상관없이 오늘(10월) 기준으로 9월/10월로 이동 + 표시",
    quick1.month === "2026-09" && quick1.prevOn && quick2.month === "2026-10" && quick2.curOn && quick2.salary === "4,000,000", { quick1, quick2 });

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

  /* ===== 체크(합계 포함) 변경도 전체 적용 / 이번 달만 선택 ===== */
  const clickKb = () => page.evaluate(() => document.querySelector('#card-fixed-kb-body tr[data-row$="|k1"] td.check-cell input').click());
  await clickKb();
  await page.click("#save-salary-btn");
  const enRow = await page.$('input[name="scope-en-k1"][value="all"]');
  await page.click('input[name="scope-en-k1"][value="all"]');
  await page.click("#confirm-save-apply");
  await waitSaved(page);
  let fxK = await read("minhyun_fixed"), m10k = await read("minhyun_2026-10");
  const enAll = { modalRow: !!enRow, globalEnabled: fxK.cardFixedKb[0].enabled, ov: m10k.fixedOverrides.k1 };
  await clickKb();
  await page.click("#save-salary-btn");
  await page.click('input[name="scope-en-k1"][value="month"]');
  await page.click("#confirm-save-apply");
  await waitSaved(page);
  fxK = await read("minhyun_fixed"); m10k = await read("minhyun_2026-10");
  const enMonth = { globalEnabled: fxK.cardFixedKb[0].enabled, ov: m10k.fixedOverrides.k1 };
  check("체크 해제 + 전체 적용 → 기본값이 바뀌어 다음 달에도 해제 / 다시 체크 + 이번 달만 → 이 달만 체크",
    enAll.modalRow && enAll.globalEnabled === false && !(enAll.ov && "enabled" in enAll.ov) &&
    enMonth.globalEnabled === false && enMonth.ov && enMonth.ov.enabled === true, { enAll, enMonth });

  // 저장 후 이동
  await typeInto(page, "#salary-amount", "4200000");
  await page.click("#month-next-btn");
  await clickText(page, "저장 후 이동");
  await waitReady(page, "2026-11");
  check("저장 후 이동: 저장되고 다음 달로 이동", (await read("minhyun_2026-10")).salary === 4200000 && (await st(page)).currentMonth === "2026-11");
  await page.click("#month-prev-btn");
  await waitReady(page, "2026-10");

  /* ===== 현대카드 고정금 '자동' (월급분배 현대카드 금액 − 나머지 현대카드 고정금) ===== */
  await admin(async (db) => {
    await updateDoc(doc(db, "budget_salaryProfiles", "minhyun_fixed"), {
      cardFixedHyundai: [{ id: "h1", name: "유튜브", amount: 14900, enabled: true }, { id: "h2", name: "기타(당월 사용금액)", amount: 0, enabled: true }]
    });
    await updateDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-10"), {
      cards: [{ id: "c1", name: "웰스", bank: "농협", amount: 0 }, { id: "c2", name: "신용카드(현대)", bank: "농협", amount: 0 }]
    });
  });
  await page.waitForFunction(() => document.querySelector('[data-bind="card|minhyun||c2|amount"]') && document.querySelector('#card-fixed-hyundai-body tr[data-row$="|h2"]'), { timeout: 15000 });
  await typeInto(page, '#cards-quick-entry [data-bind="card|minhyun||c2|amount"]', "300000");
  await clickText(page, "월급분석");
  await page.click('#card-fixed-hyundai-body tr[data-row$="|h2"] input.auto-check');
  const autoAmt = (sel) => page.$eval('#' + sel + ' tr[data-row$="|h2"] input.money-input', (e) => ({ v: e.value, ro: e.readOnly }));
  const auto1 = { main: await autoAmt("card-fixed-hyundai-body"), modal: await autoAmt("modal-hyundai-body"), total: await txt(page, "#card-fixed-hyundai-total"), sum: await txt(page, "#af-card-hyundai [data-sum-card]") };
  await clickText(page, "월급분배");
  await typeInto(page, '#cards-quick-entry [data-bind="card|minhyun||c2|amount"]', "400000");
  await clickText(page, "월급분석");
  const auto2 = { main: await autoAmt("card-fixed-hyundai-body"), total: await txt(page, "#card-fixed-hyundai-total"), sum: await txt(page, "#af-card-hyundai [data-sum-card]") };
  await page.click('#card-fixed-hyundai-body tr[data-row$="|h1"] input[type="checkbox"]');
  const auto3 = await autoAmt("card-fixed-hyundai-body");
  await page.click('#card-fixed-hyundai-body tr[data-row$="|h1"] input[type="checkbox"]');
  await page.click('#card-fixed-hyundai-body tr[data-row$="|h2"] input.auto-check');
  const autoOff = await autoAmt("card-fixed-hyundai-body");
  await page.click('#card-fixed-hyundai-body tr[data-row$="|h2"] input.auto-check');
  await page.click("#save-salary-btn");
  await waitSaved(page);
  const fxH = (await read("minhyun_fixed")).cardFixedHyundai;
  const onlyEtc = await page.evaluate(() => ({
    h1: !!document.querySelector('#card-fixed-hyundai-body tr[data-row$="|h1"] input.auto-check'),
    h2: !!document.querySelector('#card-fixed-hyundai-body tr[data-row$="|h2"] input.auto-check'),
    kb: !!document.querySelector('#card-fixed-kb-body input.auto-check')
  }));
  check("자동 체크는 '기타' 줄에만 있고 다른 줄·다른 카드에는 없음", !onlyEtc.h1 && onlyEtc.h2 && !onlyEtc.kb, onlyEtc);
  // 자동 차액이 모든 합계에 반영되는지: 현대카드 합계 = 사용금액, 고정금(카드) 합계, 남는 생활비, 공동자산
  const flow = await page.evaluate(() => {
    const n = (el) => Number(el.textContent.replace(/[^\d-]/g, ""));
    const id = (x) => n(document.getElementById(x));
    return { hy: n(document.querySelector("#af-card-hyundai [data-sum-card]")), kb: n(document.querySelector("#af-card-kb [data-sum-card]")), card: id("af-stat-card"), sal: id("af-stat-salary"), cash: id("af-stat-cash"), rem: id("af-stat-remaining"), joint: id("joint-stat-minhyun") };
  });
  check("자동 차액·할부가 현대카드 합계·고정금(카드) 합계·남는 생활비·공동자산까지 반영 (할부 이중 차감 없음)",
    flow.hy === 400000 && flow.card === flow.kb + flow.hy && flow.rem === flow.sal - flow.cash - flow.card && flow.joint === flow.rem, flow);
  check("현대카드 자동: 사용금액 − 나머지 고정금 − 현대카드 할부, 사용금액 바뀌면 즉시 갱신, 카드 합계 = 사용금액, 해제 시 직접 입력, 저장 유지",
    auto1.main.v === "185,100" && auto1.main.ro && auto1.modal.v === "185,100" && auto1.total === "200,000" && auto1.sum === "300,000" &&
    auto2.main.v === "285,100" && auto2.total === "300,000" && auto2.sum === "400,000" && auto3.v === "300,000" &&
    autoOff.v === "" && !autoOff.ro &&
    fxH[1].auto === true && (await read("minhyun_2026-10")).cards[1].amount === 400000 && (await st(page)).dirty.length === 0,
    { auto1, auto2, auto3, autoOff, fxH });
  await clickText(page, "월급분배");

  /* ===== 민영: 월급분배는 예전 표 그대로, 월급분석에 은행별 고정금(현금) + 우리/현대 카드(자동·할부) ===== */
  await page.click('#person-tabs button[data-person="minyoung"]');
  await page.$eval('#minyoung-section-tabs button[data-section="calc"]', (b) => b.click());
  const calcLayout = await page.evaluate(() => ({
    table: document.querySelectorAll("#fixed-items-body tr").length,
    heading: [...document.querySelectorAll("#minyoung-calc-section h2")].map((h) => h.textContent).join("|"),
    cardSections: document.querySelectorAll("#minyoung-calc-section .card-section").length
  }));
  await typeInto(page, '#my-cards-quick-entry [data-bind="card|minyoung||mc2|amount"]', "1000000");
  await page.$eval('#minyoung-section-tabs button[data-section="analysis"]', (b) => b.click());
  const myAuto1 = await page.evaluate(() => ({
    groups: [...document.querySelectorAll("#my-cash-groups h2")].map((h) => h.textContent),
    groupAccount: !!document.querySelector("#my-cash-groups .account-input"),
    sections: [...document.querySelectorAll("#minyoung-analysis-section .card-section h2")].map((h) => h.textContent),
    w2: document.querySelector('#my-card-fixed-woori-body tr[data-row$="|w2"] input.money-input').value,
    autoChecks: [...document.querySelectorAll("#my-card-fixed-woori-body input.auto-check")].length
  }));
  await page.evaluate(() => document.querySelector('#my-card-woori [data-add-inst]').click());
  await typeInto(page, "#inst-new-name", "피부렌탈");
  await typeInto(page, "#inst-new-amount", "130000");
  await typeInto(page, "#inst-new-current", "1");
  await typeInto(page, "#inst-new-total", "12");
  await page.click("#inst-new-add");
  const myAuto2 = await page.evaluate(() => ({
    w2: document.querySelector('#my-card-fixed-woori-body tr[data-row$="|w2"] input.money-input').value,
    instRows: document.querySelectorAll("#my-card-fixed-woori-body-inst tr").length,
    sum: document.querySelector("#my-card-woori [data-sum-card]").textContent,
    analysisCard: document.getElementById("myaf-stat-card").textContent
  }));
  await page.click("#save-salary-btn");
  await waitSaved(page);
  const myInst = await read("minyoung_installments");
  check("민영: 월급분배는 예전 단일 표 그대로 / 월급분석에 은행별 고정금(현금)+우리카드(코수술+자동 기타)+할부, 카드 합계=사용금액, 저장",
    calcLayout.table === 1 && calcLayout.heading.includes("고정비 / 차감 항목") && calcLayout.cardSections === 0 &&
    myAuto1.groups.join() === "고정금(현금) — 하나" && myAuto1.groupAccount && myAuto1.sections.join() === "고정금(카드) — 우리카드,고정금(카드) — 현대카드" &&
    myAuto1.w2 === "450,000" && myAuto1.autoChecks === 1 &&
    myAuto2.w2 === "320,000" && myAuto2.instRows === 1 && myAuto2.sum === "1,000,000" && myAuto2.analysisCard === "1,000,000원" &&
    myInst && myInst.installments[0].card === "cardFixedWoori" && myInst.installments[0].monthlyAmount === 130000 && (await st(page)).dirty.length === 0,
    { calcLayout, myAuto1, myAuto2, myInst });
  await page.$eval('#minyoung-section-tabs button[data-section="calc"]', (b) => b.click());
  await page.click('#person-tabs button[data-person="minhyun"]');

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
  check("한글 조합 중 다른 기기 변경이 와도 입력 칸을 다시 만들지 않음(조합 끝난 뒤 반영)", ime.same && ime.connected && ime.my === "1,400,000원", ime);
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

  /* ===== 생활비 사용 계획: 관리카드·계좌번호 ===== */
  await page.click('#person-tabs button[data-person="joint"]');
  await typeInto(page, '#joint-living-body input[data-extra="card"]', "우리카드");
  await typeInto(page, '#joint-living-body input[data-extra="account"]', "110-123-456789");
  const livingMirror = await page.evaluate(() => ({
    card: document.querySelector('#modal-living-body input[data-extra="card"]').value,
    account: document.querySelector('#modal-living-body input[data-extra="account"]').value,
    heads: [...document.querySelectorAll("#joint-living-body")[0].closest("table").querySelectorAll("th")].map((t) => t.textContent).join("|")
  }));
  await page.click("#add-living-btn-open");
  await typeInto(page, "#new-living-name", "관리비");
  await typeInto(page, "#new-living-card", "현대카드");
  await typeInto(page, "#new-living-amount", "120000");
  await typeInto(page, "#new-living-account", "333-22-1111");
  await page.click("#add-living-btn");
  await page.click("#modal-close-btn");
  await page.click("#save-salary-btn");
  await waitSaved(page);
  const jf = await read("joint_fixed");
  const last = jf.livingItems[jf.livingItems.length - 1];
  check("생활비 계획: 관리카드·계좌번호 칸 표시/입력/추가창 동기화/저장",
    livingMirror.heads.includes("관리카드") && livingMirror.heads.includes("계좌번호") && livingMirror.card === "우리카드" && livingMirror.account === "110-123-456789" &&
    jf.livingItems[0].card === "우리카드" && jf.livingItems[0].account === "110-123-456789" &&
    last.name === "관리비" && last.card === "현대카드" && last.amount === 120000 && last.account === "333-22-1111" &&
    (await st(page)).dirty.join() === "minhyun,minyoung", { livingMirror, items: jf.livingItems, dirty: (await st(page)).dirty });

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
  mobile.quickBtns = await mp.evaluate(() => ["month-prevmonth-btn", "month-thismonth-btn"].every((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.right <= window.innerWidth && top === document.getElementById(id);
  }));
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
  check("모바일(390px): 가로 넘침 없음, 전월/현재월 버튼 보임, 저장 버튼 하단 고정·탭 가능, 표 입력·모달 사용 가능", !mobile.overflow && mobile.quickBtns && mobile.saveBar && mobile.tableInputWorks && mobile.saveClickable && mobile.modal && mobile.saved && mobile.addModal, mobile);

  /* ===== 표지 / 가계부 모드 / 보기 모드 ===== */
  {
    const vp = await newPage(1280, 900);
    await vp.goto(BASE);
    await vp.waitForFunction(() => window.__budgetTest, { timeout: 15000 });
    const cover = await vp.evaluate(() => ({ shown: !document.getElementById("cover").hidden, title: document.querySelector(".cover-title").textContent, img: document.querySelector(".cover-dog").complete && document.querySelector(".cover-dog").naturalWidth > 0, btns: [...document.querySelectorAll(".cover-btn")].map((b) => b.firstChild.textContent.trim()) }));
    check("표지: '별이네집 가계부' 제목·별이 사진·가계부 모드/보기 모드 버튼", cover.shown && cover.title === "별이네집 가계부" && cover.img && cover.btns.join() === "가계부 모드,보기 모드", cover);
    await vp.evaluate(() => window.__budgetTest.signIn("member@example.com", "pass1234"));
    await vp.waitForFunction(() => window.__budgetTest.state().ready, { timeout: 15000 });
    await vp.click("#enter-view");
    await vp.waitForFunction(() => document.body.classList.contains("view-mode") && document.getElementById("cover").hidden, { timeout: 10000 });
    await sleep(200);
    const visible = (sel) => vp.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0).length);
    const before = await val(vp, "#salary-amount");
    await vp.click("#salary-amount").catch(() => {});
    await vp.keyboard.type("999");
    const viewPc = {
      mode: await vp.evaluate(() => document.body.classList.contains("view-mode") && document.getElementById("cover").hidden),
      checkboxes: await visible("#view-salary td.check-cell input"),
      deletes: await visible("#view-salary td.row-actions button"),
      addBtns: await visible("#view-salary .section-head .icon-btn"),
      saveRow: await visible("#save-row"),
      readOnly: await vp.$eval("#salary-amount", (e) => e.readOnly),
      unchanged: (await val(vp, "#salary-amount")) === before,
      dirty: (await st(vp)).dirty.length,
      accountShown: await visible("#fixed-items-body .account-input")
    };
    check("PC 보기 모드: 체크박스·삭제·추가·저장 없음, 입력 불가, 계좌 등 다른 칸은 그대로 표시",
      viewPc.mode && viewPc.checkboxes === 0 && viewPc.deletes === 0 && viewPc.addBtns === 0 && viewPc.saveRow === 0 && viewPc.readOnly && viewPc.unchanged && viewPc.dirty === 0, viewPc);
    await clickText(vp, "자산 현황");
    const assetsView = { forms: await visible("#view-assets .edit-only"), deletes: await visible("#view-assets td.row-actions button") };
    await clickText(vp, "월급 계산");
    await vp.click("#to-cover-btn");
    await sleep(200);
    const backCover = await vp.evaluate(() => !document.getElementById("cover").hidden);
    await vp.click("#enter-edit");
    await vp.waitForFunction(() => !document.body.classList.contains("view-mode") && document.getElementById("cover").hidden && document.querySelector("#fixed-giup-body td.check-cell input"), { timeout: 10000 });
    await sleep(200);
    const editAgain = { readOnly: await vp.$eval("#salary-amount", (e) => e.readOnly), checkboxes: await visible("#fixed-giup-body td.check-cell input"), saveRow: await visible("#save-row"),
      dbg: await vp.evaluate(() => ({ rows: document.querySelectorAll("#fixed-giup-body tr").length, body: document.body.className, person: window.__budgetTest.state().currentPerson, calcShown: getComputedStyle(document.getElementById("minhyun-calc-section")).display, panel: getComputedStyle(document.getElementById("panel-minhyun")).display })) };
    check("표지 버튼 → 표지, 가계부 모드로 다시 들어가면 수정 가능 / 자산 현황 보기 모드는 추가·삭제 숨김",
      backCover && !editAgain.readOnly && editAgain.checkboxes > 0 && editAgain.saveRow === 1 && assetsView.forms === 0 && assetsView.deletes === 0, { backCover, editAgain, assetsView });
    // 미저장 상태에서 표지로 가려다 취소
    await typeInto(vp, "#salary-amount", "4800000");
    vp.__dialogHandler = (d) => d.dismiss();
    await vp.click("#to-cover-btn");
    await sleep(300);
    check("미저장 변경이 있을 때 표지로 가기 → 확인창, 취소하면 그대로", (await vp.evaluate(() => document.getElementById("cover").hidden)) && (await val(vp, "#salary-amount")) === "4,800,000" && vp.__lastDialog && vp.__lastDialog.type === "confirm");
    vp.__dialogHandler = (d) => d.accept();
    await vp.click("#to-cover-btn");
    await sleep(300);
    check("확인하면 변경 버리고 표지로", !(await vp.evaluate(() => document.getElementById("cover").hidden)) && (await st(vp)).dirty.length === 0);
    await vp.close();

    const mv = await newPage(390, 844, true);
    await mv.goto(BASE + "#view");
    await mv.waitForFunction(() => window.__budgetTest, { timeout: 15000 });
    await mv.evaluate(() => window.__budgetTest.signIn("member@example.com", "pass1234"));
    await mv.waitForFunction(() => window.__budgetTest.state().ready, { timeout: 15000 });
    await sleep(300);
    const cellsPerRow = () => mv.$$eval("#view-salary tbody tr", (trs) => trs.filter((tr) => tr.offsetParent !== null).map((tr) => [...tr.cells].filter((td) => getComputedStyle(td).display !== "none").map((td) => td.classList.contains("name-cell") ? "항목" : td.classList.contains("amount-cell") ? "금액" : "기타").join("+")));
    const mh = await cellsPerRow();
    await mv.$eval('#person-tabs button[data-person="minyoung"]', (b) => b.click());
    await sleep(300);
    const my = await cellsPerRow();
    const mobileView = {
      direct: await mv.evaluate(() => document.getElementById("cover").hidden && document.body.classList.contains("view-mode")),
      mh: [...new Set(mh)], my: [...new Set(my)],
      sideways: await mv.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    };
    if (SHOTS) await mv.screenshot({ path: SHOTS + "/view_mobile.png", fullPage: true });
    check("모바일 보기 모드: 주소 #view로 바로 진입, 모든 줄이 '항목+금액'만 표시, 옆 스크롤 없음",
      mobileView.direct && mobileView.mh.join() === "항목+금액" && mobileView.my.join() === "항목+금액" && !mobileView.sideways, mobileView);
    await mv.close();
  }

  /* ===== 공용 비밀번호 모드 ===== */
  {
    const pp = await newPage(390, 844, true);
    await pp.goto(BASE + "&auth=password#edit");
    await pp.waitForFunction(() => document.getElementById("password-form").style.display !== "none", { timeout: 15000 });
    const locked = await pp.evaluate(() => ({
      app: getComputedStyle(document.getElementById("app-main")).display,
      money: /\d{1,3}(,\d{3})+원/.test(document.body.innerText),
      title: document.getElementById("gate-title").textContent
    }));
    check("비밀번호 모드: 처음엔 잠금 화면만, 금액 안 보임", locked.app === "none" && !locked.money && locked.title === "가계부 잠금", locked);
    await pp.type("#shared-password", "wrong-password");
    await pp.click("#password-submit");
    await pp.waitForFunction(() => document.getElementById("password-error").style.display !== "none", { timeout: 15000 });
    const wrong = { err: await txt(pp, "#password-error"), app: await pp.$eval("#app-main", (e) => getComputedStyle(e).display), authorized: (await st(pp)).authorized };
    check("틀린 비밀번호: 오류 표시, 계속 잠김", wrong.err.includes("맞지 않") && wrong.app === "none" && !wrong.authorized, wrong);
    await typeInto(pp, "#shared-password", SHARED_PW);
    await pp.click("#password-submit");
    await pp.waitForFunction(() => window.__budgetTest.state().ready, { timeout: 15000 });
    check("맞는 비밀번호: 가계부 열림 + 데이터 표시", (await val(pp, "#salary-amount")) !== "" && (await pp.$eval("#logout-btn", (e) => e.textContent)) === "잠그기");
    await pp.reload();
    await pp.waitForFunction(() => window.__budgetTest && window.__budgetTest.state().ready, { timeout: 15000 });
    const afterReload = { authorized: (await st(pp)).authorized, cover: await pp.evaluate(() => !document.getElementById("cover").hidden), hash: await pp.evaluate(() => location.hash) };
    check("새로고침하면 표지로 돌아감(주소의 #edit 제거) + 비밀번호는 다시 묻지 않음", afterReload.authorized && afterReload.cover && afterReload.hash === "", afterReload);
    await pp.click("#enter-edit");
    await sleep(300);
    page.__dialogHandler = null;
    await pp.click("#logout-btn");
    await pp.waitForFunction(() => document.getElementById("password-form") && document.getElementById("password-form").style.display !== "none", { timeout: 15000 });
    check("잠그기 → 다시 비밀번호 화면", await pp.$eval("#app-main", (e) => getComputedStyle(e).display) === "none");
    await pp.close();
  }

  /* ===== 임시 익명 모드 (콘솔 설정 전 배포용, 현재 실제 서버와 같은 request.auth != null 규칙) ===== */
  const LEGACY_RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if request.auth != null;\n    }\n  }\n}\n";
  await env.cleanup();
  env = await initializeTestEnvironment({ projectId: "demo-budget", firestore: { rules: LEGACY_RULES, host: "127.0.0.1", port: 8080 } });
  const ap = await newPage();
  await ap.goto(BASE + "&auth=anonymous#edit");
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
