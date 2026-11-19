import { makeBook, makePuzzle, type Backup, type Book, type Digit, type Notes, type Puzzle } from './types';
import { isValidGrid } from './sudoku';

const DB_NAME = 'sudoku-camera-web';
const STORE = 'state';
const KEY = 'books';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadBooks(): Promise<Book[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBooks(books: Book[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('端末への保存に失敗しました。'));
    transaction.objectStore(STORE).put(books, KEY);
  });
}

export function exportBackup(books: Book[]): Backup {
  return { format: 'sudoku-web/v1', exportedAt: new Date().toISOString(), books };
}

function isNotes(value: unknown): value is Notes {
  return !!value && typeof value === 'object' && Object.entries(value).every(([index, digits]) =>
    Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 81 &&
    Array.isArray(digits) && digits.every((digit) => Number.isInteger(digit) && digit >= 1 && digit <= 9));
}

function validatePuzzle(value: unknown): value is Puzzle {
  if (!value || typeof value !== 'object') return false;
  const puzzle = value as Puzzle;
  return typeof puzzle.id === 'string' && typeof puzzle.title === 'string' && isValidGrid(puzzle.givens) &&
    isValidGrid(puzzle.entries) && isNotes(puzzle.notes) && typeof puzzle.createdAt === 'string' && typeof puzzle.updatedAt === 'string';
}

export function parseBackup(text: string): Book[] {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('JSON の形式が正しくありません。');
  const backup = data as Backup;
  if (backup.format !== 'sudoku-web/v1' || !Array.isArray(backup.books)) throw new Error('対応していないバックアップ形式です。');
  if (!backup.books.every((book) => typeof book.id === 'string' && typeof book.name === 'string' && Array.isArray(book.puzzles) && book.puzzles.every(validatePuzzle))) {
    throw new Error('問題データに不正な値があります。');
  }
  return backup.books;
}

export function addImportedBooks(books: Book[], imported: Book[]): { books: Book[]; addedBooks: number; addedPuzzles: number } {
  const merged = [...books];
  const bookIndexes = new Map(books.map((book, index) => [book.id, index]));
  const puzzleIds = new Set(books.flatMap((book) => book.puzzles.map((puzzle) => puzzle.id)));
  let addedBooks = 0;
  let addedPuzzles = 0;

  for (const book of imported) {
    const newPuzzles = book.puzzles.filter((puzzle) => {
      if (puzzleIds.has(puzzle.id)) return false;
      puzzleIds.add(puzzle.id);
      return true;
    });
    if (!newPuzzles.length) continue;

    const index = bookIndexes.get(book.id);
    if (index === undefined) {
      bookIndexes.set(book.id, merged.length);
      merged.push({ ...book, puzzles: newPuzzles });
      addedBooks++;
    } else {
      const existing = merged[index];
      merged[index] = { ...existing, puzzles: [...existing.puzzles, ...newPuzzles] };
    }
    addedPuzzles += newPuzzles.length;
  }

  return { books: merged, addedBooks, addedPuzzles };
}

export function legacyCsvToPuzzle(text: string, title = '取り込み問題'): Puzzle {
  const values = text.trim().split(/\r?\n/).flatMap((row) => row.split(',').map((item) => Number(item.trim())));
  if (!isValidGrid(values)) throw new Error('旧形式は 9 行 × 9 数字の CSV にしてください。');
  const puzzle = makePuzzle(title);
  puzzle.givens = values as Digit[];
  return puzzle;
}

export function initialBooks(): Book[] {
  const book = makeBook('マイ問題集');
  book.puzzles.push(makePuzzle('問題 1'));
  return [book];
}
