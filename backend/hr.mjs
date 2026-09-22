/* ==========================================================================
   hr.mjs — 인사 (휴가·연차)

   직원 다섯 명짜리 회사에 결재 단계를 여러 개 두면 아무도 안 씁니다.
   여기서 하는 일은 셋뿐입니다.

     1. 누가 며칠 썼고 며칠 남았는가          (연차 집계)
     2. 언제 누가 쉬는가                      (일정표와 같은 자료를 봅니다)
     3. 휴가를 넣고 빼는 것                   (일정표의 '휴가' 와 같은 줄입니다)

   휴가를 따로 저장하지 않고 schedules 의 kind='leave' 를 그대로 씁니다.
   달력과 인사 화면이 다른 숫자를 보여 주는 일이 생기지 않습니다.
   ========================================================================== */

import { all, get, run, nowIso, today, auditLog } from "./db.mjs";

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

/** 'YYYY-MM-DD' 두 날짜 사이의 일수(양끝 포함). */
function daysBetween(start, end) {
  const from = new Date(`${start}T00:00:00`);
  const to = new Date(`${end || start}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

/** 담당자 문자열("설경민, 박지민")에서 이름을 갈라냅니다. */
const namesOf = (value) => String(value || "").split(",").map((name) => name.trim()).filter(Boolean);

/**
 * 그 해의 휴가를 직원별로 모읍니다.
 *
 * 휴가 한 건에 담당자가 여럿이면 각자에게 셉니다 — 두 사람이 같이 쉬면
 * 두 사람 모두 연차를 씁니다.
 * 해를 걸친 휴가는 그 해에 속한 날짜만 셉니다.
 */
export function leaveSummary(year = today().slice(0, 4)) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = all(`
    SELECT id, title, start_date, end_date, assignees, note, created_by, updated_at
    FROM schedules
    WHERE kind = 'leave' AND end_date >= ? AND start_date <= ?
    ORDER BY start_date DESC`, from, to);

  const users = all("SELECT id, name, role, active, annual_leave FROM users ORDER BY created_at");
  const byName = new Map(users.map((user) => [user.name, {
    id: user.id, name: user.name, role: user.role, active: Boolean(user.active),
    quota: user.annual_leave ?? 15, used: 0, upcoming: 0, rows: [],
  }]));

  for (const row of rows) {
    // 해를 걸친 휴가는 올해에 걸린 날짜만 셉니다.
    const start = row.start_date < from ? from : row.start_date;
    const end = (row.end_date || row.start_date) > to ? to : (row.end_date || row.start_date);
    const days = daysBetween(start, end);
    const future = start > today();

    for (const name of namesOf(row.assignees)) {
      const person = byName.get(name);
      if (!person) continue;                 // 퇴사자·외부 인원은 집계에서 뺍니다
      person.used += days;
      if (future) person.upcoming += days;
      person.rows.push({ ...row, days, future });
    }
  }

  const people = [...byName.values()].map((person) => ({
    ...person,
    remaining: Math.max(0, person.quota - person.used),
    rate: person.quota ? Math.round((person.used / person.quota) * 100) : 0,
  }));

  return {
    year,
    people,
    // 담당자 이름이 직원 목록에 없는 휴가 — 이름을 잘못 적었을 때 눈에 띄라고 남깁니다.
    unmatched: rows.filter((row) => !namesOf(row.assignees).some((name) => byName.has(name)))
      .map((row) => ({ id: row.id, title: row.title, assignees: row.assignees, start_date: row.start_date })),
    totalDays: rows.reduce((sum, row) => sum + daysBetween(row.start_date, row.end_date), 0),
    count: rows.length,
  };
}

/** 연차 한도 변경. 사장만 합니다. */
export function setQuota(userId, days, user) {
  const target = get("SELECT id, name FROM users WHERE id = ?", userId);
  if (!target) fail("직원을 찾을 수 없습니다.", 404);
  const quota = Number(days);
  if (!Number.isFinite(quota) || quota < 0 || quota > 365) fail("연차 일수는 0~365 사이여야 합니다.");
  run("UPDATE users SET annual_leave = ? WHERE id = ?", Math.round(quota), userId);
  auditLog(user, "인사", "연차 한도 변경", `${target.name} → ${Math.round(quota)}일`);
  return get("SELECT id, name, annual_leave FROM users WHERE id = ?", userId);
}
