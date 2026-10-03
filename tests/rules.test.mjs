import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, addDoc } from "firebase/firestore";

const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const env = await initializeTestEnvironment({
  projectId: "demo-rules",
  firestore: { rules: RULES, host: "127.0.0.1", port: 8080 }
});
await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "budget_members", "member-uid"), { name: "민현" });
  await setDoc(doc(db, "budget_members", "shared-uid"), { name: "공용" });
  await setDoc(doc(db, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 1 });
  await setDoc(doc(db, "budget_assets", "a1"), { kind: "loan", limit: 1, used: 0 });
  await setDoc(doc(db, "events", "e1"), { title: "캘린더" });
});

const member = env.authenticatedContext("member-uid", { email: "member@example.com" }).firestore();
const sharedAcct = env.authenticatedContext("shared-uid", { email: "family@budget-minyoung.invalid", firebase: { sign_in_provider: "password" } }).firestore();
const pwStranger = env.authenticatedContext("other-pw-uid", { email: "family@budget-minyoung.invalid", firebase: { sign_in_provider: "password" } }).firestore();
const stranger = env.authenticatedContext("stranger-uid", { email: "stranger@example.com" }).firestore();
const anon = env.authenticatedContext("anon-uid", { firebase: { sign_in_provider: "anonymous" } }).firestore();
const unauth = env.unauthenticatedContext().firestore();

const cases = [
  ["승인 계정: 월급 문서 읽기 허용", () => assertSucceeds(getDoc(doc(member, "budget_salaryProfiles", "minhyun_2026-10")))],
  ["승인 계정: 월급 문서 쓰기 허용", () => assertSucceeds(setDoc(doc(member, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 2 }, { merge: true }))],
  ["승인 계정: 자산 목록 읽기 허용", () => assertSucceeds(getDocs(collection(member, "budget_assets")))],
  ["승인 계정: 자산 추가 허용", () => assertSucceeds(addDoc(collection(member, "budget_assets"), { kind: "saving", amount: 1 }))],
  ["승인 계정: 자기 멤버 문서 읽기 허용", () => assertSucceeds(getDoc(doc(member, "budget_members", "member-uid")))],
  ["승인 계정: 멤버 목록 쓰기 차단", () => assertFails(setDoc(doc(member, "budget_members", "new-uid"), { name: "x" }))],
  ["공용 비밀번호 계정(등록됨): 월급 문서 읽기·쓰기 허용", () => assertSucceeds(setDoc(doc(sharedAcct, "budget_salaryProfiles", "minyoung_2026-10"), { salary: 3 }, { merge: true }))],
  ["같은 이메일을 사칭해도 UID가 다르면 차단", () => assertFails(getDoc(doc(pwStranger, "budget_salaryProfiles", "minhyun_2026-10")))],
  ["미승인 계정: 월급 문서 읽기 차단", () => assertFails(getDoc(doc(stranger, "budget_salaryProfiles", "minhyun_2026-10")))],
  ["미승인 계정: 월급 문서 쓰기 차단", () => assertFails(setDoc(doc(stranger, "budget_salaryProfiles", "minhyun_2026-10"), { salary: 9 }))],
  ["미승인 계정: 자산 읽기 차단", () => assertFails(getDocs(collection(stranger, "budget_assets")))],
  ["미승인 계정: 자산 삭제 차단", () => assertFails(deleteDoc(doc(stranger, "budget_assets", "a1")))],
  ["미승인 계정: 자기를 멤버로 등록 차단", () => assertFails(setDoc(doc(stranger, "budget_members", "stranger-uid"), { name: "x" }))],
  ["미승인 계정: 남의 멤버 문서 읽기 차단", () => assertFails(getDoc(doc(stranger, "budget_members", "member-uid")))],
  ["익명 로그인: 월급 문서 읽기 차단", () => assertFails(getDoc(doc(anon, "budget_salaryProfiles", "minhyun_2026-10")))],
  ["익명 로그인: 자산 쓰기 차단", () => assertFails(addDoc(collection(anon, "budget_assets"), { kind: "loan" }))],
  ["로그인 안 함: 월급 문서 읽기 차단", () => assertFails(getDoc(doc(unauth, "budget_salaryProfiles", "minhyun_2026-10")))],
  ["로그인 안 함: 자산 읽기 차단", () => assertFails(getDocs(collection(unauth, "budget_assets")))],
  ["캘린더(events) 기존 규칙 유지: 익명 로그인 읽기 허용", () => assertSucceeds(getDoc(doc(anon, "events", "e1")))],
  ["캘린더(events) 기존 규칙 유지: 로그인 안 함 읽기 차단", () => assertFails(getDoc(doc(unauth, "events", "e1")))]
];

let fail = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { fail++; console.log("FAIL", name, "-", e.message.split("\n")[0]); }
}
await env.cleanup();
console.log(`RULES ${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
