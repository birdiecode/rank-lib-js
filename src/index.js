/**
 * rank-lib-js - deterministic combinatorial indexing of strings by mask.
 * Counting and unranking use one epsilon-NFA -> lazy DFA -> memoized DP.
 * As DFA states represent sets of NFA states, duplicate strings are counted once.
 * Ordering: increasing Unicode code-point length, then character order from the
 * first appearance in mask alphabets (not Unicode collation order).
 * All indices and counts use BigInt. Length is Unicode code points, not UTF-8 bytes.
 */
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SPECIAL = Array.from({length: 95}, (_, i) => String.fromCharCode(i + 32))
  .filter(ch => !LOWER.includes(ch) && !UPPER.includes(ch) && !DIGITS.includes(ch)).join("");
const STANDARD = Object.freeze({
  l: LOWER, u: UPPER, d: DIGITS,
  s: SPECIAL, a: LOWER + UPPER + DIGITS + SPECIAL,
  h: DIGITS + "abcdef", H: DIGITS + "ABCDEF"
});
const MAX_LENGTH = 128;
const MAX_NFA_STATES = 1500;
const MAX_DFA_STATES = 10000;
const MAX_MEMO_ENTRIES = 250000;

const unique = iterable => [...new Set(iterable)];

function parseMask(mask, custom = {}) {
  const input = [...mask];
  const result = [];
  let i = 0;
  while (i < input.length) {
    let chars;
    if (input[i] === "?") {
      i++;
      if (i >= input.length) throw new Error("После ? ожидается имя набора или второй ?");
      const name = input[i++];
      if (name === "?") {
        chars = ["?"];
      } else {
        const value = Object.prototype.hasOwnProperty.call(custom, name)
          ? custom[name] : STANDARD[name];
        if (typeof value !== "string") throw new Error("Неизвестный набор: ?" + name);
        chars = unique([...value]);
      }
    } else if (input[i] === "[") {
      i++;
      const resultChars = [];
      let closed = false;
      function readAtom() {
        if (i >= input.length) throw new Error("Незакрытый символьный набор [...]");
        if (input[i] === "\\") {
          i++;
          if (i >= input.length) throw new Error("Неоконченная escape-последовательность");
        }
        return input[i++];
      }
      while (i < input.length) {
        if (input[i] === "]") {
          i++;
          closed = true;
          break;
        }
        const first = readAtom();
        if (input[i] === "-" && i + 1 < input.length && input[i + 1] !== "]") {
          i++;
          const last = readAtom();
          const start = first.codePointAt(0), end = last.codePointAt(0);
          if (start > end || end - start > 10000)
            throw new Error("Недопустимый диапазон символов: " + first + "-" + last);
          for (let p = start; p <= end; p++) resultChars.push(String.fromCodePoint(p));
        } else {
          resultChars.push(first);
        }
      }
      if (!closed) throw new Error("Незакрытый набор [...]");
      chars = unique(resultChars);
    } else if (input[i] === "\\") {
      i++;
      if (i >= input.length) throw new Error("Обратный слеш в конце маски");
      chars = [input[i++]];
    } else {
      chars = [input[i++]];
    }
    if (chars.length === 0) throw new Error("Пустой набор символов");

    let min = 1, max = 1;
    if (input[i] === "{") {
      i++;
      let content = "";
      while (i < input.length && input[i] !== "}") content += input[i++];
      if (i >= input.length) throw new Error("Незакрытый квантификатор {...}");
      i++;
      const match = /^(\d+)(?:,(\d+))?$/.exec(content);
      if (!match) throw new Error("Некорректный квантификатор: {" + content + "}");
      min = Number(match[1]);
      max = match[2] === undefined ? min : Number(match[2]);
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min || max > MAX_LENGTH)
        throw new Error("Число повторений должно быть от 0 до " + MAX_LENGTH + ", минимум ≤ максимум");
    }
    result.push({chars, min, max});
  }
  const minLength = result.reduce((sum, t) => sum + t.min, 0);
  const maxLength = result.reduce((sum, t) => sum + t.max, 0);
  if (maxLength > MAX_LENGTH) throw new Error("Максимальная длина превышает " + MAX_LENGTH + " символов");
  return {tokens: result, minLength, maxLength};
}

