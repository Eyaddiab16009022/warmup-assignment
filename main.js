const fs = require("fs");

function parse12hToSeconds(t) {
  if (typeof t !== "string") return NaN;
  const s = t.trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)$/);
  if (!m) return NaN;

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const ap = m[4];

  if (hh < 1 || hh > 12 || mm > 59 || ss > 59) return NaN;

  if (hh === 12) hh = 0;
  if (ap === "pm") hh += 12;

  return hh * 3600 + mm * 60 + ss;
}

function secondsToHMS(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const rem = totalSeconds % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseHMSToSeconds(hms) {
  if (typeof hms !== "string") return NaN;
  const m = hms.trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return NaN;

  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);

  if (mm > 59 || ss > 59) return NaN;
  return h * 3600 + mm * 60 + ss;
}

function readLinesSafe(path) {
  if (!fs.existsSync(path)) return [];
  const content = fs.readFileSync(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function monthFromDate(dateStr) {
  const m = (dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return parseInt(m[2], 10);
}

function isValidDateStr(dateStr) {
  return typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim());
}

function isBetweenInclusive(dateStr, startStr, endStr) {
  return dateStr >= startStr && dateStr <= endStr;
}

function parseShiftLineCSV(line) {
  const parts = line.split(",").map((x) => x.trim());
  if (parts[0]?.toLowerCase() === "driverid") return null;
  if (parts.length < 10) return null;

  return {
    driverID: parts[0],
    driverName: parts[1],
    date: parts[2],
    startTime: parts[3],
    endTime: parts[4],
    shiftDuration: parts[5],
    idleTime: parts[6],
    activeTime: parts[7],
    metQuota: parts[8] === "true",
    hasBonus: parts[9] === "true",
  };
}

function serializeShiftLineCSV(obj) {
  return [
    obj.driverID,
    obj.driverName,
    obj.date,
    obj.startTime,
    obj.endTime,
    obj.shiftDuration,
    obj.idleTime,
    obj.activeTime,
    String(!!obj.metQuota),
    String(!!obj.hasBonus),
  ].join(",");
}

function parseRateLineCSV(line) {
  const parts = line.split(",").map((x) => x.trim());
  if (parts[0]?.toLowerCase() === "driverid") return null;
  if (parts.length < 4) return null;

  const driverID = parts[0];
  const dayName = parts[1];
  const basePay = parseInt(parts[2], 10);
  const tier = parseInt(parts[3], 10);

  if (!driverID || !Number.isFinite(basePay) || !Number.isFinite(tier)) return null;
  return { driverID, dayName, basePay, tier };
}

function getRateRow(rateFile, driverID) {
  const lines = readLinesSafe(rateFile);
  for (const line of lines) {
    const row = parseRateLineCSV(line);
    if (row && row.driverID === driverID) return row;
  }
  return null;
}

function getTierAllowanceHours(tier) {
  switch (tier) {
    case 1: return 50;
    case 2: return 20;
    case 3: return 10;
    case 4: return 3;
    default: return 0;
  }
}

function quotaSecondsForDate(dateStr) {
  if (isBetweenInclusive(dateStr, "2025-04-10", "2025-04-30")) {
    return 6 * 3600;
  }
  return (8 * 3600) + (24 * 60);
}

function getShiftDuration(startTime, endTime) {
  const start = parse12hToSeconds(startTime);
  const end = parse12hToSeconds(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return "0:00:00";

  let diff = end - start;
  if (diff < 0) diff += 24 * 3600;

  return secondsToHMS(diff);
}

function getIdleTime(startTime, endTime) {
  const start = parse12hToSeconds(startTime);
  const end = parse12hToSeconds(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return "0:00:00";

  let shiftStart = start;
  let shiftEnd = end;
  if (shiftEnd < shiftStart) shiftEnd += 24 * 3600;

  const total = shiftEnd - shiftStart;

  const winStart = 8 * 3600;
  const winEnd = 22 * 3600;

  const windows = [
    { a: winStart, b: winEnd },
    { a: winStart + 24 * 3600, b: winEnd + 24 * 3600 },
  ];

  let inWindow = 0;
  for (const w of windows) {
    const a = Math.max(shiftStart, w.a);
    const b = Math.min(shiftEnd, w.b);
    if (b > a) inWindow += (b - a);
  }

  const idle = Math.max(0, total - inWindow);
  return secondsToHMS(idle);
}

function getActiveTime(shiftDuration, idleTime) {
  const shiftSec = parseHMSToSeconds(shiftDuration);
  const idleSec = parseHMSToSeconds(idleTime);
  if (Number.isNaN(shiftSec) || Number.isNaN(idleSec)) return "0:00:00";

  return secondsToHMS(Math.max(0, shiftSec - idleSec));
}

function metQuota(date, activeTime) {
  if (!isValidDateStr(date)) return false;

  const activeSec = parseHMSToSeconds(activeTime);
  if (Number.isNaN(activeSec)) return false;

  return activeSec >= quotaSecondsForDate(date);
}

function shiftExists(textFile, driverID, date) {
  const lines = readLinesSafe(textFile);
  for (const line of lines) {
    const obj = parseShiftLineCSV(line);
    if (!obj) continue;
    if (obj.driverID === driverID && obj.date === date) return true;
  }
  return false;
}

function addShiftRecord(textFile, shiftObj) {
  if (!shiftObj || typeof shiftObj !== "object") return {};

  const { driverID, driverName, date, startTime, endTime } = shiftObj;

  if (
    typeof driverID !== "string" || driverID.trim() === "" ||
    typeof driverName !== "string" || driverName.trim() === "" ||
    !isValidDateStr(date) ||
    typeof startTime !== "string" || typeof endTime !== "string"
  ) {
    return {};
  }

  const cleanDriverID = driverID.trim();
  const cleanDate = date.trim();

  if (shiftExists(textFile, cleanDriverID, cleanDate)) return {};

  const shiftDuration = getShiftDuration(startTime, endTime);
  const idleTime = getIdleTime(startTime, endTime);
  const activeTime = getActiveTime(shiftDuration, idleTime);
  const quotaMet = metQuota(cleanDate, activeTime);

  const record = {
    driverID: cleanDriverID,
    driverName: driverName.trim(),
    date: cleanDate,
    startTime: startTime.trim(),
    endTime: endTime.trim(),
    shiftDuration,
    idleTime,
    activeTime,
    metQuota: quotaMet,
    hasBonus: false,
  };

  const exists = fs.existsSync(textFile);
  const isEmpty = !exists || fs.readFileSync(textFile, "utf8").trim().length === 0;

  if (isEmpty) {
    fs.appendFileSync(
      textFile,
      "DriverID,DriverName,Date,StartTime,EndTime,ShiftDuration,IdleTime,ActiveTime,MetQuota,HasBonus\n",
      "utf8"
    );
  }

  fs.appendFileSync(textFile, serializeShiftLineCSV(record) + "\n", "utf8");
  return record;
}

function setBonus(textFile, driverID, date, newValue) {
  const lines = readLinesSafe(textFile);
  if (lines.length === 0) return;

  const updated = [];
  for (const line of lines) {
    const obj = parseShiftLineCSV(line);

    if (!obj) {
      updated.push(line);
      continue;
    }

    if (obj.driverID === driverID && obj.date === date) {
      obj.hasBonus = !!newValue;
      updated.push(serializeShiftLineCSV(obj));
    } else {
      updated.push(line);
    }
  }

  fs.writeFileSync(textFile, updated.join("\n") + "\n", "utf8");
}

function countBonusPerMonth(textFile, driverID, month) {
  const m = parseInt(String(month).trim(), 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return -1;

  const lines = readLinesSafe(textFile);
  let foundDriver = false;
  let count = 0;

  for (const line of lines) {
    const obj = parseShiftLineCSV(line);
    if (!obj) continue;

    if (obj.driverID === driverID) {
      foundDriver = true;
      if (monthFromDate(obj.date) === m && obj.hasBonus === true) {
        count++;
      }
    }
  }

  return foundDriver ? count : -1;
}

function getTotalActiveHoursPerMonth(textFile, driverID, month) {
  const m = Number(month);
  if (!Number.isFinite(m) || m < 1 || m > 12) return "0:00:00";

  const lines = readLinesSafe(textFile);
  let totalSeconds = 0;

  for (const line of lines) {
    const obj = parseShiftLineCSV(line);
    if (!obj) continue;
    if (obj.driverID !== driverID) continue;
    if (monthFromDate(obj.date) !== m) continue;

    const sec = parseHMSToSeconds(obj.activeTime);
    if (!Number.isNaN(sec)) totalSeconds += sec;
  }

  return secondsToHMS(totalSeconds);
}

function getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month) {
  const m = Number(month);
  if (!Number.isFinite(m) || m < 1 || m > 12) return "0:00:00";

  const rateRow = getRateRow(rateFile, driverID);
  if (!rateRow) return "0:00:00";

  const lines = readLinesSafe(textFile);
  let requiredSeconds = 0;

  for (const line of lines) {
    const obj = parseShiftLineCSV(line);
    if (!obj) continue;
    if (obj.driverID !== driverID) continue;
    if (monthFromDate(obj.date) !== m) continue;

    requiredSeconds += quotaSecondsForDate(obj.date);
  }

  const bc = Number.isFinite(bonusCount) ? Math.max(0, Math.floor(bonusCount)) : 0;
 requiredSeconds = Math.max(0, requiredSeconds - (bc * 2 * 3600));

  return secondsToHMS(requiredSeconds);
}

function getNetPay(driverID, actualHours, requiredHours, rateFile) {
  const actualSec = parseHMSToSeconds(actualHours);
  const requiredSec = parseHMSToSeconds(requiredHours);
  if (Number.isNaN(actualSec) || Number.isNaN(requiredSec)) return 0;

  const rateRow = getRateRow(rateFile, driverID);
  if (!rateRow) return 0;

  const basePay = rateRow.basePay;
  const tier = rateRow.tier;

  const missingSec = Math.max(0, requiredSec - actualSec);
  let missingHours = Math.floor(missingSec / 3600);

  const allowance = getTierAllowanceHours(tier);
  missingHours = Math.max(0, missingHours - allowance);

  const deductionRatePerHour = Math.floor(basePay / 185);
  const salaryDeduction = missingHours * deductionRatePerHour;

  return Math.max(0, Math.trunc(basePay - salaryDeduction));
}

module.exports = {
  getShiftDuration,
  getIdleTime,
  getActiveTime,
  metQuota,
  addShiftRecord,
  setBonus,
  countBonusPerMonth,
  getTotalActiveHoursPerMonth,
  getRequiredHoursPerMonth,
  getNetPay,
} 

