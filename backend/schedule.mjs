/* ==========================================================================
   schedule.mjs — 팀 공유 일정

   작업 일정과 휴가를 한 달력에서 같이 봅니다. 여기에 공사 기간과(관리자에게만)
   입찰 마감일을 겹쳐 얹으면, "이번 주에 누가 어디 있고 언제 비는가" 가 한 화면에
   들어옵니다.

     schedules 표  ─┐
     projects      ─┼→ calendarFeed()  →  달력 한 장
     bid_notices   ─┘   (입찰은 관리자만)

   일정은 누구나 고칠 수 있습니다(조회 전용 제외). 대신 모든 변경이
   audit_logs 에 남아 누가 바꿨는지 추적됩니다.
   ========================================================================== */

import { all, get, run, nowIso, newId, auditLog } from "./db.mjs";

export const KINDS = {
  work: { label: "작업", tone: "accent" },
  leave: { label: "휴가", tone: "warn" },
  etc: { label: "기타", tone: "mid" },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

/** 입력을 다듬고, 끝날짜가 시작보다 앞서면 뒤집습니다. */
function normalize(input) {
  const title = String(input.title || "").trim();
  if (!title) fail("일정 제목을 입력해 주세요.");

  const kind = KINDS[input.kind] ? input.kind : "work";
  let startDate = String(input.startDate || "").trim();
  let endDate = String(input.endDate || "").trim() || startDate;
  if (!DATE.test(startDate)) fail("시작일을 YYYY-MM-DD 로 입력해 주세요.");
  if (!DATE.test(endDate)) fail("종료일을 YYYY-MM-DD 로 입력해 주세요.");
  if (endDate < startDate) [startDate, endDate] = [endDate, startDate];

  const allDay = input.allDay === undefined ? true : Boolean(input.allDay);
  let startTime = allDay ? null : String(input.startTime || "").trim() || null;
  let endTime = allDay ? null : String(input.endTime || "").trim() || null;
  if (startTime && !TIME.test(startTime)) fail("시작 시각을 HH:MM 으로 입력해 주세요.");
  if (endTime && !TIME.test(endTime)) fail("종료 시각을 HH:MM 으로 입력해 주세요.");
  // 하루 안에서 끝나는 일정만 시각 순서를 따집니다.
  if (startTime && endTime && startDate === endDate && endTime < startTime) {
    [startTime, endTime] = [endTime, startTime];
  }

  const projectId = String(input.projectId || "").trim() || null;
  if (projectId && !get("SELECT id FROM projects WHERE id = ?", projectId)) {
    fail("연결할 공사를 찾을 수 없습니다.");
  }

  return {
    kind, title, startDate, endDate, allDay, startTime, endTime, projectId,
    assignees: String(input.assignees || "").split(",").map((name) => name.trim()).filter(Boolean).join(", ") || null,
    location: String(input.location || "").trim() || null,
    note: String(input.note || "").trim() || null,
  };
}

const SELECT = `
  SELECT s.*, p.name AS project_name
  FROM schedules s LEFT JOIN projects p ON p.id = s.project_id`;

const shape = (row) => ({
  ...row,
  all_day: Boolean(row.all_day),
  assignee_list: row.assignees ? row.assignees.split(",").map((name) => name.trim()).filter(Boolean) : [],
  kind_label: KINDS[row.kind]?.label || row.kind,
});

/** 기간과 겹치는 일정. 기간을 넘겨받지 않으면 전부 돌려줍니다. */
export function listSchedules({ from, to, kind } = {}) {
  const where = [];
  const params = [];
  // 겹침 판정: 시작이 조회 끝보다 늦지 않고, 끝이 조회 시작보다 빠르지 않으면 겹칩니다.
  if (from) { where.push("s.end_date >= ?"); params.push(from); }
  if (to) { where.push("s.start_date <= ?"); params.push(to); }
  if (kind && KINDS[kind]) { where.push("s.kind = ?"); params.push(kind); }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
               ORDER BY s.start_date, s.all_day DESC, s.start_time, s.title`;
  return all(sql, ...params).map(shape);
}

export function getSchedule(id) {
  const row = get(`${SELECT} WHERE s.id = ?`, id);
  return row ? shape(row) : null;
}

export function createSchedule(input, user) {
  const value = normalize(input);
  const id = newId("SCH");
  run(`INSERT INTO schedules
         (id, kind, title, start_date, end_date, all_day, start_time, end_time,
          assignees, project_id, location, note, created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, value.kind, value.title, value.startDate, value.endDate, value.allDay ? 1 : 0,
  value.startTime, value.endTime, value.assignees, value.projectId, value.location, value.note,
  user, nowIso(), user, nowIso());

  auditLog(user, "일정", `${KINDS[value.kind].label} 등록`,
    `${value.title} / ${value.startDate}${value.endDate !== value.startDate ? `~${value.endDate}` : ""}`);
  return getSchedule(id);
}

/** 누구 일정이든 고칠 수 있습니다. 대신 바꾼 사람을 남깁니다. */
export function updateSchedule(id, input, user) {
  const existing = get("SELECT * FROM schedules WHERE id = ?", id);
  if (!existing) throw Object.assign(new Error("일정을 찾을 수 없습니다."), { status: 404 });

  const merged = normalize({
    kind: input.kind ?? existing.kind,
    title: input.title ?? existing.title,
    startDate: input.startDate ?? existing.start_date,
    endDate: input.endDate ?? existing.end_date,
    allDay: input.allDay ?? Boolean(existing.all_day),
    startTime: input.startTime ?? existing.start_time,
    endTime: input.endTime ?? existing.end_time,
    assignees: input.assignees ?? existing.assignees,
    projectId: input.projectId ?? existing.project_id,
    location: input.location ?? existing.location,
    note: input.note ?? existing.note,
  });

  run(`UPDATE schedules SET kind = ?, title = ?, start_date = ?, end_date = ?, all_day = ?,
         start_time = ?, end_time = ?, assignees = ?, project_id = ?, location = ?, note = ?,
         updated_by = ?, updated_at = ? WHERE id = ?`,
  merged.kind, merged.title, merged.startDate, merged.endDate, merged.allDay ? 1 : 0,
  merged.startTime, merged.endTime, merged.assignees, merged.projectId, merged.location, merged.note,
  user, nowIso(), id);

  const movedFrom = existing.start_date !== merged.startDate || existing.end_date !== merged.endDate
    ? ` (${existing.start_date} → ${merged.startDate})` : "";
  auditLog(user, "일정", `${KINDS[merged.kind].label} 수정`, `${merged.title}${movedFrom}`);
  return getSchedule(id);
}

export function removeSchedule(id, user) {
  const existing = get("SELECT * FROM schedules WHERE id = ?", id);
  if (!existing) throw Object.assign(new Error("일정을 찾을 수 없습니다."), { status: 404 });
  run("DELETE FROM schedules WHERE id = ?", id);
  auditLog(user, "일정", "일정 삭제", `${existing.title} / ${existing.start_date}`);
  return { ok: true };
}

/**
 * 달력 한 장에 필요한 것을 모아 줍니다.
 * 입찰은 관리자 전용 모듈이라 관리자에게만 실어 보냅니다.
 */
export function calendarFeed({ from, to, isAdmin = false }) {
  const projects = all(`
    SELECT id, name, site, manager, status, start_date, end_date
    FROM projects
    WHERE start_date IS NOT NULL AND start_date <> ''
      AND COALESCE(NULLIF(end_date,''), start_date) >= ?
      AND start_date <= ?
    ORDER BY start_date`, from, to);

  const bids = isAdmin
    ? all(`SELECT id, title, close_date, kind, notice_inst, starred
           FROM bid_notices
           WHERE close_date IS NOT NULL AND substr(close_date,1,10) BETWEEN ? AND ?
           ORDER BY close_date`, from, to)
    : [];

  return {
    range: { from, to },
    schedules: listSchedules({ from, to }),
    projects,
    bids: bids.map((row) => ({ ...row, date: String(row.close_date).slice(0, 10) })),
    kinds: KINDS,
  };
}
