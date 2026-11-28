/**
 * 接口路径归一化。
 *
 * Git Bash / MSYS 会把以 `/` 开头的参数改写成 Windows 路径，例如
 * `/pcb/order/create` → `C:/Program Files/Git/pcb/order/create`。
 * 这里只修正“命令行参数 → 接口路径”的映射；签名仍使用接口的原始拼写。
 */

export interface SplitApiPath {
  path: string;
  query: string;
}

export interface NormalizedApiPath extends SplitApiPath {
  rewritten: boolean;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function msysRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = trimTrailingSlash(toPosix(value));
    if (!normalized) return;
    roots.add(normalized);
    // EXEPATH 常见为 C:/Program Files/Git/bin，父目录才是 Git 根。
    const parent = normalized.replace(/\/(?:bin|usr\/bin|mingw64\/bin)$/i, "");
    if (parent !== normalized) roots.add(parent);
  };

  add(env.MINGW_PREFIX);
  add(env.MSYSTEM_PREFIX);
  add(env.EXEPATH);

  const driveRoots = [
    "C:/Program Files/Git",
    "C:/Program Files (x86)/Git",
    "D:/Program Files/Git",
    "D:/Program Files (x86)/Git",
    "C:/Git",
    "D:/Git",
  ];
  for (const root of driveRoots) roots.add(root);

  const posixRoots = [
    "/c/Program Files/Git",
    "/c/Program Files (x86)/Git",
    "/d/Program Files/Git",
    "/d/Program Files (x86)/Git",
    "/mingw64",
    "/usr",
  ];
  for (const root of posixRoots) roots.add(root);

  return Array.from(roots).sort((a, b) => b.length - a.length);
}

function stripKnownRoot(value: string, roots: readonly string[]): string | undefined {
  const lower = value.toLowerCase();
  for (const root of roots) {
    const rootLower = root.toLowerCase();
    if (lower === rootLower) return "/";
    if (lower.startsWith(`${rootLower}/`)) {
      return value.slice(root.length);
    }
  }
  return undefined;
}

/** 只拆分 query，不做 URL 解码。 */
export function splitApiPath(raw: string): SplitApiPath {
  const normalized = toPosix(raw);
  const index = normalized.indexOf("?");
  if (index < 0) return { path: normalized, query: "" };
  return {
    path: normalized.slice(0, index),
    query: normalized.slice(index + 1),
  };
}

/** 去掉常见的 MSYS/Git Bash 路径前缀。 */
export function stripMsysPrefix(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const { path: input, query } = splitApiPath(raw);
  let value = input;

  // MSYS 用 `//foo` 表示“不要改写为 Windows 路径”。
  if (value.startsWith("//")) value = value.slice(1);

  const roots = msysRoots(env);
  const stripped = stripKnownRoot(value, roots);
  if (stripped !== undefined) value = stripped;

  if (!value.startsWith("/") && !/^[A-Za-z]:\//.test(value)) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  return query ? `${value}?${query}` : value;
}

function suffixMatch(value: string, knownPaths: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const known of knownPaths) {
    if (!known.startsWith("/")) continue;
    if (value.endsWith(known)) {
      if (!best || known.length > best.length) best = known;
    }
  }
  return best;
}

/**
 * 归一化接口路径。
 *
 * - 先拆 query；
 * - 剥离 MSYS/Git Bash 前缀；
 * - 对仍然像 Windows 绝对路径的输入，用已知接口路径做后缀匹配；
 * - 保证以 `/` 开头，折叠多余斜杠；
 * - 不做 URL 解码，保留签名所需的原始拼写。
 */
export function normalizeApiPath(
  raw: string,
  opts: { env?: NodeJS.ProcessEnv; knownPaths?: readonly string[] } = {},
): NormalizedApiPath {
  const { path: input, query } = splitApiPath(raw);
  const stripped = stripMsysPrefix(input, opts.env ?? process.env);
  const strippedParts = splitApiPath(stripped);
  let path = strippedParts.path;
  let rewritten = path !== input;

  if (/^[A-Za-z]:\//.test(path) && opts.knownPaths && opts.knownPaths.length > 0) {
    const matched = suffixMatch(path, opts.knownPaths);
    if (matched) {
      path = matched;
      rewritten = true;
    }
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized !== path) rewritten = true;
  return {
    path: normalized.replace(/\/{2,}/g, "/"),
    query,
    rewritten,
  };
}

/** 命令行位置参数 → 接口路径。 */
export function normalizePathArg(
  raw: string,
  knownPaths: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return normalizeApiPath(raw, { env, knownPaths }).path;
}
