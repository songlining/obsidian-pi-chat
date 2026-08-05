/**
 * Tiny word-level diff (LCS) with no dependencies, for rendering edit
 * tool-call previews in the chat (old → new).
 */

export interface DiffToken {
  text: string;
  changed: boolean;
}

export interface WordDiff {
  old: DiffToken[];
  new: DiffToken[];
}

interface Token {
  word: string;
  sep: string;
}

/** Split text into word tokens, each keeping the whitespace that follows it. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\S+)(\s*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ word: match[1], sep: match[2] });
  }
  return tokens;
}

/**
 * Word-level diff via LCS (dynamic programming). Returns aligned old/new
 * token streams; tokens that differ carry `changed: true`.
 */
export function wordDiff(oldText: string, newText: string): WordDiff {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].word === b[j].word ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const old: DiffToken[] = [];
  const next: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].word === b[j].word) {
      old.push({ text: a[i].word + a[i].sep, changed: false });
      next.push({ text: b[j].word + b[j].sep, changed: false });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      old.push({ text: a[i].word + a[i].sep, changed: true });
      i++;
    } else {
      next.push({ text: b[j].word + b[j].sep, changed: true });
      j++;
    }
  }
  while (i < n) {
    old.push({ text: a[i].word + a[i].sep, changed: true });
    i++;
  }
  while (j < m) {
    next.push({ text: b[j].word + b[j].sep, changed: true });
    j++;
  }
  return { old, new: next };
}

/** True when any token differs between the two sides. */
export function hasDiff(diff: WordDiff): boolean {
  return diff.old.some((t) => t.changed) || diff.new.some((t) => t.changed);
}
