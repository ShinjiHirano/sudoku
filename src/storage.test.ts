import { describe, expect, it } from 'vitest';
import { exportBackup, newImportBooks, parseBackup } from './storage';
import { makeBook, makePuzzle } from './types';

describe('JSON import', () => {
  it('selects only new puzzles for an import, including additions to an existing book', () => {
    const started = makePuzzle('端末で編集中');
    started.entries[0] = 3;
    started.notes[1] = [4];
    const local = { ...makeBook('端末で変更した名前'), puzzles: [started] };
    const newPuzzle = makePuzzle();
    const newBook = { ...makeBook('追加する問題集'), puzzles: [makePuzzle()] };
    const imported = parseBackup(JSON.stringify(exportBackup([
      { ...local, name: '以前の名前', puzzles: [{ ...makePuzzle('以前の問題名'), id: started.id }, newPuzzle] },
      newBook,
    ])));

    const additions = newImportBooks(imported, new Set([started.id]));

    expect(additions).toEqual([{ ...imported[0], puzzles: [newPuzzle] }, newBook]);
    expect(imported[0].puzzles).toHaveLength(2);
  });

  it('skips duplicate puzzle IDs and books that would be empty, including on retry', () => {
    const puzzle = makePuzzle();
    const book = { ...makeBook(), puzzles: [puzzle, { ...puzzle }] };
    const morePuzzles = { ...book, puzzles: [makePuzzle()] };
    const imported = [book, { ...makeBook(), puzzles: [puzzle] }, morePuzzles, makeBook()];

    const additions = newImportBooks(imported, new Set());

    expect(additions).toEqual([{ ...book, puzzles: [puzzle, ...morePuzzles.puzzles] }]);
    const importedIds = new Set(additions[0].puzzles.map(({ id }) => id));
    expect(newImportBooks(imported, importedIds)).toEqual([]);
  });
});