export function compileMask(mask, custom = {}) {
  const {tokens, minLength, maxLength} = parseMask(mask, custom);
  const alphabet = unique(tokens.flatMap(t => t.chars));
  const nfa = [];
  function newState() {
    if (nfa.length >= MAX_NFA_STATES) throw new Error("Слишком сложная маска (NFA)");
    nfa.push({eps:[], moves:[]});
    return nfa.length - 1;
  }
  const start = newState();
  let previous = start;
  for (const token of tokens) {
    const end = newState();
    const charSet = new Set(token.chars);
    let current = previous;
    for (let r = 0; r <= token.max; r++) {
      if (r >= token.min) nfa[current].eps.push(end);
      if (r < token.max) {
        const next = newState();
        nfa[current].moves.push({chars: charSet, to: next});
        current = next;
      }
    }
    previous = end;
  }
  const accept = previous;
  const dfaCache = new Map();
  let statesCreated = 0;
  function closure(ids) {
    const seen = new Set(ids);
    const stack = [...seen];
    while (stack.length) {
      const s = stack.pop();
      for (const next of nfa[s].eps) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    return [...seen].sort((a,b)=>a-b);
  }
  function getState(ids) {
    const key = ids.join(",");
    if (dfaCache.has(key)) return dfaCache.get(key);
    if (++statesCreated > MAX_DFA_STATES) throw new Error("Слишком сложная маска (DFA)");
    const state = {key, ids, accepted: ids.includes(accept), transitions: new Map()};
    dfaCache.set(key, state);
    return state;
  }
  const root = getState(closure([start]));
  function step(state, ch) {
    if (state.transitions.has(ch)) return state.transitions.get(ch);
    const ids = new Set();
    for (const node of state.ids) {
      for (const edge of nfa[node].moves) {
        if (edge.chars.has(ch)) ids.add(edge.to);
      }
    }
    const next = ids.size ? getState(closure(ids)) : null;
    state.transitions.set(ch, next);
    return next;
  }
  const memo = new Map();
  function countExact(state, remaining) {
    if (remaining === 0) return state.accepted ? 1n : 0n;
    const key = state.key + ":" + remaining;
    if (memo.has(key)) return memo.get(key);
    if (memo.size > MAX_MEMO_ENTRIES) throw new Error("Слишком сложная маска (лимит вычислений)");
    let total = 0n;
    for (const ch of alphabet) {
      const next = step(state, ch);
      if (next !== null) total += countExact(next, remaining - 1);
    }
    memo.set(key, total);
    return total;
  }
  const countsByLength = [];
  let total = 0n;
  for (let len = minLength; len <= maxLength; len++) {
    const n = countExact(root, len);
    countsByLength.push(n);
    total += n;
  }
  function at(index) {
    if (typeof index !== "bigint") throw new TypeError("Индекс должен быть BigInt");
    if (index < 0n || index >= total) throw new RangeError("Индекс вне диапазона: 0 .. " + (total - 1n));
    let len = minLength;
    for (const n of countsByLength) {
      if (index < n) break;
      index -= n;
      len++;
    }
    let state = root, output = "";
    for (let remain = len; remain > 0; remain--) {
      let selected = false;
      for (const ch of alphabet) {
        const next = step(state, ch);
        if (next === null) continue;
        const n = countExact(next, remain - 1);
        if (index >= n) { index -= n; continue; }
        output += ch;
        state = next;
        selected = true;
        break;
      }
      if (!selected) throw new Error("Внутренняя ошибка индексации");
    }
    if (!state.accepted) throw new Error("Внутренняя ошибка завершения");
    return output;
  }
  return {total, at, minLength, maxLength};
}

// Two public functions that share the same compiler:
export function count(mask, custom = {}) {
  return compileMask(mask, custom).total;
}
export function generate(mask, index, custom = {}) {
  return compileMask(mask, custom).at(index);
}
