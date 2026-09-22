/**
 * 직원 계정 생성 스크립트.
 *
 *   node backend/seed-users.mjs            기본 직원 계정 생성
 *   node backend/seed-users.mjs --reset    이미 있으면 비밀번호만 새로 발급
 *
 * 비밀번호는 실행할 때 한 번만 출력됩니다. DB 에는 scrypt 해시만 저장되므로
 * 다시 확인할 수 없고, 잊으면 --reset 으로 재발급해야 합니다.
 */

import { randomInt } from "node:crypto";
import { all, get, run, nowIso, passwordRecord, newId, auditLog } from "./db.mjs";

/* 기존 시드 데이터에 담당자로 등장하는 사람들에 맞춰 계정을 만듭니다. */
const STAFF = [
  { name: "정미라", email: "jungmira@inpack.local", role: "purchasing", note: "발주 승인자" },
  { name: "김현우", email: "kimhyunwoo@inpack.local", role: "warehouse", note: "세종 현장·입고 담당" },
  { name: "박지민", email: "parkjimin@inpack.local", role: "warehouse", note: "동탄 현장 담당" },
  { name: "이준호", email: "leejunho@inpack.local", role: "viewer", note: "판교 현장 조회" },
];

const ROLE_LABEL = { admin: "관리자", purchasing: "구매 담당", warehouse: "창고 담당", viewer: "조회 전용" };

/* 읽어서 옮겨 적기 쉬우면서 추측은 어려운 임시 비밀번호 */
const WORDS = ["cable", "relay", "switch", "conduit", "breaker", "socket", "panel", "meter", "busbar", "ground"];
function tempPassword() {
  const pick = () => WORDS[randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${randomInt(1000, 9999)}`;
}

const reset = process.argv.includes("--reset");
const created = [];
const skipped = [];

for (const person of STAFF) {
  const existing = get("SELECT * FROM users WHERE email = ?", person.email);

  if (existing && !reset) {
    skipped.push(person);
    continue;
  }

  const password = tempPassword();
  const record = passwordRecord(password);

  if (existing) {
    run("UPDATE users SET name = ?, role = ?, active = 1, password_salt = ?, password_hash = ? WHERE id = ?",
      person.name, person.role, record.salt, record.hash, existing.id);
    auditLog("시스템", "시스템", "비밀번호 재발급", person.email);
  } else {
    run(`INSERT INTO users (id, name, email, role, active, password_salt, password_hash, created_at)
         VALUES (?,?,?,?,1,?,?,?)`,
      newId("USR"), person.name, person.email, person.role, record.salt, record.hash, nowIso());
    auditLog("시스템", "시스템", "직원 계정 생성", `${person.email} / ${ROLE_LABEL[person.role]}`);
  }
  created.push({ ...person, password });
}

const line = "─".repeat(78);
console.log(`\n${line}`);

if (created.length) {
  console.log("  발급된 계정 — 이 비밀번호는 지금 한 번만 표시됩니다\n");
  console.log(`  ${"이름".padEnd(8)}${"이메일".padEnd(30)}${"역할".padEnd(12)}비밀번호`);
  console.log(`  ${"-".repeat(74)}`);
  for (const person of created) {
    console.log(`  ${person.name.padEnd(9)}${person.email.padEnd(30)}${ROLE_LABEL[person.role].padEnd(13)}${person.password}`);
  }
  console.log("\n  · 각자 로그인 후 설정 > 비밀번호 변경에서 바꾸게 하세요.");
  console.log("  · 금액(경영·회계·매출·재고자산)은 관리자만 볼 수 있습니다.");
} else {
  console.log("  새로 만든 계정이 없습니다.");
}

if (skipped.length) {
  console.log(`\n  이미 있어서 건너뜀: ${skipped.map((person) => person.email).join(", ")}`);
  console.log("  비밀번호를 새로 발급하려면: node backend/seed-users.mjs --reset");
}

console.log(`${line}\n`);
console.log("  현재 전체 계정");
for (const user of all("SELECT name, email, role, active FROM users ORDER BY role, name")) {
  console.log(`   · ${user.name} (${ROLE_LABEL[user.role] || user.role})${user.active ? "" : " [중지]"} — ${user.email}`);
}
console.log("");
