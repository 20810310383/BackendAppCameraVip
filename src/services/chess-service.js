import { Chess } from 'chess.js';

export const INITIAL_FEN = new Chess().fen();

export function applyChessMove(fen, { from, to, promotion = 'q' }) {
  const chess = new Chess(fen);
  const move = chess.move({ from, to, promotion });

  const isCheckmate = chess.isCheckmate();
  const isDraw = chess.isDraw();
  const isStalemate = chess.isStalemate();
  const isThreefold = typeof chess.isThreefoldRepetition === 'function' ? chess.isThreefoldRepetition() : false;
  const isInsufficient = typeof chess.isInsufficientMaterial === 'function' ? chess.isInsufficientMaterial() : false;
  const gameOver = chess.isGameOver();

  let endReason = null;
  let winner = null;
  let loser = null;

  if (gameOver) {
    if (isCheckmate) {
      endReason = 'checkmate';
      loser = chess.turn(); // The side whose turn it is got checkmated
      winner = loser === 'w' ? 'b' : 'w';
    } else if (isStalemate) {
      endReason = 'stalemate';
    } else if (isThreefold) {
      endReason = 'threefold_repetition';
    } else if (isInsufficient) {
      endReason = 'insufficient_material';
    } else if (isDraw) {
      endReason = 'draw';
    }
  }

  return {
    move: {
      from: move.from,
      to: move.to,
      san: move.san,
      captured: move.captured,
      promotion: move.promotion,
    },
    fen: chess.fen(),
    turn: chess.turn(),
    isGameOver: gameOver,
    isCheckmate,
    isDraw,
    isStalemate,
    winner,
    loser,
    endReason,
  };
}

export function sideToMove(fen) {
  return new Chess(fen).turn();
}

