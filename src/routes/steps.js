import { Router } from 'express';
import { Session } from '../models/Session.js';
import { StepDaily } from '../models/StepDaily.js';
import { User } from '../models/User.js';
import { hashSessionToken } from '../services/session-service.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SYNC_DAYS = 31;
const MAX_HISTORY_DAYS = 92;
const MAX_STEPS_PER_DAY = 300000;
// Average adult stride. Only ever used to derive the displayed distance
// estimate shown alongside the measured step count.
const METERS_PER_STEP = 0.75;

function extractBearerToken(request) {
  const authorization = request.get('authorization') || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : '';
}

async function authenticatedUser(request, response) {
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập không hợp lệ.' });
    return null;
  }
  const session = await Session.findOne({
    accessTokenHash: hashSessionToken(accessToken),
    accessTokenExpiresAt: { $gt: new Date() },
  });
  if (!session) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập đã hết hạn.' });
    return null;
  }
  const user = await User.findById(session.userId);
  if (!user) {
    response.status(401).json({ code: 'SESSION_INVALID', message: 'Tài khoản không còn tồn tại.' });
    return null;
  }
  return user;
}

function unavailable(response) {
  return response.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu đang tạm thời không khả dụng.' });
}

function validationError(response, message) {
  return response.status(422).json({ code: 'VALIDATION_ERROR', message });
}

/** Local calendar day of `date` as "YYYY-MM-DD", matching how the client keys its days. */
function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidDateKey(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function optionalBoundedNumber(value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(minimum, value));
}

function optionalDate(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Validates one client day. Returns null for records we deliberately do not
 * store: a local record is only created from a device reading. In particular,
 * zero is valid when iOS Core Motion explicitly reports zero for a day.
 */
function validateDay(raw, todayKey) {
  if (!raw || typeof raw !== 'object') return null;
  const { date, steps } = raw;
  if (!isValidDateKey(date)) return null;
  if (typeof steps !== 'number' || !Number.isFinite(steps) || !Number.isInteger(steps)) return null;
  if (steps < 0 || steps > MAX_STEPS_PER_DAY) return null;
  // A device clock skewed into the future must not seed days that never happened.
  if (date > todayKey) return null;

  const sources = Array.isArray(raw.sources)
    ? [...new Set(raw.sources.filter((source) => typeof source === 'string' && source.length <= 40))].slice(0, 4)
    : [];
  const distanceMeters = optionalBoundedNumber(raw.distanceMeters, 0, 400000);
  return {
    date,
    steps,
    distanceMeters: distanceMeters ?? Math.round(steps * METERS_PER_STEP),
    activeMinutes: optionalBoundedNumber(raw.activeMinutes, 0, 1440),
    firstStepAt: optionalDate(raw.firstStepAt),
    lastStepAt: optionalDate(raw.lastStepAt),
    sources,
  };
}

function serializeDay(document) {
  return {
    date: document.date,
    steps: document.steps,
    // These are derived/optional details. The persisted, authoritative value
    // is `steps`; calculate distance from that final total so an older device
    // can never overwrite it while `$max` preserves a newer count.
    distanceMeters: Math.round(document.steps * METERS_PER_STEP),
    activeMinutes: null,
    firstStepAt: null,
    lastStepAt: null,
    sources: document.sources ?? [],
  };
}

export function createStepsRouter({ isDatabaseReady }) {
  const router = Router();

  router.get('/steps/daily', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;

      const todayKey = dateKey(new Date());
      const to = isValidDateKey(request.query.to) ? request.query.to : todayKey;
      if (!isValidDateKey(request.query.from)) {
        return validationError(response, 'Ngày bắt đầu không hợp lệ.');
      }
      const from = request.query.from;
      if (from > to) return validationError(response, 'Khoảng ngày không hợp lệ.');

      const spanDays = Math.round(
        (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000,
      ) + 1;
      if (spanDays > MAX_HISTORY_DAYS) {
        return validationError(response, `Chỉ xem được tối đa ${MAX_HISTORY_DAYS} ngày mỗi lần.`);
      }

      // Days with no document are simply absent: the client renders them as
      // "no data" rather than as a measured zero.
      const days = await StepDaily.find({ userId: user._id, date: { $gte: from, $lte: to } })
        .sort({ date: 1 })
        .lean();

      return response.json({ days: days.map(serializeDay), from, to });
    } catch (error) {
      console.error('Get daily steps failed:', error);
      return response.status(500).json({ code: 'GET_STEPS_FAILED', message: 'Không thể tải thống kê bước chân.' });
    }
  });

  router.post('/steps/sync', async (request, response) => {
    if (!isDatabaseReady()) return unavailable(response);
    try {
      const user = await authenticatedUser(request, response);
      if (!user) return;

      const rawDays = request.body?.days;
      if (!Array.isArray(rawDays)) return validationError(response, 'Dữ liệu bước chân không hợp lệ.');
      if (rawDays.length > MAX_SYNC_DAYS) {
        return validationError(response, `Chỉ đồng bộ tối đa ${MAX_SYNC_DAYS} ngày mỗi lần.`);
      }

      const todayKey = dateKey(new Date());
      const byDate = new Map();
      for (const raw of rawDays) {
        const day = validateDay(raw, todayKey);
        // The device sends cumulative totals, so when two records land on the
        // same day in one payload, the larger total is the more recent one.
        if (day && (!byDate.has(day.date) || byDate.get(day.date).steps < day.steps)) {
          byDate.set(day.date, day);
        }
      }

      if (!byDate.size) return response.json({ days: [], synced: 0 });

      // $max (not $inc) makes syncing idempotent: the client always sends the
      // day's cumulative total, so re-sending it can never double-count, and a
      // stale device can never overwrite a higher total already on the server.
      await StepDaily.bulkWrite(
        [...byDate.values()].map((day) => ({
          updateOne: {
            filter: { userId: user._id, date: day.date },
            update: {
              $max: { steps: day.steps },
              $addToSet: { sources: { $each: day.sources } },
              $setOnInsert: { userId: user._id, date: day.date },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      const stored = await StepDaily.find({ userId: user._id, date: { $in: [...byDate.keys()] } })
        .sort({ date: 1 })
        .lean();

      return response.json({ days: stored.map(serializeDay), synced: stored.length });
    } catch (error) {
      console.error('Sync daily steps failed:', error);
      return response.status(500).json({ code: 'SYNC_STEPS_FAILED', message: 'Không thể đồng bộ bước chân.' });
    }
  });

  return router;
}
