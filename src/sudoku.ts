import type { ConflictMap, Digit, Notes, Puzzle } from './types';

export const DIGITS: Digit[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const rowOf = (index: number) => Math.floor(index / 9);
export const colOf = (index: number) => index % 9;
export const boxOf = (index: number) => Math.floor(rowOf(index) / 3) * 3 + Math.floor(colOf(index) / 3);

export function boardValue(puzzle: Puzzle, index: number): Digit {
  return puzzle.givens[index] || puzzle.entries[index];
}

export function boardValues(puzzle: Puzzle): Digit[] {
  return puzzle.givens.map((given, index) => given || puzzle.entries[index]);
}

export function peerIndexes(index: number): number[] {
  const peers = new Set<number>();
  const row = rowOf(index);
  const col = colOf(index);
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;
  for (let i = 0; i < 9; i += 1) {
    peers.add(row * 9 + i);
    peers.add(i * 9 + col);
  }
  for (let y = boxRow; y < boxRow + 3; y += 1) {
    for (let x = boxCol; x < boxCol + 3; x += 1) peers.add(y * 9 + x);
  }
  peers.delete(index);
  return [...peers];
}

/** Cells where a selected digit can no longer be placed. */
export function blockedByDigit(puzzle: Puzzle, digit: Digit): Set<number> {
  if (!digit) return new Set();
  const blocked = new Set<number>();
  boardValues(puzzle).forEach((value, index) => {
    if (value === digit) peerIndexes(index).forEach((peer) => blocked.add(peer));
  });
  return blocked;
}

export function conflicts(puzzle: Puzzle): ConflictMap {
  const values = boardValues(puzzle);
  const result = new Set<number>();
  for (let index = 0; index < 81; index += 1) {
    const value = values[index];
    if (!value) continue;
    for (const peer of peerIndexes(index)) {
      if (values[peer] === value) {
        result.add(index);
        result.add(peer);
      }
    }
  }
  return result;
}

export function candidates(puzzle: Puzzle, index: number): Digit[] {
  if (boardValue(puzzle, index)) return [];
  const used = new Set(peerIndexes(index).map((peer) => boardValue(puzzle, peer)));
  return DIGITS.filter((digit) => !used.has(digit));
}

export function canPlace(puzzle: Puzzle, index: number, value: Digit): boolean {
  return value === 0 || !peerIndexes(index).some((peer) => boardValue(puzzle, peer) === value);
}

export function setEntry(puzzle: Puzzle, index: number, value: Digit): Puzzle {
  if (puzzle.givens[index] || (puzzle.entries[index] !== 0 && value !== 0) || !canPlace(puzzle, index, value)) return puzzle;
  const entries = [...puzzle.entries];
  entries[index] = value;
  const notes: Notes = { ...puzzle.notes };
  delete notes[index];
  return { ...puzzle, entries, notes, updatedAt: new Date().toISOString() };
}

export function setGiven(puzzle: Puzzle, index: number, value: Digit): Puzzle {
  if ((puzzle.givens[index] !== 0 && value !== 0) || !canPlace(puzzle, index, value)) return puzzle;
  const givens = [...puzzle.givens];
  const entries = [...puzzle.entries];
  givens[index] = value;
  entries[index] = 0;
  return { ...puzzle, givens, entries, updatedAt: new Date().toISOString() };
}

export function toggleNote(puzzle: Puzzle, index: number, digit: Digit): Puzzle {
  if (boardValue(puzzle, index) || !digit) return puzzle;
  const current = new Set(puzzle.notes[index] ?? []);
  current.has(digit) ? current.delete(digit) : current.add(digit);
  const notes = { ...puzzle.notes, [index]: [...current].sort() as Digit[] };
  return { ...puzzle, notes, updatedAt: new Date().toISOString() };
}

export function isComplete(puzzle: Puzzle): boolean {
  return boardValues(puzzle).every(Boolean) && conflicts(puzzle).size === 0;
}

export function isValidGrid(values: unknown): values is Digit[] {
  return Array.isArray(values) && values.length === 81 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 9);
}
