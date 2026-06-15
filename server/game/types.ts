export interface SocketData {
  userId: string | null;
  // Stable per-browser id from the handshake, present for guests too. Lets a
  // guest reconnect to their room (they have no userId to match on).
  clientId: string | null;
  roomId?: string;
  playerName?: string;
  tournamentId?: string;
}
