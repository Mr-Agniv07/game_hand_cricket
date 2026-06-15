import { useState, useEffect } from 'react';
import type { AppSocket } from '../socket';
import styles from './TossScreen.module.css';
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
      <div className={`card ${styles['toss-card']}`}>
        <h2>Coin Toss</h2>

        {!tossResult && (
          <>
            <div className={`${styles.coin}${flipping ? ` ${styles.flipping}` : ''}`}>{flipping ? '🪙' : '🪙'}</div>

            {isCaller ? (
              <>
                <p className={styles['toss-prompt']}>
                  {isAutoPlay ? '🤖 Computer is calling the toss…' : 'You get to call the toss!'}
                </p>
                {!isAutoPlay && (
                  <div className={styles['toss-choices']}>
                    <button
                      className={`${styles['toss-btn']} ${styles.heads}`}
                      onClick={() => handleCall('heads')}
                      disabled={flipping}
                    >
                      HEADS
                    </button>
                    <button
                      className={`${styles['toss-btn']} ${styles.tails}`}
                      onClick={() => handleCall('tails')}
                      disabled={flipping}
                    >
                      TAILS
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className={styles['toss-prompt']}>
                <strong>{tossInfo.callerName}</strong> is calling the toss…
              </p>
            )}
          </>
        )}

        {tossResult && (
          <div className={styles['toss-result']}>
            <p>
              Called: <strong>{tossResult.call.toUpperCase()}</strong>
            </p>
            <p className={styles['coin-result']}>
              {tossResult.result === 'heads' ? '🟡 HEADS' : '⚪ TAILS'}
            </p>
            <p className={styles['toss-winner']}>
              {tossResult.winnerId === myId
                ? '🎉 You won the toss!'
                : `${tossResult.winnerName} won the toss!`}
            </p>
            <p className={styles['toss-sub']}>Waiting for toss winner to choose…</p>
          </div>
        )}
      </div>
    </div>
  );
}
