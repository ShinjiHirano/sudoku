export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type Notes = Record<number, Digit[]>;

export interface Puzzle {
  id: string;
  title: string;
  givens: Digit[];
  entries: Digit[];
  notes: Notes;
  createdAt: string;
  updatedAt: string;
}

export interface Book {
  id: string;
  name: string;
  puzzles: Puzzle[];
}

export interface Backup {
  format: 'sudoku-web/v1';
  exportedAt: string;
  books: Book[];
}

export type ConflictMap = Set<number>;

export const EMPTY_BOARD = (): Digit[] => Array<Digit>(81).fill(0);

export function makeId(): string {
  return crypto.randomUUID();
}

export function makePuzzle(title = '新しい問題'): Puzzle {
  const now = new Date().toISOString();
  return { id: makeId(), title, givens: EMPTY_BOARD(), entries: EMPTY_BOARD(), notes: {}, createdAt: now, updatedAt: now };
}

export function makeBook(name = 'マイ問題集'): Book {
  return { id: makeId(), name, puzzles: [] };
}
