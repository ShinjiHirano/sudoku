import './style.css';
import { cropGrid, recognizeGrid, type GridCrop } from './ocr';
import { googleDriveReady, saveToDrive } from './drive';
import { blockedByDigit, boardValue, canPlace, candidates, conflicts, isComplete, peerIndexes, setEntry, setGiven, toggleNote } from './sudoku';
import { exportBackup, initialBooks, legacyCsvToPuzzle, loadBooks, parseBackup, saveBooks } from './storage';
import { makeBook, makePuzzle, type Book, type Digit, type Puzzle } from './types';

type Mode = 'play' | 'edit' | 'scan';
const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('表示領域を初期化できません。');
const app: HTMLDivElement = appElement;

let books: Book[] = [];
let activeBookId = '';
let activePuzzleId = '';
let mode: Mode = 'play';
let menuOpen = false;
let selected = 0;
let paletteSelected: Digit | null = null;
let noteMode = false;
let undoStack: Puzzle[] = [];
let redoStack: Puzzle[] = [];
let notice = '';
let reviewCells = new Set<number>();
let scanImage: HTMLImageElement | null = null;
let scanImageUrl = '';
let scanProgress = '';
let scanCrop: GridCrop = { left: 0, top: 0, right: 1, bottom: 1 };

function activeBook(): Book {
  return books.find((book) => book.id === activeBookId) ?? books[0];
}

function activePuzzle(): Puzzle {
  return activeBook().puzzles.find((puzzle) => puzzle.id === activePuzzleId) ?? activeBook().puzzles[0];
}

function clonePuzzle(puzzle: Puzzle): Puzzle {
  return structuredClone(puzzle);
}

async function persist(): Promise<void> {
  await saveBooks(books);
}

function replacePuzzle(next: Puzzle, recordHistory = true): void {
  const book = activeBook();
  const index = book.puzzles.findIndex((puzzle) => puzzle.id === next.id);
  if (index < 0) return;
  if (recordHistory) {
    undoStack.push(clonePuzzle(book.puzzles[index]));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }
  book.puzzles[index] = next;
  void persist();
}

function setNotice(message: string): void {
  notice = message;
  render();
}

function digit(index: number, value: Digit): void {
  const puzzle = activePuzzle();
  paletteSelected = value || null;
  if (value !== 0 && boardValue(puzzle, index) !== 0) {
    // A filled cell is a filter source. Clear it before entering a replacement.
    render();
    return;
  }
  if ((mode === 'play' || mode === 'edit') && !noteMode && value !== 0 && !canPlace(puzzle, index, value)) {
    selected = index;
    setNotice(`${value} は、このマスには置けません。`);
    return;
  }
  const next = mode === 'edit' ? setGiven(puzzle, index, value) : noteMode ? toggleNote(puzzle, index, value) : setEntry(puzzle, index, value);
  if (next !== puzzle) replacePuzzle(next);
  selected = index;
  reviewCells.delete(index);
  render();
}

function undo(): void {
  const puzzle = activePuzzle();
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(clonePuzzle(puzzle));
  replacePuzzle(previous, false);
  render();
}

function redo(): void {
  const puzzle = activePuzzle();
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(clonePuzzle(puzzle));
  replacePuzzle(next, false);
  render();
}

function boardCell(index: number, puzzle: Puzzle, conflictSet: Set<number>, blockedCells: Set<number>, selectedValue: Digit): string {
  const value = puzzle.givens[index] || puzzle.entries[index];
  const sameNumber = Boolean(value && value === selectedValue);
  const occupiedOtherNumber = Boolean(selectedValue && value && !sameNumber);
  const related = selectedValue ? blockedCells.has(index) && !sameNumber : peerIndexes(selected).includes(index);
  const classNames = [
    'cell', index === selected ? 'is-selected' : '', related ? 'is-related' : '', occupiedOtherNumber ? 'is-occupied' : '', sameNumber ? 'is-same' : '',
    conflictSet.has(index) ? 'is-conflict' : '', reviewCells.has(index) ? 'needs-review' : '',
    puzzle.givens[index] ? 'is-given' : '',
  ].filter(Boolean).join(' ');
  const noteValues = puzzle.notes[index] ?? (noteMode ? candidates(puzzle, index) : []);
  const content = value ? String(value) : noteValues.map((item) => `<span>${item}</span>`).join('');
  return `<button class="${classNames}" data-cell="${index}" aria-label="${Math.floor(index / 9) + 1}行 ${index % 9 + 1}列${value ? `、${value}` : '、空欄'}">${value ? content : `<i class="notes">${content}</i>`}</button>`;
}

