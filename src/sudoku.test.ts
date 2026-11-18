import { describe, expect, it } from 'vitest';
import { blockedByDigit, canPlace, candidates, conflicts, effectiveCandidates, setEntry, setGiven, toggleCandidateExclusion } from './sudoku';
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

  it('removes a manual exclusion from effective candidates without changing rule candidates', () => {
    const puzzle = makePuzzle();
    puzzle.givens[1] = 1;
    const next = toggleCandidateExclusion(puzzle, 0, 2);
    expect(candidates(next, 0)).toContain(2);
    expect(effectiveCandidates(next, 0)).not.toContain(2);
    expect(effectiveCandidates(toggleCandidateExclusion(next, 0, 2), 0)).toContain(2);
  });

  it('clears a cell exclusion when a value is confirmed in that cell', () => {
    const puzzle = makePuzzle();
    const excluded = toggleCandidateExclusion(puzzle, 0, 2);
    const entered = setEntry(excluded, 0, 1);
    expect(entered.entries[0]).toBe(1);
    expect(entered.notes[0]).toBeUndefined();
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

  it('requires clearing a player entry before replacing it', () => {
    const puzzle = makePuzzle();
    puzzle.entries[0] = 2;
    expect(setEntry(puzzle, 0, 7)).toBe(puzzle);
    expect(setEntry(puzzle, 0, 0).entries[0]).toBe(0);
  });

  it('rejects a conflicting given while editing a puzzle', () => {
    const puzzle = makePuzzle();
    puzzle.givens[1] = 8;
    expect(setGiven(puzzle, 0, 8)).toBe(puzzle);
    expect(setGiven(puzzle, 0, 4).givens[0]).toBe(4);
  });

  it('requires clearing a given before replacing it', () => {
    const puzzle = makePuzzle();
    puzzle.givens[0] = 3;
    expect(setGiven(puzzle, 0, 7)).toBe(puzzle);
    expect(setGiven(puzzle, 0, 0).givens[0]).toBe(0);
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
