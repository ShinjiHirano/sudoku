import { describe, expect, it } from 'vitest';
import { blockedByDigit, canPlace, candidates, conflicts, setEntry } from './sudoku';
import { makePuzzle } from './types';

describe('sudoku rules', () => {
  it('marks duplicate values in a row as conflicts', () => {
    const puzzle = makePuzzle();
    puzzle.givens[0] = 5;
    puzzle.entries[1] = 5;
    expect(conflicts(puzzle)).toEqual(new Set([0, 1]));
  });

  it('calculates candidates from row, column and block values', () => {
    const puzzle = makePuzzle();
    puzzle.givens[1] = 1;
    puzzle.givens[9] = 2;
    puzzle.givens[10] = 3;
    expect(candidates(puzzle, 0)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('does not overwrite a given with a player entry', () => {
    const puzzle = makePuzzle();
    puzzle.givens[0] = 7;
    expect(setEntry(puzzle, 0, 1)).toBe(puzzle);
  });

  it('rejects a player entry that conflicts with a peer', () => {
    const puzzle = makePuzzle();
    puzzle.givens[1] = 5;
    expect(canPlace(puzzle, 0, 5)).toBe(false);
    expect(setEntry(puzzle, 0, 5)).toBe(puzzle);
    expect(canPlace(puzzle, 0, 4)).toBe(true);
  });

  it('blocks every peer of the selected digit across the board', () => {
    const puzzle = makePuzzle();
    puzzle.givens[0] = 4;
    puzzle.givens[40] = 4;
    const blocked = blockedByDigit(puzzle, 4);
    expect(blocked).toContain(1); // row of the first 4
    expect(blocked).toContain(36); // column of the second 4
    expect(blocked).toContain(30); // block of the second 4
    expect(blocked).not.toContain(80);
  });
});
