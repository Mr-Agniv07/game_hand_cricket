import { useState, useEffect } from 'react';
import type { AppSocket } from '../socket';
import type { GameState, BatBowlChoice } from '@cric/types';
import './BatBowlScreen.css';

interface BatBowlScreenProps {
  socket: AppSocket;
  myId: string | null;
  gameState: GameState | null;
  isAutoPlay: boolean;
}

export default function BatBowlScreen({ socket, myId, gameState, isAutoPlay }: BatBowlScreenProps) {
  const isChooser = myId === gameState?.tossWinnerId;
  const [hasChosen, setHasChosen] = useState(false);

  function choose(choice: BatBowlChoice) {
    socket.emit('bat_bowl_choice', { choice });
  }

  useEffect(() => {
    if (!isAutoPlay || !isChooser || hasChosen) return;
    const t = setTimeout(() => {
      const choice: BatBowlChoice = Math.random() < 0.5 ? 'bat' : 'bowl';
      choose(choice);
      setHasChosen(true);
    }, 700);
    return () => clearTimeout(t);
  }, [isAutoPlay, isChooser, hasChosen]);

  return (
    <div className="center-screen">
      <div className="card bat-bowl-card">
        <h2>Choose Your Role</h2>
        {isChooser ? (
          <>
            {isAutoPlay ? (
              <p className="waiting-text">🤖 Computer is choosing bat or bowl…</p>
            ) : (
              <>
                <p>You won the toss. What do you want to do?</p>
                <div className="bat-bowl-choices">
                  <button className="choice-btn bat" onClick={() => choose('bat')}>
                    🏏 BAT
                  </button>
                  <button className="choice-btn bowl" onClick={() => choose('bowl')}>
                    🎳 BOWL
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <p className="waiting-text">Waiting for the toss winner to choose bat or bowl…</p>
        )}
      </div>
    </div>
  );
}
