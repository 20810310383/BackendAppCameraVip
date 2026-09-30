const ansi = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  gray: '\u001B[90m',
};

const colorsEnabled = process.env.NO_COLOR !== '1';

const areaLabels = {
  HTTP: 'API',
  SYSTEM: 'HỆ THỐNG',
  MONGO: 'CƠ SỞ DỮ LIỆU',
  EMAIL: 'EMAIL',
  CHESS: 'CỜ VUA',
  SOCKET: 'THỜI GIAN THỰC',
  MAP: 'BẢN ĐỒ',
};

function paint(value, ...styles) {
  if (!colorsEnabled) return value;
  return `${styles.join('')}${value}${ansi.reset}`;
}

function timestamp() {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

function write(icon, area, message, color = ansi.cyan) {
  const time = paint(timestamp(), ansi.gray);
  const label = areaLabels[area] || area.toUpperCase();
  const badge = paint(` ${icon} ${label} `, ansi.bold, color);
  console.log(`${time} ${badge} ${message}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export const log = {
  info: (area, message) => write('•', area, message, ansi.cyan),
  success: (area, message) => write('✓', area, message, ansi.green),
  warn: (area, message) => write('!', area, message, ansi.yellow),
  error: (area, message) => write('×', area, message, ansi.red),
  event: (area, message) => write('↗', area, message, ansi.magenta),
  failure: (area, error) => write('×', area, errorMessage(error), ansi.red),
};

export function startupBanner({ port, databaseReady }) {
  const line = paint('═'.repeat(55), ansi.magenta);
  const title = paint('  ✦  BOARDVERSE BACKEND  ✦', ansi.bold, ansi.magenta);
  const api = paint(`http://0.0.0.0:${port}`, ansi.bold, ansi.cyan);
  const database = databaseReady ? paint('MongoDB đã kết nối', ansi.green) : paint('Chế độ bộ nhớ tạm', ansi.yellow);
  console.log(`\n${line}\n${title}\n${line}\n  Máy chủ       ${api}\n  Lưu trữ       ${database}\n${line}`);
}
