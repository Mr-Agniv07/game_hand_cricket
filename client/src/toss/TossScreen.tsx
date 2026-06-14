import { useState, useEffect } from 'react';
import type { AppSocket } from '../socket';
import './TossScreen.css';
import type { TossStartPayload, TossResultPayload, TossCall } from '@cric/types';

interface TossScreenProps {
  socket: AppSocket;
  myId: string | null;
  tossInfo: TossStartPayload;
  tossResult: TossResultPayload | null;
  isAutoPlay: boolean;
}

export default function TossScreen({
  socket,
  myId,
  tossInfo,
  tossResult,
  isAutoPlay,
}: TossScreenProps) {
  const [flipping, setFlipping] = useState(false);
  const isCaller = myId === tossInfo?.callerId;

  function handleCall(call: TossCall) {
    setFlipping(true);
    socket.emit('toss_call', { call });
  }

  useEffect(() => {
    if (!isAutoPlay || !isCaller || flipping || tossResult) return;
    const t = setTimeout(() => {
      handleCall(Math.random() < 0.5 ? 'heads' : 'tails');
    }, 700);
    return () => clearTimeout(t);
  }, [isAutoPlay, isCaller, flipping, tossResult]);

  return (
    <div className="center-screen">
      <div className="card toss-card">
        <h2>Coin Toss</h2>

        {!tossResult && (
          <>
            <div className={`coin ${flipping ? 'flipping' : ''}`}>{flipping ? '🪙' : '🪙'}</div>

            {isCaller ? (
              <>
                <p className="toss-prompt">
                  {isAutoPlay ? '🤖 Computer is calling the toss…' : 'You get to call the toss!'}
                </p>
                {!isAutoPlay && (
                  <div className="toss-choices">
                    <button
                      className="toss-btn heads"
                      onClick={() => handleCall('heads')}
                      disabled={flipping}
                    >
                      HEADS
                    </button>
                    <button
                      className="toss-btn tails"
                      onClick={() => handleCall('tails')}
                      disabled={flipping}
                    >
                      TAILS
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="toss-prompt">
                <strong>{tossInfo.callerName}</strong> is calling the toss…
              </p>
            )}
          </>
        )}

        {tossResult && (
          <div className="toss-result">
            <p>
              Called: <strong>{tossResult.call.toUpperCase()}</strong>
            </p>
            <p className={`coin-result ${tossResult.result}`}>
              {tossResult.result === 'heads' ? '🟡 HEADS' : '⚪ TAILS'}
            </p>
            <p className="toss-winner">
              {tossResult.winnerId === myId
                ? '🎉 You won the toss!'
                : `${tossResult.winnerName} won the toss!`}
            </p>
            <p className="toss-sub">Waiting for toss winner to choose…</p>
          </div>
        )}
      </div>
    </div>
  );
}
