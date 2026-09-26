export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export function normalizeUsername(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function usernameIsValid(username) {
  return USERNAME_PATTERN.test(username);
}

function usernameBase(value) {
  const normalized = normalizeUsername(value)
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'user').slice(0, 20).padEnd(3, '0');
}

export async function findAvailableUsername(UserModel, source) {
  const base = usernameBase(source);

  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const postfix = suffix === 0 ? '' : String(suffix + 1);
    const candidate = `${base.slice(0, 24 - postfix.length)}${postfix}`;
    if (!(await UserModel.exists({ username: candidate }))) return candidate;
  }

  throw new Error('Không thể tạo username khả dụng.');
}
