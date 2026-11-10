// Date understanding for temporal questions.
//
// Chat memory questions name days in human ways: "on 3 November",
// "last Tuesday", "on Monday", "yesterday". This module turns those
// phrases into concrete local dates so memory lookup is an exact date
// match, not a guess. All dates are local (the machine running the
// server), stored on each turn as dateLocal = YYYY-MM-DD.

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3,
  apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10,
  nov: 10, december: 11, dec: 11,
};

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6,
};

export function toDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function monthDayLocal(dateLocal) {
  // "2026-11-03" -> "11-03", for explicit-date matching across years.
  return String(dateLocal || "").slice(5);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Most recent occurrence of a weekday. If the phrase says "last", a
// same-day match steps back a full week ("last Tuesday" said on a
// Tuesday means the Tuesday of last week, not today).
function lastWeekday(targetDay, now, forcePreviousWeek) {
  const d = startOfDay(now);
  let delta = (d.getDay() - targetDay + 7) % 7;
  if (delta === 0 && forcePreviousWeek) delta = 7;
  d.setDate(d.getDate() - delta);
  return d;
}

// Resolve the date a question refers to.
// Returns { dateLocal, monthDay, label } or null when the question
// names no recognisable day.
export function resolveReferencedDate(text, now = new Date()) {
  const t = ` ${String(text || "").toLowerCase()} `;

  // Order matters: explicit dates and weekdays are checked BEFORE
  // "today" and "yesterday". A question like "What did I ask you on
  // 3 November? Is your answer still correct today?" contains the word
  // "today", but the day it refers to is 3 November. Checking "today"
  // first would silently resolve to the wrong day.

  // Explicit: "3 November", "3rd Nov", "November 3", optional year.
  const explicit =
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?\b/) ||
    t.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (explicit) {
    let day, monthName, year;
    if (/^\d/.test(explicit[1])) {
      [, day, monthName, year] = explicit;
    } else {
      [, monthName, day, year] = explicit;
    }
    if (MONTHS[monthName] !== undefined) {
      const month = MONTHS[monthName];
      const y = year ? Number(year) : now.getFullYear();
      const d = new Date(y, month, Number(day));
      return {
        dateLocal: toDateLocal(d),
        monthDay: `${String(month + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-GB", { day: "numeric", month: "long" }),
      };
    }
  }

  // Weekday: "last Tuesday", "on Monday", "this Friday".
  const weekdayMatch = t.match(
    /\b(last|this|on)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/
  );
  if (weekdayMatch) {
    const [, modifier, dayName] = weekdayMatch;
    const d = lastWeekday(WEEKDAYS[dayName], now, modifier === "last");
    return {
      dateLocal: toDateLocal(d),
      monthDay: null,
      label: d.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    };
  }

  if (/\byesterday\b/.test(t)) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - 1);
    return { dateLocal: toDateLocal(d), monthDay: null, label: "yesterday" };
  }
  if (/\btoday\b/.test(t)) {
    return { dateLocal: toDateLocal(now), monthDay: null, label: "today" };
  }

  return null;
}
