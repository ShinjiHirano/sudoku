import { makeBook, makePuzzle, type Backup, type Book, type Digit, type Notes, type Puzzle } from './types';
import { isValidGrid } from './sudoku';

const DB_NAME = 'sudoku-camera-web';
const BOOKS = 'books';
const PUZZLES = 'puzzles';
const LEGACY_STORE = 'state';
const BY_BOOK = 'bookKey';
const BY_PUZZLE_ID = 'puzzleId';
const LIBRARY = [BOOKS, PUZZLES];

export interface BookSummary {
  key: number;
  id: string;
  name: string;
}

export interface SavedPuzzle {
  key: number;
  bookKey: number;
  puzzle: Puzzle;
}

export interface OpenBook extends BookSummary {
  puzzles: SavedPuzzle[];
}

let connection: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('別のタブで数独ノートを閉じてから、このページを再読み込みしてください。'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction!;
      if (blocked) {
        transaction.abort();
        return;
      }
      void migrateLibrary(db, transaction).catch(() => abortTransaction(transaction));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        connection = undefined;
      };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try { transaction.abort(); } catch { /* An already completed or aborted transaction needs no cleanup. */ }
}

async function transact<T>(stores: string | string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(stores, mode);
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('端末内データの処理に失敗しました。'));
  });
  try {
    const [result] = await Promise.all([work(transaction), completed]);
    return result;
  } catch (error) {
    abortTransaction(transaction);
    await completed.catch(() => {});
    throw error;
  }
}

async function migrateLibrary(db: IDBDatabase, transaction: IDBTransaction): Promise<void> {
  const oldBooks = db.objectStoreNames.contains(LEGACY_STORE)
    ? requestResult<Book[] | undefined>(transaction.objectStore(LEGACY_STORE).get(BOOKS))
    : undefined;
  db.createObjectStore(BOOKS, { keyPath: 'key', autoIncrement: true });
  const puzzles = db.createObjectStore(PUZZLES, { keyPath: 'key', autoIncrement: true });
  puzzles.createIndex(BY_BOOK, 'bookKey');
  puzzles.createIndex(BY_PUZZLE_ID, 'puzzle.id');

  const stored = oldBooks ? await oldBooks : undefined;
  const books = stored?.length ? stored : [initialBook()];
  for (const book of books) {
    await insertBook(transaction, book);
  }
  if (oldBooks) db.deleteObjectStore(LEGACY_STORE);
}

function initialBook(name?: string): Book {
  return { ...makeBook(name), puzzles: [makePuzzle('問題 1')] };
}

async function insertBookSummary(transaction: IDBTransaction, { id, name }: Pick<Book, 'id' | 'name'>): Promise<BookSummary> {
  const key = await requestResult(transaction.objectStore(BOOKS).add({ id, name })) as number;
  return { key, id, name };
}

async function insertPuzzle(transaction: IDBTransaction, bookKey: number, puzzle: Puzzle): Promise<SavedPuzzle> {
  const key = await requestResult(transaction.objectStore(PUZZLES).add({ bookKey, puzzle })) as number;
  return { key, bookKey, puzzle };
}

async function insertBook(transaction: IDBTransaction, book: Book): Promise<OpenBook> {
  const summary = await insertBookSummary(transaction, book);
  const puzzles = book.puzzles.length ? book.puzzles : [makePuzzle('問題 1')];
  const saved = await Promise.all(puzzles.map((puzzle) => insertPuzzle(transaction, summary.key, puzzle)));
  return { ...summary, puzzles: saved };
}

function readBookSummaries(transaction: IDBTransaction): Promise<BookSummary[]> {
  return requestResult(transaction.objectStore(BOOKS).getAll());
}

function readBookPuzzles(transaction: IDBTransaction, bookKey: number): Promise<SavedPuzzle[]> {
  return requestResult(transaction.objectStore(PUZZLES).index(BY_BOOK).getAll(bookKey));
}

async function readBookSummary(transaction: IDBTransaction, bookKey: number): Promise<BookSummary> {
  const book = await requestResult<BookSummary | undefined>(transaction.objectStore(BOOKS).get(bookKey));
  if (!book) throw new Error('問題集が見つかりませんでした。');
  return book;
}

export function openLibrary(): Promise<{ bookList: BookSummary[]; book: OpenBook }> {
  return transact(LIBRARY, 'readonly', async (transaction) => {
    const bookList = await readBookSummaries(transaction);
    const first = bookList[0];
    if (!first) throw new Error('端末内の問題集を読み込めませんでした。');
    const puzzles = await readBookPuzzles(transaction, first.key);
    return { bookList, book: { ...first, puzzles } };
  });
}

export function loadBook(bookKey: number): Promise<OpenBook> {
  return transact(LIBRARY, 'readonly', async (transaction) => {
    const [book, puzzles] = await Promise.all([readBookSummary(transaction, bookKey), readBookPuzzles(transaction, bookKey)]);
    return { ...book, puzzles };
  });
}

export function savePuzzle(record: SavedPuzzle): Promise<void> {
  return transact(PUZZLES, 'readwrite', async (transaction) => {
    const puzzles = transaction.objectStore(PUZZLES);
    if (await requestResult(puzzles.getKey(record.key)) === undefined) throw new Error('問題が見つかりませんでした。');
    await requestResult(puzzles.put(record));
  });
}

export function renameBook(bookKey: number, name: string): Promise<BookSummary> {
  return transact(BOOKS, 'readwrite', async (transaction) => {
    const book = { ...await readBookSummary(transaction, bookKey), name };
    await requestResult(transaction.objectStore(BOOKS).put(book));
    return book;
  });
}

export function createBook(name: string): Promise<OpenBook> {
  return transact(LIBRARY, 'readwrite', (transaction) => insertBook(transaction, initialBook(name)));
}

