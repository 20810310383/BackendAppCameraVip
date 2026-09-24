import { createRequire } from 'node:module';
import { Chess } from 'chess.js';

const require = createRequire(import.meta.url);
const createStockfish = require('stockfish');
const MOVE_TIME_MS = 1_200;
const ENGINE_TIMEOUT_MS = 45_000;

let enginePromise;
let searchQueue = Promise.resolve();

function createLineWaiter(engine, command, matcher, timeoutMs = ENGINE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      engine.waiters = engine.waiters.filter((waiter) => waiter !== waiterEntry);
      try {
        engine.sendCommand('stop');
      } catch {
        // The original timeout is still the useful error if the engine cannot be stopped.
      }
      reject(new Error('Stockfish mất quá nhiều thời gian để trả lời.'));
    }, timeoutMs);

    const waiterEntry = {
      matcher,
      resolve: (line) => {
        clearTimeout(timeout);
        resolve(line);
      },
    };
    engine.waiters.push(waiterEntry);
    engine.sendCommand(command);
  });
}

async function getEngine() {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const engine = await createStockfish('full');
    engine.waiters = [];
    engine.listener = (line) => {
      const waiterIndex = engine.waiters.findIndex((waiter) => waiter.matcher(line));
      if (waiterIndex < 0) return;
      const [waiter] = engine.waiters.splice(waiterIndex, 1);
      waiter.resolve(line);
    };

    await createLineWaiter(engine, 'uci', (line) => line === 'uciok');
    engine.sendCommand('setoption name Threads value 4');
    engine.sendCommand('setoption name Hash value 256');
    engine.sendCommand('setoption name Skill Level value 20');
    engine.sendCommand('setoption name UCI_LimitStrength value false');
    await createLineWaiter(engine, 'isready', (line) => line === 'readyok');
    return engine;
  })().catch((error) => {
    enginePromise = undefined;
    throw error;
  });

  return enginePromise;
}

async function findBestMove(fen) {
  const chess = new Chess(fen);
  if (chess.isGameOver()) return null;

  const engine = await getEngine();
  engine.sendCommand('ucinewgame');
  engine.sendCommand(`position fen ${fen}`);
  const line = await createLineWaiter(engine, `go movetime ${MOVE_TIME_MS}`, (output) => output.startsWith('bestmove '));
  const [, uciMove] = line.split(/\s+/);

  if (!uciMove || uciMove === '(none)') {
    throw new Error('Stockfish không tìm được nước đi hợp lệ.');
  }

  const move = chess.move({
    from: uciMove.slice(0, 2),
    to: uciMove.slice(2, 4),
    promotion: uciMove[4],
  });

  if (!move) throw new Error('Stockfish trả về một nước đi không hợp lệ.');

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
    isGameOver: chess.isGameOver(),
    isCheckmate: chess.isCheckmate(),
  };
}

export function getStockfishMove(fen) {
  const task = searchQueue.then(() => findBestMove(fen));
  searchQueue = task.catch(() => undefined);
  return task;
}

export function warmStockfish() {
  return getEngine();
}

export const STOCKFISH_SETTINGS = {
  name: 'Stockfish 19',
  difficulty: 'max',
  timePerMoveMs: MOVE_TIME_MS,
};
