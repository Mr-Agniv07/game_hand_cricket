import type { AppSocket } from '../socket';
import type { GameState, BatBowlChoice } from '@cric/types';
import './BatBowlScreen.css';

interface BatBowlScreenProps {
  socket: AppSocket;
  myId: string | null;
  gameState: GameState | null;
}

export default function BatBowlScreen({ socket, myId, gameState }: BatBowlScreenProps) {
  const isChooser = myId === gameState?.tossWinnerId;

  function choose(choice: BatBowlChoice) {
    socket.emit('bat_bowl_choice', { choice });
  }

  return (
    <div className="center-screen">
      <div className="card bat-bowl-card">
        <h2>Choose Your Role</h2>
        {isChooser ? (
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
        ) : (
          <p className="waiting-text">
            Waiting for the toss winner to choose bat or bowl…
          </p>
        )}
      </div>
    </div>
  );
}
