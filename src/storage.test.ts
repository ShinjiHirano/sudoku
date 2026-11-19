import { describe, expect, it } from 'vitest';
import { addImportedBooks, exportBackup, parseBackup } from './storage';
import { makeBook, makePuzzle } from './types';

describe('JSON import', () => {
  it('appends new books and puzzles while preserving local names and progress', () => {
    const started = makePuzzle('端末で編集中');
    started.entries[0] = 3;
    started.notes[1] = [4];
    const local = { ...makeBook('端末で変更した名前'), puzzles: [started] };
    const untouched = { ...makeBook(), puzzles: [makePuzzle()] };
    const newPuzzle = makePuzzle();
    const newBook = { ...makeBook('追加する問題集'), puzzles: [makePuzzle()] };
    const imported = parseBackup(JSON.stringify(exportBackup([
      { ...local, name: '以前の名前', puzzles: [{ ...makePuzzle('以前の問題名'), id: started.id }, newPuzzle] },
      newBook,
    ])));

    const result = addImportedBooks([local, untouched], imported);

    expect(result).toEqual({
      books: [{ ...local, puzzles: [started, newPuzzle] }, untouched, newBook],
      addedBooks: 1,
      addedPuzzles: 2,
    });
    expect(result.books[0].puzzles[0]).toBe(started);
    expect(local.puzzles).toEqual([started]);
  });

  it('skips duplicate puzzle IDs and books that would be empty, including on retry', () => {
    const puzzle = makePuzzle();
    const book = { ...makeBook(), puzzles: [puzzle, { ...puzzle }] };
    const morePuzzles = { ...book, puzzles: [makePuzzle()] };
    const imported = [book, { ...makeBook(), puzzles: [puzzle] }, morePuzzles, makeBook()];

    const result = addImportedBooks([], imported);

    expect(result).toEqual({
      books: [{ ...book, puzzles: [puzzle, ...morePuzzles.puzzles] }],
      addedBooks: 1,
      addedPuzzles: 2,
    });
    expect(addImportedBooks(result.books, imported)).toEqual({ books: result.books, addedBooks: 0, addedPuzzles: 0 });
  });
});