function scanPane(): string {
  const cropStyle = `left:${scanCrop.left * 100}%;top:${scanCrop.top * 100}%;right:${(1 - scanCrop.right) * 100}%;bottom:${(1 - scanCrop.bottom) * 100}%;`;
  return `<section class="panel scan-panel">
    <div class="screen-actions"><button id="scan-cancel">‹ プレイに戻る</button></div>
    <div><p class="eyebrow">写真から問題を登録</p><h2>画像を選ぶ</h2><p>数独の外枠を切り出してください。まっすぐ正面から撮影した画像ほど認識しやすくなります。画像は端末内で処理され、外部へ送信されません。</p></div>
    <label class="file-button">カメラ／画像を選択<input id="scan-file" type="file" accept="image/*" capture="environment"></label>
    ${scanImage ? `<div class="scan-image"><img id="scan-source" src="${scanImageUrl}" alt="選択した数独の画像"><div class="crop-box" style="${cropStyle}"></div></div><div class="crop-controls"><label>左 <input data-crop="left" type="range" min="0" max="80" value="${Math.round(scanCrop.left * 100)}"></label><label>上 <input data-crop="top" type="range" min="0" max="80" value="${Math.round(scanCrop.top * 100)}"></label><label>右 <input data-crop="right" type="range" min="20" max="100" value="${Math.round(scanCrop.right * 100)}"></label><label>下 <input data-crop="bottom" type="range" min="20" max="100" value="${Math.round(scanCrop.bottom * 100)}"></label></div><button id="run-ocr" class="primary" ${scanProgress ? 'disabled' : ''}>${scanProgress || 'OCR を実行して編集画面へ'}</button><p class="hint">OCR は印刷状態によって誤認識します。続く編集画面で必ず確認・修正してください。</p>` : ''}
  </section>`;
}