export function addPuzzle(bookKey: number, puzzle: Puzzle): Promise<SavedPuzzle> {
  return transact(LIBRARY, 'readwrite', async (transaction) => {
    await readBookSummary(transaction, bookKey);
    return insertPuzzle(transaction, bookKey, puzzle);
  });
}

export function deletePuzzle(bookKey: number, puzzleKey: number): Promise<SavedPuzzle[]> {
  return transact(PUZZLES, 'readwrite', async (transaction) => {
    const puzzles = await readBookPuzzles(transaction, bookKey);
    const remaining = puzzles.filter(({ key }) => key !== puzzleKey);
    if (remaining.length === puzzles.length) throw new Error('問題が見つかりませんでした。');
    await requestResult(transaction.objectStore(PUZZLES).delete(puzzleKey));
    if (remaining.length === 0) remaining.push(await insertPuzzle(transaction, bookKey, makePuzzle('問題 1')));
    return remaining;
  });
}

export function deleteBook(bookKey: number, expectedPuzzleCount: number): Promise<{ bookList: BookSummary[]; book: OpenBook }> {
  return transact(LIBRARY, 'readwrite', async (transaction) => {
    const bookList = await readBookSummaries(transaction);
    const index = bookList.findIndex(({ key }) => key === bookKey);
    if (index === -1) throw new Error('問題集が見つかりませんでした。');
    bookList.splice(index, 1);
    const puzzles = transaction.objectStore(PUZZLES);
    const keys = await requestResult(puzzles.index(BY_BOOK).getAllKeys(bookKey));
    if (keys.length !== expectedPuzzleCount) throw new Error('問題数が変わりました。問題集を開き直してから削除してください。');
    await Promise.all(keys.map((key) => requestResult(puzzles.delete(key))));
    await requestResult(transaction.objectStore(BOOKS).delete(bookKey));

    if (bookList.length === 0) {
      const book = await insertBook(transaction, initialBook());
      const { key, id, name } = book;
      return { bookList: [{ key, id, name }], book };
    }
    const summary = bookList[Math.min(index, bookList.length - 1)];
    return { bookList, book: { ...summary, puzzles: await readBookPuzzles(transaction, summary.key) } };
  });
}

export function loadBackup(): Promise<Backup> {
  return transact(LIBRARY, 'readonly', async (transaction) => {
    const [summaries, records] = await Promise.all([
      readBookSummaries(transaction),
      requestResult<SavedPuzzle[]>(transaction.objectStore(PUZZLES).getAll()),
    ]);
    const books = new Map<number, Book>(summaries.map(({ key, id, name }) => [key, { id, name, puzzles: [] }]));
    for (const { bookKey, puzzle } of records) books.get(bookKey)?.puzzles.push(puzzle);
    return exportBackup([...books.values()]);
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
  if (!backup.books.every((book) => book && typeof book.id === 'string' && typeof book.name === 'string' && Array.isArray(book.puzzles) && book.puzzles.every(validatePuzzle))) {
    throw new Error('問題データに不正な値があります。');
  }
  return backup.books;
}

export function newImportBooks(imported: Book[], existingPuzzleIds: ReadonlySet<string>): Book[] {
  const additions = new Map<string, Book>();
  const puzzleIds = new Set(existingPuzzleIds);
  for (const book of imported) {
    const newPuzzles = book.puzzles.filter((puzzle) => {
      if (puzzleIds.has(puzzle.id)) return false;
      puzzleIds.add(puzzle.id);
      return true;
    });
    if (!newPuzzles.length) continue;
    const existing = additions.get(book.id);
    if (existing) existing.puzzles = existing.puzzles.concat(newPuzzles);
    else additions.set(book.id, { ...book, puzzles: newPuzzles });
  }
  return [...additions.values()];
}

export function importBooks(imported: Book[], openedBookKey: number): Promise<{
  bookList: BookSummary[]; openedBookAdditions: SavedPuzzle[]; addedBooks: number; addedPuzzles: number;
}> {
  return transact(LIBRARY, 'readwrite', async (transaction) => {
    const index = transaction.objectStore(PUZZLES).index(BY_PUZZLE_ID);
    const ids = new Set(imported.flatMap((book) => book.puzzles.map(({ id }) => id)));
    const existingIds = new Set<string>();
    const [bookList] = await Promise.all([
      readBookSummaries(transaction),
      Promise.all([...ids].map(async (id) => {
        if (await requestResult(index.getKey(id)) !== undefined) existingIds.add(id);
      })),
    ]);
    const booksById = new Map(bookList.map((book) => [book.id, book]));
    let openedBookAdditions: SavedPuzzle[] = [];
    let addedBooks = 0;
    let addedPuzzles = 0;
    for (const book of newImportBooks(imported, existingIds)) {
      let target = booksById.get(book.id);
      if (!target) {
        target = await insertBookSummary(transaction, book);
        bookList.push(target);
        addedBooks++;
      }
      const bookKey = target.key;
      const puzzles = await Promise.all(book.puzzles.map((puzzle) => insertPuzzle(transaction, bookKey, puzzle)));
      if (bookKey === openedBookKey) openedBookAdditions = puzzles;
      addedPuzzles += puzzles.length;
    }
    return { bookList, openedBookAdditions, addedBooks, addedPuzzles };
  });
}

export function legacyCsvToPuzzle(text: string, title = '取り込み問題'): Puzzle {
  const values = text.trim().split(/\r?\n/).flatMap((row) => row.split(',').map((item) => Number(item.trim())));
  if (!isValidGrid(values)) throw new Error('旧形式は 9 行 × 9 数字の CSV にしてください。');
  const puzzle = makePuzzle(title);
  puzzle.givens = values as Digit[];
  return puzzle;
}