function utilityMenu(book: Book, puzzle: Puzzle): string {
  return `<section class="utility-menu" aria-label="メニュー">
    <div class="utility-menu-header"><strong>メニュー</strong><button id="menu-close" aria-label="メニューを閉じる">×</button></div>
    <section><p class="menu-label">問題</p><label>問題集<select id="book-select">${books.map((item) => `<option value="${item.id}" ${item.id === book.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>問題<select id="puzzle-select">${book.puzzles.map((item, index) => `<option value="${item.id}" ${item.id === puzzle.id ? 'selected' : ''}>${index + 1}. ${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="menu-actions"><button id="new-puzzle">＋ 問題</button><button id="new-book">＋ 問題集</button></div></section>
    <section><p class="menu-label">プレイ</p><div class="menu-actions"><button id="notes-toggle" class="${noteMode ? 'active' : ''}">候補メモ ${noteMode ? 'ON' : 'OFF'}</button><button id="undo" ${undoStack.length ? '' : 'disabled'}>↶ Undo</button><button id="redo" ${redoStack.length ? '' : 'disabled'}>Redo ↷</button><button id="clear-entries">入力を消去</button></div></section>
    <section><p class="menu-label">問題を作る</p><label>問題名<input id="title-input" value="${escapeHtml(puzzle.title)}"></label><div class="menu-actions"><button id="edit-start">問題を編集</button><button id="scan-toggle">▣ 写真から取込</button></div></section>
    <details><summary>バックアップとデータ</summary><div class="menu-actions details-actions"><button id="export">JSON を書き出す</button><label class="file-button">JSON を読み込む<input id="import-file" type="file" accept="application/json,.json,.csv,text/csv"></label><button id="drive-save" ${googleDriveReady() ? '' : 'disabled'}>Google Drive に保存</button></div>${googleDriveReady() ? '' : '<p class="hint">Drive は public/config.js に OAuth Client ID を設定すると有効になります。</p>'}</details>
  </section>`;
}

function render(): void {
  const book = activeBook();
  const puzzle = activePuzzle();
  const conflictSet = conflicts(puzzle);
  const complete = isComplete(puzzle);
  const noticeText = notice || (complete ? '完成です！' : '');
  const filterDigit = paletteSelected ?? boardValue(puzzle, selected);
  const blockedCells = blockedByDigit(puzzle, filterDigit);
  const board = Array.from({ length: 81 }, (_, index) => boardCell(index, puzzle, conflictSet, blockedCells, filterDigit)).join('');
  app.innerHTML = `<header class="play-header"><div><p class="eyebrow">OFFLINE SUDOKU NOTE</p><h1>数独ノート</h1></div><button id="menu-toggle" class="menu-toggle" aria-expanded="${menuOpen}" aria-label="メニューを開く">☰</button></header>
  <p class="notice ${noticeText ? 'is-visible' : 'is-empty'}" role="status">${noticeText || '　'}</p>
  ${menuOpen ? utilityMenu(book, puzzle) : ''}
  ${mode === 'scan' ? scanPane() : `<section class="play-layout"><section class="board-area">
    ${mode === 'edit' ? `<div class="edit-banner"><span>問題を編集しています</span><button id="finish-edit">完了</button></div>` : ''}
    ${reviewCells.size ? `<p class="review">要確認: ${reviewCells.size} マス</p>` : ''}
    <div class="board" role="grid">${board}</div>
    <div class="keypad" aria-label="数字パレット">${[1,2,3,4,5,6,7,8,9].map((value) => `<button class="${paletteSelected === value ? 'is-palette-selected' : ''}" data-digit="${value}" aria-label="数字 ${value}" aria-pressed="${paletteSelected === value}">${value}</button>`).join('')}<button class="erase" data-digit="0" aria-pressed="false">消去</button></div>
  </section></section>`}`;
  bindEvents();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function downloadBackup(): void {
  const file = new Blob([JSON.stringify(exportBackup(books), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = `sudoku-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  URL.revokeObjectURL(url);
  setNotice('JSON を書き出しました。');
}

async function importFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith('.csv')) {
      const book = activeBook();
      const puzzle = legacyCsvToPuzzle(text, file.name.replace(/\.csv$/i, ''));
      book.puzzles.push(puzzle); activePuzzleId = puzzle.id;
    } else {
      const imported = parseBackup(text);
      books = imported; activeBookId = books[0]?.id ?? ''; activePuzzleId = books[0]?.puzzles[0]?.id ?? '';
    }
    await persist(); setNotice('問題を読み込みました。'); render();
  } catch (error) { setNotice(error instanceof Error ? error.message : '読み込みに失敗しました。'); }
}

function loadScan(file: File): void {
  if (scanImageUrl) URL.revokeObjectURL(scanImageUrl);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => { scanImage = image; scanImageUrl = url; scanCrop = { left: 0, top: 0, right: 1, bottom: 1 }; scanProgress = ''; render(); };
  image.onerror = () => setNotice('画像を開けませんでした。');
  image.src = url;
}

async function runOcr(): Promise<void> {
  if (!scanImage) return;
  scanProgress = 'OCR を準備中…'; render();
  try {
    const cropped = cropGrid(scanImage, scanCrop);
    const result = await recognizeGrid(cropped, cropped.width, cropped.height, (done, total) => { scanProgress = `認識中 ${done}/${total}`; const button = document.querySelector('#run-ocr'); if (button) button.textContent = scanProgress; });
    const puzzle = activePuzzle();
    const next = { ...puzzle, givens: result.values, entries: Array<Digit>(81).fill(0), notes: {}, updatedAt: new Date().toISOString() };
    replacePuzzle(next); reviewCells = new Set(result.confidence.map((value, index) => value < 75 ? index : -1).filter((index) => index >= 0));
    mode = 'edit'; scanImage = null; URL.revokeObjectURL(scanImageUrl); scanImageUrl = ''; scanProgress = ''; setNotice('OCR 結果を編集画面で確認してください。黄色のマスは低確信度です。'); render();
  } catch (error) { scanProgress = ''; setNotice(error instanceof Error ? error.message : 'OCR に失敗しました。'); }
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-cell]').forEach((button) => button.addEventListener('click', () => {
    selected = Number(button.dataset.cell);
    const value = boardValue(activePuzzle(), selected);
    if (value) paletteSelected = value;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-digit]').forEach((button) => button.addEventListener('click', () => digit(selected, Number(button.dataset.digit) as Digit)));
  document.querySelector('#menu-toggle')?.addEventListener('click', () => { menuOpen = !menuOpen; render(); });
  document.querySelector('#menu-close')?.addEventListener('click', () => { menuOpen = false; render(); });
  document.querySelector<HTMLSelectElement>('#book-select')?.addEventListener('change', (event) => { activeBookId = (event.target as HTMLSelectElement).value; activePuzzleId = activeBook().puzzles[0]?.id ?? ''; undoStack = []; redoStack = []; render(); });
  document.querySelector<HTMLSelectElement>('#puzzle-select')?.addEventListener('change', (event) => { activePuzzleId = (event.target as HTMLSelectElement).value; undoStack = []; redoStack = []; render(); });
  document.querySelector('#notes-toggle')?.addEventListener('click', () => { noteMode = !noteMode; render(); });
  document.querySelector('#undo')?.addEventListener('click', undo); document.querySelector('#redo')?.addEventListener('click', redo);
  document.querySelector('#new-puzzle')?.addEventListener('click', () => { const puzzle = makePuzzle(`問題 ${activeBook().puzzles.length + 1}`); activeBook().puzzles.push(puzzle); activePuzzleId = puzzle.id; void persist(); render(); });
  document.querySelector('#new-book')?.addEventListener('click', () => { const name = window.prompt('問題集名', '新しい問題集'); if (!name) return; const book = makeBook(name); const puzzle = makePuzzle('問題 1'); book.puzzles.push(puzzle); books.push(book); activeBookId = book.id; activePuzzleId = puzzle.id; void persist(); render(); });
  document.querySelector('#edit-start')?.addEventListener('click', () => { mode = 'edit'; noteMode = false; menuOpen = false; render(); });
  document.querySelector('#finish-edit')?.addEventListener('click', () => { mode = 'play'; menuOpen = false; render(); });
  document.querySelector('#scan-toggle')?.addEventListener('click', () => { mode = 'scan'; menuOpen = false; render(); });
  document.querySelector('#scan-cancel')?.addEventListener('click', () => { mode = 'play'; render(); });
  document.querySelector('#clear-entries')?.addEventListener('click', () => { if (!window.confirm('プレイヤー入力と候補メモを消去しますか？')) return; const puzzle = activePuzzle(); replacePuzzle({ ...puzzle, entries: Array<Digit>(81).fill(0), notes: {} }); render(); });
  document.querySelector<HTMLInputElement>('#title-input')?.addEventListener('change', (event) => { const puzzle = activePuzzle(); replacePuzzle({ ...puzzle, title: (event.target as HTMLInputElement).value.trim() || '無題の問題' }); render(); });
  document.querySelector('#export')?.addEventListener('click', downloadBackup);
  document.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void importFile(file); });
  document.querySelector('#drive-save')?.addEventListener('click', async () => { try { await saveToDrive(exportBackup(books)); setNotice('Google Drive に新しいバックアップを保存しました。'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Google Drive への保存に失敗しました。'); } });
  document.querySelector<HTMLInputElement>('#scan-file')?.addEventListener('change', (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) loadScan(file); });
  document.querySelectorAll<HTMLInputElement>('[data-crop]').forEach((input) => input.addEventListener('input', () => { const key = input.dataset.crop as keyof GridCrop; const proposed = Number(input.value) / 100; const next = { ...scanCrop, [key]: proposed }; if (next.right - next.left >= .2 && next.bottom - next.top >= .2) { scanCrop = next; render(); } }));
  document.querySelector('#run-ocr')?.addEventListener('click', () => void runOcr());
}

window.addEventListener('keydown', (event) => {
  if (mode === 'scan' || (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) return;
  if (/^[1-9]$/.test(event.key)) digit(selected, Number(event.key) as Digit);
  else if (event.key === 'Backspace' || event.key === 'Delete') digit(selected, 0);
  else if (event.key === 'ArrowUp') { selected = Math.max(0, selected - 9); render(); }
  else if (event.key === 'ArrowDown') { selected = Math.min(80, selected + 9); render(); }
  else if (event.key === 'ArrowLeft') { selected = Math.max(0, selected - 1); render(); }
  else if (event.key === 'ArrowRight') { selected = Math.min(80, selected + 1); render(); }
});

async function start(): Promise<void> {
  try { books = await loadBooks(); } catch { notice = '端末内ストレージを利用できません。'; }
  if (!books.length) { books = initialBooks(); await persist(); }
  activeBookId = books[0].id; activePuzzleId = books[0].puzzles[0].id; render();
}

void start();
